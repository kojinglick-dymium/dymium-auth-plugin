import fs from "fs"
import path from "path"
import os from "os"
import http from "http"
import https from "https"

// Path to the auth.json file
const AUTH_JSON_PATH = path.join(os.homedir(), ".local/share/opencode/auth.json")

// Log file for debugging (no console.log to avoid polluting OpenCode UI)
const LOG_FILE = path.join(os.homedir(), ".local/share/dymium-opencode-plugin/debug.log")

function log(message: string) {
  const timestamp = new Date().toISOString()
  const line = `${timestamp} ${message}\n`
  // Only write to file, not console (console output appears in OpenCode UI)
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

/**
 * Read the current Dymium token from auth.json
 * This is called on EVERY request to ensure we always have a fresh token
 */
function getDymiumToken(): string | null {
  try {
    if (!fs.existsSync(AUTH_JSON_PATH)) {
      log(`auth.json not found at ${AUTH_JSON_PATH}`)
      return null
    }
    
    const content = fs.readFileSync(AUTH_JSON_PATH, "utf-8")
    const auth = JSON.parse(content)
    
    if (auth.dymium?.key) {
      return auth.dymium.key
    }
    
    log("No dymium.key found in auth.json")
    return null
  } catch (error) {
    log(`Failed to read auth.json: ${error}`)
    return null
  }
}

/**
 * Make an HTTP/1.1 request using Node's http module
 * This avoids HTTP/2 issues with kubectl port-forward
 * 
 * IMPORTANT: For Istio Gateway routing through port-forward:
 * - Use hostname without port in Host header (Istio VirtualService matches on hostname only)
 * - Use Connection: close to avoid keep-alive issues
 * - Ensure proper Content-Length for POST requests
 */
function http11Request(
  url: URL,
  options: {
    method: string
    headers: Record<string, string>
    body?: string
  }
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:"
    const lib = isHttps ? https : http
    
    // For Istio, the Host header should be just the hostname (without port)
    // because VirtualService typically matches on hostname only
    const hostHeader = url.hostname
    
    const reqOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method,
      headers: {
        ...options.headers,
        // Use hostname only for Host header (Istio best practice)
        "Host": hostHeader,
        // Prevent keep-alive issues with port-forward
        "Connection": "close",
      },
    }
    
    // Add Content-Length for requests with body
    if (options.body) {
      reqOptions.headers!["Content-Length"] = Buffer.byteLength(options.body).toString()
    }
    
    log(`HTTP/1.1 ${options.method} ${url.toString()} Host: ${hostHeader}`)
    
    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = []
      
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const body = Buffer.concat(chunks)
        const responseHeaders = new Headers()
        
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) {
            if (Array.isArray(value)) {
              value.forEach(v => responseHeaders.append(key, v))
            } else {
              responseHeaders.set(key, value)
            }
          }
        }
        
        log(`Response: ${res.statusCode} ${res.statusMessage}`)
        
        // Create a Response object that supports streaming
        resolve(new Response(body, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || "",
          headers: responseHeaders,
        }))
      })
    })
    
    req.on("error", (err) => {
      log(`Request error: ${err.message}`)
      reject(err)
    })
    
    // Set a reasonable timeout
    req.setTimeout(120000, () => {
      log("Request timeout")
      req.destroy(new Error("Request timeout"))
    })
    
    if (options.body) {
      req.write(options.body)
    }
    
    req.end()
  })
}

/**
 * Custom fetch function that injects the fresh Dymium token on every request
 * Uses HTTP/1.1 to avoid issues with kubectl port-forward
 */
async function dymiumFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const token = getDymiumToken()
  
  if (!token) {
    throw new Error("[dymium-auth] No valid Dymium token available. Please ensure the Dymium Provider app is running.")
  }
  
  // Parse the URL
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url)
  
  // Build headers object - start with defaults for OpenAI-compatible API
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  }
  
  // Copy any headers from init
  if (init?.headers) {
    const initHeaders = new Headers(init.headers)
    initHeaders.forEach((value, key) => {
      headers[key] = value
    })
  }
  
  // Set authorization (overwrite any existing)
  headers["Authorization"] = `Bearer ${token}`
  
  // Get body as string if present
  let body: string | undefined
  if (init?.body) {
    if (typeof init.body === "string") {
      body = init.body
    } else if (init.body instanceof ArrayBuffer) {
      body = new TextDecoder().decode(init.body)
    } else if (ArrayBuffer.isView(init.body)) {
      body = new TextDecoder().decode(init.body)
    } else {
      // For other types, try to convert
      body = String(init.body)
    }
  }
  
  // Use HTTP/1.1 request to avoid HTTP/2 issues with port-forward
  return http11Request(url, {
    method: init?.method || "GET",
    headers,
    body,
  })
}

/**
 * OpenCode Plugin Export
 * 
 * This plugin provides authentication for the "dymium" provider.
 * It reads the token fresh from auth.json on every API call,
 * ensuring that token refreshes by the Dymium Provider app are
 * immediately picked up without needing to restart OpenCode.
 * 
 * Uses HTTP/1.1 explicitly to work with kubectl port-forward.
 * Sets Host header to hostname only (without port) for Istio compatibility.
 */
export default async function plugin({ client, project, directory }: any) {
  log(`Plugin initialized for project: ${project?.name || directory}`)
  
  return {
    auth: {
      // Match the provider name exactly
      provider: "dymium",
      
      // Empty methods array - we only use the loader
      methods: [],
      
      /**
       * Loader for the "dymium" provider
       * Called by OpenCode to get auth credentials and custom fetch
       */
      async loader(getAuth: () => Promise<any>, provider: any) {
        log(`Loader called for provider: ${provider?.id || provider}`)
        
        // Return auth info with empty apiKey and custom fetch
        // The custom fetch handles authentication via the token
        return {
          // Empty string - auth is handled in our custom fetch
          apiKey: "",
          
          // Custom fetch that reads token fresh and uses HTTP/1.1
          fetch: dymiumFetch,
        }
      },
    },
  }
}

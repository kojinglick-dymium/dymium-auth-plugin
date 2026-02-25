import fs from "fs"
import path from "path"
import os from "os"

// ============================================================================
// Logging
// ============================================================================

const LOG_DIR = path.join(os.homedir(), ".local/share/dymium-opencode-plugin")
const LOG_FILE = path.join(LOG_DIR, "debug.log")

try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
} catch {}

function log(message: string) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

// ============================================================================
// Token Resolution
// ============================================================================

/** Read the current token from the dymium provider app's token file or auth.json */
function resolveToken(): string | null {
  // Primary: token file written by dymium-provider's token refresh loop
  const tokenPath = path.join(os.homedir(), ".dymium/token")
  try {
    const token = fs.readFileSync(tokenPath, "utf-8").trim()
    if (token) return token
  } catch {}

  // Legacy path used by older local plugin builds
  const legacyTokenPath = path.join(os.homedir(), ".local/share/dymium-provider/token")
  try {
    const token = fs.readFileSync(legacyTokenPath, "utf-8").trim()
    if (token) return token
  } catch {}

  // Fallback: auth.json written by dymium-provider's OpenCodeService
  const authPath = path.join(os.homedir(), ".local/share/opencode/auth.json")
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"))
    const key = auth?.dymium?.key
    if (key && typeof key === "string" && key.trim()) return key.trim()
  } catch {}

  return null
}

function shouldTapReasoning(init?: RequestInit): boolean {
  if (!init?.body || typeof init.body !== "string") return false
  try {
    const body = JSON.parse(init.body)
    return body?.stream === true
  } catch {
    return false
  }
}

function sanitizeReasoning(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 280)
}

function tapReasoningStream(response: Response, url: string): void {
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("text/event-stream")) return

  const clone = response.clone()
  const stream = clone.body
  if (!stream) return

  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue

          const payload = trimmed.slice(5).trim()
          if (!payload || payload === "[DONE]") continue

          try {
            const parsed = JSON.parse(payload)
            const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content
            if (typeof reasoning === "string" && reasoning.trim()) {
              log(`Reasoning(${url}): ${sanitizeReasoning(reasoning)}`)
            }
          } catch {
            // ignore non-JSON data lines
          }
        }
      }
    } catch (e: any) {
      log(`WARN: Reasoning stream tap failed: ${e?.message || String(e)}`)
    } finally {
      try {
        reader.releaseLock()
      } catch {}
    }
  })()
}

// ============================================================================
// Plugin
// ============================================================================

export default async function plugin({ client, project, directory }: any) {
  log(`Plugin initialized for project: ${project?.name || directory}`)

  return {
    // ========================================================================
    // Auth Hook — wraps fetch to inject Bearer token on every request
    // ========================================================================
    auth: {
      provider: "dymium",
      methods: [{ type: "api" as const, label: "Dymium API Key" }],
      async loader(getAuth: () => Promise<any>, provider: any) {
        log("Auth loader called — setting up fetch wrapper")

        // Read initial token for apiKey (OpenCode needs a non-empty apiKey to
        // activate the provider — the real token is injected per-request below)
        const initialToken = resolveToken() || "dymium-pending"

        return {
          apiKey: initialToken,
          async fetch(
            input: RequestInfo | URL,
            init?: RequestInit
          ): Promise<Response> {
            const token = resolveToken()
            if (!token) {
              log("WARN: No token available for request")
            }

            const headers = new Headers(init?.headers)
            if (token) {
              headers.set("Authorization", `Bearer ${token}`)
            }

            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url
            log(`Fetch: ${init?.method || "GET"} ${url} (token=${token ? "yes" : "NONE"})`)

            const response = await fetch(input, { ...init, headers })

            // Optional observability: tap GhostLLM reasoning_content SSE chunks.
            if (shouldTapReasoning(init)) {
              tapReasoningStream(response, url)
            }

            return response
          },
        }
      },
    },

    // ========================================================================
    // Event Handlers — session lifecycle logging
    // ========================================================================
    event: async ({
      event,
    }: {
      event: { type: string; properties?: Record<string, any> }
    }) => {
      const { type, properties: props = {} } = event
      switch (type) {
        case "session.created":
          log("Session created")
          break
        case "session.idle":
          log("Session idle")
          break
        case "session.error":
          log(`Session error: ${JSON.stringify(props)}`)
          break
      }
    },
  }
}

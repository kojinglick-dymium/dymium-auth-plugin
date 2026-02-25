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

function sanitizeReasoning(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 280)
}

function isJSONContentType(contentType: string | null): boolean {
  if (!contentType) return false
  return contentType.toLowerCase().includes("application/json")
}

function shouldTapStreamingResponse(
  method: string,
  url: string,
  response: Response,
  requestBody?: string
): boolean {
  if (method.toUpperCase() !== "POST") return false
  if (!/\/v1\/(chat\/completions|responses)(\/|$)/.test(url)) return false

  const contentType = response.headers.get("content-type")
  if (contentType?.toLowerCase().includes("text/event-stream")) return true

  // Fallback: inspect request for stream=true when response header is missing/misleading.
  if (requestBody && isJSONContentType(response.headers.get("content-type"))) {
    try {
      const payload = JSON.parse(requestBody)
      return payload?.stream === true
    } catch {}
  }
  return false
}

function parseProtectedDetailsLine(line: string): Record<string, string> {
  // Example:
  // "Protected details: EMAIL_ADDRESS(jo***@ex***.com), PHONE_NUMBER(+1***), US_SSN(***-**-6789)"
  const out: Record<string, string> = {}
  const marker = "Protected details:"
  const idx = line.indexOf(marker)
  if (idx < 0) return out
  const rest = line.slice(idx + marker.length).trim()
  if (!rest) return out
  for (const item of rest.split(",")) {
    const part = item.trim()
    const open = part.indexOf("(")
    const close = part.lastIndexOf(")")
    if (open <= 0 || close <= open) continue
    const key = part.slice(0, open).trim()
    const val = part.slice(open + 1, close).trim()
    if (key) out[key] = val
  }
  return out
}

function canonicalReasoningStatus(line: string): string | null {
  const clean = sanitizeReasoning(line)
  if (!clean) return null

  if (/^Securing PII:/i.test(clean)) {
    return "PII Protection: Securing request..."
  }
  if (/Request verified secure/i.test(clean)) {
    return "PII Protection: No sensitive data detected"
  }
  if (/^Protected \d+ items:/i.test(clean)) {
    return `PII Protection: ${clean}`
  }
  if (/^Protected details:/i.test(clean)) {
    return `PII Protection: ${clean}`
  }
  if (/Restoring protected data/i.test(clean)) {
    return "PII Protection: Restoring protected data..."
  }
  return null
}

function readNumber(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function compactTypeCounts(byType: any): string {
  if (!byType || typeof byType !== "object") return ""
  const pairs: string[] = []
  for (const [k, v] of Object.entries(byType)) {
    const n = readNumber(v)
    if (n !== null) pairs.push(`${k}=${n}`)
  }
  pairs.sort()
  return pairs.join(", ")
}

function formatGhostPIISummary(ghostPII: any): string {
  const summary = ghostPII?.summary ?? {}
  const totalDetected =
    readNumber(summary?.total_detected) ??
    readNumber(summary?.detected) ??
    readNumber(ghostPII?.total_detected) ??
    readNumber(ghostPII?.detected)

  const totalTransformed =
    readNumber(summary?.total_transformed) ??
    readNumber(summary?.transformed) ??
    readNumber(ghostPII?.total_transformed) ??
    readNumber(ghostPII?.transformed)

  const redactedMessages =
    readNumber(summary?.redacted_messages) ?? readNumber(ghostPII?.redacted_messages)
  const redactedToolResults =
    readNumber(summary?.redacted_tool_results) ?? readNumber(ghostPII?.redacted_tool_results)
  const byType = compactTypeCounts(summary?.by_type ?? ghostPII?.by_type)
  const mode = ghostPII?.mode || summary?.mode || "unknown"

  const parts: string[] = [`PII Protection: ON`, `mode=${mode}`]
  if (redactedMessages !== null) parts.push(`redacted_messages=${redactedMessages}`)
  if (redactedToolResults !== null) parts.push(`redacted_tool_results=${redactedToolResults}`)
  if (totalDetected !== null) parts.push(`detected=${totalDetected}`)
  if (totalTransformed !== null) parts.push(`transformed=${totalTransformed}`)
  if (byType) parts.push(`types=${byType}`)
  return parts.join(" | ")
}

function tapGhostLLMSSE(response: Response, url: string) {
  // Detached observer: never block or mutate the original stream OpenCode consumes.
  ;(async () => {
    try {
      const clone = response.clone()
      if (!clone.body) return
      const reader = clone.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let split = buf.indexOf("\n")
        while (split >= 0) {
          const line = buf.slice(0, split).trim()
          buf = buf.slice(split + 1)
          split = buf.indexOf("\n")

          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === "[DONE]") continue

          let parsed: any
          try {
            parsed = JSON.parse(payload)
          } catch {
            continue
          }

          const delta = parsed?.choices?.[0]?.delta
          const reasoning =
            typeof delta?.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta?.reasoning_details === "string"
                ? delta.reasoning_details
                : null
          if (reasoning && reasoning.trim()) {
            const clean = sanitizeReasoning(reasoning)
            log(`SSE.Reasoning: ${clean}`)
            const status = canonicalReasoningStatus(reasoning)
            if (status) log(status)
            const details = parseProtectedDetailsLine(reasoning)
            if (Object.keys(details).length > 0) {
              log(`SSE.PII.Details: ${JSON.stringify(details)}`)
            }
          }

          const ghostPII = parsed?.ghostllm_pii
          if (ghostPII) {
            log(`SSE.GhostLLMPII: ${JSON.stringify(ghostPII)}`)
            log(formatGhostPIISummary(ghostPII))
          }
        }
      }
      log(`SSE observer completed for ${url}`)
    } catch (err) {
      log(`SSE observer error: ${String(err)}`)
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
            let requestBody: string | undefined
            if (typeof init?.body === "string") {
              requestBody = init.body
            }

            const response = await fetch(input, { ...init, headers })
            if (shouldTapStreamingResponse(init?.method || "GET", url, response, requestBody)) {
              tapGhostLLMSSE(response, url)
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
        case "message.part.delta": {
          const field = props?.field
          const delta = props?.delta
          if (
            (field === "reasoning_content" || field === "reasoning_details") &&
            typeof delta === "string" &&
            delta.trim()
          ) {
            const clean = sanitizeReasoning(delta)
            log(`ReasoningDelta: ${clean}`)
            const status = canonicalReasoningStatus(delta)
            if (status) log(status)
          }
          break
        }
        case "message.part.updated": {
          const part = props?.part
          const text = part?.text
          if (part?.type === "reasoning" && typeof text === "string" && text.trim()) {
            const clean = sanitizeReasoning(text)
            log(`ReasoningPart: ${clean}`)
            const status = canonicalReasoningStatus(text)
            if (status) log(status)
          }
          break
        }
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

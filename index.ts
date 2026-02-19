import fs from "fs"
import path from "path"
import os from "os"

// Log file for debugging (no console.log to avoid polluting OpenCode UI)
const LOG_DIR = path.join(os.homedir(), ".local/share/dymium-opencode-plugin")
const LOG_FILE = path.join(LOG_DIR, "debug.log")

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
} catch {}

function log(message: string) {
  const timestamp = new Date().toISOString()
  const line = `${timestamp} ${message}\n`
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

// ============================================================================
// Session State Tracking
// ============================================================================

interface SessionState {
  requestStartTime: number | null
  lastStatus: string | null
  isProcessing: boolean
}

const sessionState: SessionState = {
  requestStartTime: null,
  lastStatus: null,
  isProcessing: false,
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * OpenCode Plugin for Dymium/GhostLLM
 *
 * Authentication is handled natively by OpenCode via options.apiKey
 * in opencode.json, written by the Dymium Provider app.
 *
 * This plugin provides:
 * - Event handlers for session lifecycle logging
 * - Debugging support for the GhostLLM integration
 */
export default async function plugin({ client, project, directory }: any) {
  log(`Plugin initialized for project: ${project?.name || directory}`)

  return {
    // ========================================================================
    // Event Handlers
    // ========================================================================
    event: async ({ event }: { event: { type: string; properties?: Record<string, any> } }) => {
      const eventType = event.type
      const props = event.properties || {}

      switch (eventType) {
        case "session.status":
          sessionState.lastStatus = props.status || "unknown"
          log(`Session status: ${sessionState.lastStatus}`)
          break

        case "session.idle":
          if (sessionState.requestStartTime) {
            const duration = Date.now() - sessionState.requestStartTime
            log(`Session completed in ${formatDuration(duration)}`)
            sessionState.requestStartTime = null
          }
          sessionState.isProcessing = false
          sessionState.lastStatus = "idle"
          break

        case "session.error":
          log(`Session error: ${JSON.stringify(props)}`)
          sessionState.isProcessing = false
          sessionState.lastStatus = "error"
          if (sessionState.requestStartTime) {
            const duration = Date.now() - sessionState.requestStartTime
            log(`Session failed after ${formatDuration(duration)}`)
            sessionState.requestStartTime = null
          }
          break

        case "session.created":
          sessionState.requestStartTime = Date.now()
          sessionState.isProcessing = true
          sessionState.lastStatus = "started"
          log("Session created")
          break

        case "message.part.updated":
          if (props.part?.type === "reasoning") {
            log(`Reasoning update: ${props.part?.reasoning?.substring(0, 100)}...`)
          }
          break

        default:
          if (eventType.startsWith("session.") || eventType.startsWith("message.")) {
            log(`Event: ${eventType}`)
          }
      }
    },
  }
}

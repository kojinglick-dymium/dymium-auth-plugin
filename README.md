# dymium-auth-plugin

OpenCode plugin for Dymium/GhostLLM authentication with automatic token refresh.

## Overview

This plugin intercepts API requests to the `dymium` provider in OpenCode and:

1. **Reads fresh tokens** from `~/.local/share/opencode/auth.json` on every request
2. **Injects Authorization header** (`Bearer <token>`) for each request
3. **Logs reasoning transparency signals** from OpenCode message-part events for debug observability
4. **Taps raw SSE streams** on chat/responses endpoints and logs GhostLLM reasoning/PII metadata directly

## Problem Solved

When using OpenCode with Dymium/GhostLLM and short-lived credentials:
- the plugin guarantees fresh token injection per request,
- and can observe PII transparency reasoning lines without changing response semantics.

## Installation

### With DymiumProvider (Recommended)

The [DymiumProvider](https://github.com/dymium-io/dymium-provider) macOS app automatically installs and manages this plugin.

### Manual Installation

1. Add to your `~/.config/opencode/opencode.json`:
   ```json
   {
     "plugin": [
       "dymium-auth-plugin@latest"
     ],
     "provider": {
       "dymium": {
         "npm": "@ai-sdk/openai-compatible",
         "api": "http://your-llm-endpoint:3000/v1",
         "models": { ... }
       }
     }
   }
   ```

2. Ensure `~/.local/share/opencode/auth.json` has a dymium entry:
   ```json
   {
     "dymium": {
        "type": "api",
       "key": "your-jwt-token"
     }
   }
   ```

## How It Works

```
┌─────────────────────┐
│     OpenCode        │
│  (dymium provider)  │
└─────────┬───────────┘
          │ API Request
          ▼
┌─────────────────────┐
│  dymium-auth-plugin │
├─────────────────────┤
│ 1. Read token       │◀── ~/.dymium/token or auth.json
│ 2. Set Auth header  │
│ 3. Send request     │
│ 4. Log reasoning evt│
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  kubectl port-fwd   │
│  → Istio Gateway    │
│  → GhostLLM Backend │
└─────────────────────┘
```

## GhostLLM Streaming Transparency

When OpenCode emits reasoning part updates (for example from `delta.reasoning_content`), the plugin logs:
- `ReasoningDelta: ...` for `message.part.delta` events
- `ReasoningPart: ...` for `message.part.updated` reasoning parts

Additionally, for streaming chat/responses calls, the plugin now performs a non-blocking SSE observer on a cloned response stream and logs:
- `SSE.Reasoning: ...` for raw `delta.reasoning_content` / `delta.reasoning_details`
- `SSE.PII.Details: {...}` when a structured masked `Protected details:` line is present
- `SSE.GhostLLMPII: {...}` when a `ghostllm_pii` object appears in stream payloads

This is observability-only and does not alter content/tool-call semantics or OpenCode response handling.

### Debug Logging

Logs written to `~/.local/share/dymium-opencode-plugin/debug.log` (not stdout to avoid polluting OpenCode UI).

## Related Projects

- [DymiumProvider](https://github.com/dymium-io/dymium-provider) - Tray app for token + OpenCode config management

## License

MIT

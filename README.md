# dymium-auth-plugin

OpenCode plugin for Dymium/GhostLLM authentication with automatic token refresh.

## Overview

This plugin intercepts API requests to the `dymium` provider in OpenCode and:

1. **Reads fresh tokens** from `~/.local/share/opencode/auth.json` on every request
2. **Injects Authorization header** (`Bearer <token>`) for each request
3. **Taps streaming reasoning signals** (`delta.reasoning_content`) for debug observability

## Problem Solved

When using OpenCode with Dymium/GhostLLM and short-lived credentials:
- the plugin guarantees fresh token injection per request,
- and can observe PII transparency reasoning lines in SSE streams without changing response semantics.

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
│ 4. Tap reasoning SSE│
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

When a request uses `"stream": true`, GhostLLM may emit optional:
- `choices[0].delta.reasoning_content`

The plugin does not alter protocol behavior. It only logs these lines for debugging.

### Debug Logging

Logs written to `~/.local/share/dymium-opencode-plugin/debug.log` (not stdout to avoid polluting OpenCode UI).

## Related Projects

- [DymiumProvider](https://github.com/dymium-io/dymium-provider) - Tray app for token + OpenCode config management

## License

MIT

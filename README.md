# dymium-auth-plugin

OpenCode plugin for Dymium/GhostLLM authentication with automatic token refresh and kubectl port-forward compatibility.

## Overview

This plugin intercepts API requests to the "dymium" provider in OpenCode and:

1. **Reads fresh tokens** from `~/.local/share/opencode/auth.json` on every request
2. **Sets X-GhostLLM-App header** for OIDC/JWT authentication with GhostLLM
3. **Uses HTTP/1.1** explicitly to avoid crashing kubectl port-forward tunnels
4. **Sets proper Host headers** for Istio Gateway routing (hostname only, no port)

## Problem Solved

When using OpenCode with a custom LLM provider behind:
- **Keycloak authentication** with short-lived tokens (5 min)
- **kubectl port-forward** to an Istio Gateway
- **Istio VirtualService** routing based on Host header

Standard `fetch()` can cause issues:
- HTTP/2 upgrade attempts crash port-forward ("connection reset by peer")
- Keep-alive connections confuse the tunnel
- Host headers with ports don't match VirtualService rules

## Installation

### With DymiumProvider (Recommended)

The [DymiumProvider](https://github.com/dymium-io/dymium-provider) macOS app automatically installs and manages this plugin.

### Manual Installation

1. Clone to `~/.local/share/dymium-opencode-plugin/`:
   ```bash
   git clone git@dymium:dymium-io/dymium-auth-plugin.git ~/.local/share/dymium-opencode-plugin
   ```

2. Add to your `~/.config/opencode/opencode.json`:
   ```json
   {
     "plugin": [
       "file:///Users/YOU/.local/share/dymium-opencode-plugin"
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

3. Ensure `~/.local/share/opencode/auth.json` has a dymium entry:
   ```json
   {
     "dymium": {
       "type": "api",
       "key": "your-jwt-token",
       "app": "your-ghostllm-app-name"
     }
   }
   ```
   
   The `app` field is **required** for OIDC/JWT authentication. It identifies which GhostLLM application configuration to use and is sent as the `X-GhostLLM-App` header.

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
│ 1. Read token + app │◀── ~/.local/share/opencode/auth.json
│ 2. Set Auth header  │
│ 3. Set X-GhostLLM-App│
│ 4. HTTP/1.1 request │
│ 5. Host: hostname   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  kubectl port-fwd   │
│  → Istio Gateway    │
│  → GhostLLM Backend │
└─────────────────────┘
```

## Technical Details

### HTTP/1.1 Implementation

Uses Node's native `http`/`https` modules instead of `fetch()`:

```typescript
const reqOptions: http.RequestOptions = {
  hostname: url.hostname,
  port: url.port,
  path: url.pathname + url.search,
  method: "POST",
  headers: {
    "Host": url.hostname,  // No port!
    "Connection": "close", // No keep-alive
    "Content-Length": "...",
    "Authorization": "Bearer <jwt-token>",
    "X-GhostLLM-App": "your-app-name"  // Required for OIDC auth
  }
}
```

### X-GhostLLM-App Header

When using Keycloak JWT tokens (OIDC authentication), GhostLLM requires the `X-GhostLLM-App` header to identify which application configuration to use. This header value should be either:

- The **application name** (e.g., `"opencode-dev"`)
- The **application ID** (UUID)

The plugin reads this from the `app` field in `auth.json` and includes it automatically in all requests.

### Istio Gateway Compatibility

- Host header uses **hostname only** (e.g., `spoofcorp.llm.dymium.home`)
- NOT `hostname:port` (e.g., ~~`spoofcorp.llm.dymium.home:3000`~~)
- Matches how Istio VirtualService host matching works

### Debug Logging

Logs written to `~/.local/share/dymium-opencode-plugin/debug.log` (not stdout to avoid polluting OpenCode UI).

## Related Projects

- [DymiumProvider](https://github.com/dymium-io/dymium-provider) - macOS menu bar app for Keycloak token management

## License

MIT

# GhostLLM Reasoning Events Implementation Guide

## Overview

This guide covers implementing "reasoning trace" SSE events in GhostLLM to provide user feedback during PII processing. The goal is to eliminate the "dead air" UX problem where users see only a throbber while waiting for PII obfuscation/de-obfuscation.

## The Problem

Current flow has a long pause with no feedback:

```
User sends message
    └─► [SILENCE - 2-10 seconds]
        ├─ PII detection running
        ├─ Obfuscation happening  
        ├─ LLM call in progress
        └─ De-obfuscation completing
    └─► Complete response arrives
```

## The Solution

Emit SSE "reasoning" events during each processing phase:

```
User sends message
    └─► SSE: reasoning "🔒 Securing your request..."
    └─► SSE: reasoning "🛡️ Protected 3 sensitive items"
    └─► SSE: reasoning "🤖 Waiting for AI response..."
    └─► SSE: reasoning "🔓 Restoring protected data..."
    └─► SSE: content "Here is your actual response..."
```

---

## SSE Event Format

### OpenAI-Compatible Format (Recommended)

Use `reasoning_content` in the delta - this is what models like o1 and DeepSeek use:

```json
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"ghostllm","choices":[{"index":0,"delta":{"reasoning_content":"🔒 Securing your request..."},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"ghostllm","choices":[{"index":0,"delta":{"reasoning_content":"🛡️ Protected 3 sensitive items"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"ghostllm","choices":[{"index":0,"delta":{"content":"Here is your actual response..."}},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"ghostllm","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Key Fields

| Field | Purpose |
|-------|---------|
| `delta.reasoning_content` | Displayed in "thinking" UI block |
| `delta.content` | Displayed as regular assistant message |
| `finish_reason` | `null` while streaming, `"stop"` when done |

---

## Implementation Locations

### 1. Customer Server (`messenger/client.go`)

This is where `CallCompletion()` is called. Currently it waits for the full response before returning.

**Current code flow:**
```go
// In handler that processes chat requests
response, err := client.CallCompletion(ctx, request)
// ... wait for full response ...
// ... de-obfuscate ...
// ... send to client ...
```

**New code flow:**
```go
// 1. Start SSE response immediately
w.Header().Set("Content-Type", "text/event-stream")
w.Header().Set("Cache-Control", "no-cache")
w.Header().Set("Connection", "keep-alive")
flusher := w.(http.Flusher)

// 2. Send initial reasoning event
sendReasoningEvent(w, flusher, "🔒 Securing your request...")

// 3. Perform PII detection/obfuscation
obfuscatedRequest, piiMap := obfuscate(request)
if len(piiMap) > 0 {
    sendReasoningEvent(w, flusher, fmt.Sprintf("🛡️ Protected %d sensitive items", len(piiMap)))
}

// 4. Send "waiting" event
sendReasoningEvent(w, flusher, "🤖 Waiting for AI response...")

// 5. Call upstream LLM (blocking)
response, err := client.CallCompletion(ctx, obfuscatedRequest)

// 6. Send "restoring" event
sendReasoningEvent(w, flusher, "🔓 Restoring protected data...")

// 7. De-obfuscate and send content
deobfuscatedContent := deobfuscate(response.Content, piiMap)
sendContentEvent(w, flusher, deobfuscatedContent)

// 8. Send done
sendDoneEvent(w, flusher)
```

### 2. Helper Functions

```go
func sendReasoningEvent(w http.ResponseWriter, flusher http.Flusher, message string) {
    chunk := map[string]interface{}{
        "id":      generateChunkID(),
        "object":  "chat.completion.chunk",
        "created": time.Now().Unix(),
        "model":   "ghostllm",
        "choices": []map[string]interface{}{
            {
                "index": 0,
                "delta": map[string]interface{}{
                    "reasoning_content": message,
                },
                "finish_reason": nil,
            },
        },
    }
    
    data, _ := json.Marshal(chunk)
    fmt.Fprintf(w, "data: %s\n\n", data)
    flusher.Flush()
}

func sendContentEvent(w http.ResponseWriter, flusher http.Flusher, content string) {
    // For large content, chunk it (e.g., 50 chars at a time)
    for i := 0; i < len(content); i += 50 {
        end := min(i+50, len(content))
        chunk := map[string]interface{}{
            "id":      generateChunkID(),
            "object":  "chat.completion.chunk", 
            "created": time.Now().Unix(),
            "model":   "ghostllm",
            "choices": []map[string]interface{}{
                {
                    "index": 0,
                    "delta": map[string]interface{}{
                        "content": content[i:end],
                    },
                    "finish_reason": nil,
                },
            },
        }
        
        data, _ := json.Marshal(chunk)
        fmt.Fprintf(w, "data: %s\n\n", data)
        flusher.Flush()
    }
}

func sendDoneEvent(w http.ResponseWriter, flusher http.Flusher) {
    // Final chunk with finish_reason
    chunk := map[string]interface{}{
        "id":      generateChunkID(),
        "object":  "chat.completion.chunk",
        "created": time.Now().Unix(),
        "model":   "ghostllm",
        "choices": []map[string]interface{}{
            {
                "index":         0,
                "delta":         map[string]interface{}{},
                "finish_reason": "stop",
            },
        },
    }
    
    data, _ := json.Marshal(chunk)
    fmt.Fprintf(w, "data: %s\n\n", data)
    fmt.Fprintf(w, "data: [DONE]\n\n")
    flusher.Flush()
}
```

---

## Reasoning Message Guidelines

### Recommended Messages

| Phase | Message | Emoji |
|-------|---------|-------|
| Start | "Securing your request..." | 🔒 |
| PII Found | "Protected N sensitive items" | 🛡️ |
| No PII | "Request verified secure" | ✓ |
| LLM Call | "Waiting for AI response..." | 🤖 |
| De-obfuscate | "Restoring protected data..." | 🔓 |
| Complete | (no message, just content) | - |

### Terminology

Prefer user-friendly terms:
- ✅ "Securing" / "Protected" / "Restoring"
- ❌ "Obfuscating" / "Anonymizing" / "De-obfuscating"

---

## Conditional Behavior

When PII detection is **disabled**, you have two options:

### Option A: Skip Reasoning Events Entirely
```go
if !config.DetectPII {
    // Use true streaming passthrough from upstream
    return proxyStreamingResponse(w, upstreamResponse)
}
```

### Option B: Still Show Minimal Status
```go
if !config.DetectPII {
    sendReasoningEvent(w, flusher, "🤖 Connecting to AI...")
    // ... rest of flow without PII events
}
```

---

## Testing

### Manual Testing with curl

```bash
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello, my name is John Smith"}],
    "stream": true
  }'
```

Expected output:
```
data: {"id":"...","choices":[{"delta":{"reasoning_content":"🔒 Securing your request..."}}]}

data: {"id":"...","choices":[{"delta":{"reasoning_content":"🛡️ Protected 1 sensitive items"}}]}

data: {"id":"...","choices":[{"delta":{"reasoning_content":"🤖 Waiting for AI response..."}}]}

data: {"id":"...","choices":[{"delta":{"reasoning_content":"🔓 Restoring protected data..."}}]}

data: {"id":"...","choices":[{"delta":{"content":"Hello! Nice to meet you, John Smith..."}}]}

data: {"id":"...","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Verify in OpenCode

1. Configure OpenCode to use your GhostLLM endpoint
2. Send a message containing PII (e.g., "My SSN is 123-45-6789")
3. Watch for the reasoning trace to appear in the UI

---

## Rollout Checklist

- [ ] Implement `sendReasoningEvent()` helper
- [ ] Implement `sendContentEvent()` helper  
- [ ] Implement `sendDoneEvent()` helper
- [ ] Modify chat handler to start SSE immediately
- [ ] Add reasoning events at each processing phase
- [ ] Test with curl
- [ ] Test with OpenCode
- [ ] Add feature flag for conditional behavior
- [ ] Update documentation

---

## Related Files

- `messenger/client.go` - Main completion handler
- `ghostllm/handler.go` - GhostLLM request processing (if separate)
- `pii/detector.go` - PII detection logic
- `pii/obfuscator.go` - Obfuscation/de-obfuscation

---

## Questions to Resolve

1. **Chunk ID consistency**: Should all chunks in one response share the same ID, or use unique IDs?
   - Recommendation: Same ID for the entire response (matches OpenAI behavior)

2. **Timing**: Should there be artificial delays between reasoning events for readability?
   - Recommendation: No artificial delays - natural processing time is enough

3. **Error handling**: What reasoning message to show on errors?
   - Recommendation: `"⚠️ Processing error occurred"` then normal error response

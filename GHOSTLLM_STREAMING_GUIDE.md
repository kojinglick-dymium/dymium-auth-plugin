# GhostLLM Reasoning Stream Implementation Guide

## Goal

Emit "reasoning" SSE events during PII processing phases so OpenCode displays progress to the user instead of showing a blank throbber.

## Expected User Experience

```
┌─ Thinking ──────────────────────────────┐
│ 🔒 Securing request...                  │
│ 🔒 Protected 3 sensitive items          │
│ 🤖 Waiting for AI response...           │
│ 🔓 Restoring protected data...          │
└─────────────────────────────────────────┘

Here is your actual response from the LLM...
```

---

## SSE Format for OpenAI-Compatible Reasoning

OpenCode renders `reasoning_content` in a collapsible "Thinking" block. Use this field:

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🔒 Securing request..."}}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🔒 Protected 3 sensitive items"}}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🤖 Waiting for AI response..."}}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🔓 Restoring protected data..."}}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Here is your actual response..."}}]}

data: [DONE]
```

**Key points:**
- Use `reasoning_content` (not `content`) for status messages
- Keep the same `id` across all chunks
- Switch to `content` for the actual LLM response
- End with `data: [DONE]`

---

## Implementation Steps

### 1. Identify the Handler Location

Find where the chat completion request is handled. Based on your earlier conversation, this is likely in:

```
messenger/client.go  →  CallCompletion() 
```

or the HTTP handler that receives requests from OpenCode.

### 2. Start SSE Stream Immediately

Instead of waiting for the full response, start the SSE stream as soon as the request arrives:

```go
// Pseudocode for the handler
func handleChatCompletion(w http.ResponseWriter, r *http.Request) {
    // Set SSE headers immediately
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "Streaming not supported", http.StatusInternalServerError)
        return
    }
    
    // Generate a consistent ID for this completion
    completionID := fmt.Sprintf("chatcmpl-%s", generateID())
    
    // Helper to send reasoning chunks
    sendReasoning := func(message string) {
        chunk := fmt.Sprintf(`data: {"id":"%s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"%s"}}]}`, 
            completionID, message)
        fmt.Fprintf(w, "%s\n\n", chunk)
        flusher.Flush()
    }
    
    // Phase 1: PII Detection
    sendReasoning("🔒 Securing request...")
    
    // ... do PII detection ...
    piiResult := detectPII(request.Messages)
    
    if piiResult.Count > 0 {
        sendReasoning(fmt.Sprintf("🔒 Protected %d sensitive items", piiResult.Count))
    }
    
    // Phase 2: LLM Call
    sendReasoning("🤖 Waiting for AI response...")
    
    // ... call upstream LLM (this is the slow part) ...
    llmResponse := callMessenger(obfuscatedRequest)
    
    // Phase 3: De-obfuscation
    sendReasoning("🔓 Restoring protected data...")
    
    // ... de-obfuscate response ...
    finalResponse := deobfuscate(llmResponse, piiResult.Mappings)
    
    // Phase 4: Send actual content
    sendContent := func(content string) {
        chunk := fmt.Sprintf(`data: {"id":"%s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"%s"}}]}`,
            completionID, escapeJSON(content))
        fmt.Fprintf(w, "%s\n\n", chunk)
        flusher.Flush()
    }
    
    // Send the actual response (can be chunked if large)
    sendContent(finalResponse)
    
    // End the stream
    fmt.Fprintf(w, "data: [DONE]\n\n")
    flusher.Flush()
}
```

### 3. JSON Escaping

Make sure to escape the content properly for JSON:

```go
func escapeJSON(s string) string {
    b, _ := json.Marshal(s)
    // Remove surrounding quotes
    return string(b[1 : len(b)-1])
}
```

### 4. Handle Non-Streaming Requests

Check if the request wants streaming:

```go
type ChatRequest struct {
    // ... other fields
    Stream bool `json:"stream"`
}

// In handler:
if !request.Stream {
    // Return complete response as before
    // (for backwards compatibility)
}
```

---

## Timing Considerations

The reasoning messages should appear at natural breakpoints:

| Phase | Message | When |
|-------|---------|------|
| Start | `🔒 Securing request...` | Immediately on request receipt |
| After PII scan | `🔒 Protected N sensitive items` | After detection completes (skip if N=0) |
| Before LLM | `🤖 Waiting for AI response...` | Before calling upstream |
| After LLM | `🔓 Restoring protected data...` | After LLM responds, before de-obfuscation |

---

## Testing

### Manual Test with curl

```bash
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "gpt-4",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello, my name is John Smith"}]
  }'
```

Expected output:
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🔒 Securing request..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🔒 Protected 1 sensitive items"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🤖 Waiting for AI response..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"🔓 Restoring protected data..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello! Nice to meet you, John Smith..."}}]}

data: [DONE]
```

### Test with OpenCode

Once implemented, OpenCode should automatically render the reasoning content in a "Thinking" block.

---

## Optional Enhancements

### 1. Progress for Long Operations

If PII detection or de-obfuscation takes time on large messages:

```go
sendReasoning("🔒 Scanning message 1 of 5...")
sendReasoning("🔒 Scanning message 2 of 5...")
// etc.
```

### 2. Conditional Reasoning

Only show reasoning when PII protection is enabled:

```go
if config.DetectPII {
    sendReasoning("🔒 Securing request...")
    // ... PII logic ...
} else {
    // Skip straight to LLM call, possibly with true streaming
}
```

### 3. Timing Information

```go
start := time.Now()
// ... do work ...
sendReasoning(fmt.Sprintf("🔒 Protected %d items in %dms", count, time.Since(start).Milliseconds()))
```

---

## Checklist

- [ ] Identify the chat completion handler in your codebase
- [ ] Add SSE headers at start of handler
- [ ] Implement `sendReasoning()` helper
- [ ] Add reasoning events at each processing phase
- [ ] Properly escape JSON content
- [ ] Test with curl
- [ ] Test with OpenCode
- [ ] Handle non-streaming requests for backwards compatibility

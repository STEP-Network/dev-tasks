/**
 * A local stand-in for the Messages API, so the real Claude Code binary can
 * run a session with no network and no spend (ANTHROPIC_BASE_URL points here).
 * The main loop (a request that offers the Bash tool) gets the scripted tool
 * calls, one per turn, then a text reply. Any other request gets text. Not a
 * test file (no .test.ts).
 */

import { createServer, type ServerResponse } from "node:http"

export type ToolCall = { name: string; input: Record<string, unknown> }

export interface FakeApi {
  url: string
  /** The paths asked for, in order. */
  paths: string[]
  close(): Promise<void>
}

interface MessagesRequest {
  stream?: boolean
  model?: string
  tools?: Array<{ name?: string }>
  messages?: Array<{ content?: unknown }>
}

function sse(res: ServerResponse, events: Array<{ type: string } & Record<string, unknown>>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}

export async function startFakeApi(script: ToolCall[]): Promise<FakeApi> {
  const paths: string[] = []
  let n = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]
      paths.push(path)
      let request: MessagesRequest = {}
      try {
        request = JSON.parse(body || "{}") as MessagesRequest
      } catch {
        // Not JSON: answered as any other request.
      }
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      if (!path.endsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not in the fake" } }))
        return
      }
      const main = (request.tools ?? []).some((t) => t.name === "Bash")
      const answered = (request.messages ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : []))
        .filter((c) => c.type === "tool_result").length
      const call = main && answered < script.length ? script[answered] : null
      const id = `msg_${++n}`
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      const content = call ? [{ type: "tool_use", id: `toolu_${n}`, name: call.name, input: call.input }] : [{ type: "text", text: "done" }]
      const stop = call ? "tool_use" : "end_turn"
      if (!request.stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id, type: "message", role: "assistant", model: request.model, content, stop_reason: stop, stop_sequence: null, usage }))
        return
      }
      sse(res, [
        { type: "message_start", message: { id, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        {
          type: "content_block_start",
          index: 0,
          content_block: call ? { type: "tool_use", id: `toolu_${n}`, name: call.name, input: {} } : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "done" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ])
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, paths, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

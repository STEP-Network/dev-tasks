/**
 * Local stand-ins for the Messages API and Linear, so the real Claude Code
 * binary can run a session with no network and no spend (ANTHROPIC_BASE_URL
 * and DEV_TASKS_LINEAR_ENDPOINT point here), for agentctl probe-sandbox and
 * the tests. The main loop (a request that offers the Bash tool) gets the
 * scripted tool calls, one per turn, then a text reply. Any other request
 * gets text. Both listen on loopback only.
 */

import { createServer, type ServerResponse } from "node:http"

/** A scripted tool call. Its input may be computed from the text of the last tool result, e.g. a name another tool reported. */
export type ToolCall = { name: string; input: Record<string, unknown> | ((lastResult: string) => Record<string, unknown>) }
/** A step of a script: a tool call, or the text the conversation ends with (else "done"). */
export type Step = ToolCall | { reply: string }

export interface FakeApi {
  url: string
  /** The paths asked for, in order. */
  paths: string[]
  /** The request bodies, in order: what reached the model. */
  bodies: string[]
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

export interface FakeLinear {
  url: string
  /** Every request: its Authorization header and its body. */
  requests: Array<{ authorization: string | undefined; body: string }>
  close(): Promise<void>
}

/** Linear's GraphQL endpoint on loopback, for DEV_TASKS_LINEAR_ENDPOINT: Eve as the viewer, and an empty queue. */
export async function startFakeLinear(): Promise<FakeLinear> {
  const requests: FakeLinear["requests"] = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body })
      res.writeHead(200, { "content-type": "application/json" })
      const data = body.includes("viewer")
        ? { viewer: { id: "user-eve", name: "Eve", email: "eve@polads.eu" } }
        : { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
      res.end(JSON.stringify({ data }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/graphql`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/**
 * subagents: a conversation whose first message holds one of these markers (a
 * subagent's prompt) gets that script instead, for probing what a worker's
 * subagents may do (worker.fanOut).
 */
export async function startFakeApi(script: Step[], subagents: Record<string, Step[]> = {}): Promise<FakeApi> {
  const paths: string[] = []
  const bodies: string[] = []
  let n = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]
      paths.push(path)
      bodies.push(body)
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
      const first = JSON.stringify(request.messages?.[0]?.content ?? "")
      const marker = Object.keys(subagents).find((m) => first.includes(m))
      const steps = marker ? subagents[marker] : script
      const main = marker !== undefined || (request.tools ?? []).some((t) => t.name === "Bash")
      const results = (request.messages ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string; content?: unknown }>) : []))
        .filter((c) => c.type === "tool_result")
      const answered = results.length
      const step = main && answered < steps.length ? steps[answered] : null
      const last = results.length ? results[results.length - 1].content : ""
      const call = step && "name" in step ? { name: step.name, input: typeof step.input === "function" ? step.input(typeof last === "string" ? last : JSON.stringify(last)) : step.input } : null
      const text = step && "reply" in step ? step.reply : "done"
      const id = `msg_${++n}`
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      const content = call ? [{ type: "tool_use", id: `toolu_${n}`, name: call.name, input: call.input }] : [{ type: "text", text }]
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
          delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ])
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, paths, bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

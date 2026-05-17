/**
 * Per-request Monday auth context — AsyncLocalStorage singleton.
 *
 * The hosted HTTP transport reads a Bearer token off each incoming request,
 * wraps the handler body in `mondayAuthContext.run({ apiKey }, ...)`, and
 * every subsequent Monday API call inside that request reads the token from
 * the ALS store (`monday-client.ts`).
 *
 * Why ALS:
 *   - Zero refactoring of the 38 tool handlers — they continue calling
 *     `executeMondayQuery(query)` without passing a key through every layer.
 *   - Request-scoped isolation. Concurrent requests in the same Node process
 *     each get their own ALS frame; no cross-request token leakage.
 *   - Falls through cleanly: `getStore()` returns `undefined` outside `.run()`,
 *     so the stdio transport (no ALS wrapper) falls back to MONDAY_API_KEY env.
 *
 * Tokens are never persisted, logged, or cached. They live in process memory
 * only for the duration of the request.
 */
import { AsyncLocalStorage } from "node:async_hooks";
export const mondayAuthContext = new AsyncLocalStorage();

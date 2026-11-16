import { ClaudeDriver } from "../../src/claude.js";
const sdk: any = { query: () => ({
 async *[Symbol.asyncIterator]() {
  yield { type: "system", subtype: "init", session_id: "failed-session", model: "model" };
  yield { type: "assistant", message: { id: "assistant-one", content: [{ type: "text", text: "Not logged in" }] }, error: "authentication_failed" };
  yield { type: "result", subtype: "error_during_execution", is_error: true, uuid: "result-one", session_id: "failed-session", user_message_uuids: ["client-one"], errors: ["Not logged in"], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0, modelUsage: {}, num_turns: 0, duration_ms: 1, duration_api_ms: 0, stop_reason: null, permission_denials: [] };
  throw new Error("Claude Code process exited with code 1");
 }, close() {}, interrupt: async () => {} }) };
const driver = new ClaudeDriver({ sdk });
const handle = await driver.startTurn({ workspace: "/tmp", prompt: "test", clientMessageId: "client-one", presetSessionId: "failed-session" }, { nativeSession() {}, nativeTurn() {}, event() {}, usage() {}, rateLimit() {}, status() {}, approval: async () => ({ approve: false, reason: "test" }) });
const result = await handle.done; driver.shutdown(); process.stdout.write(JSON.stringify({ status: result.status, terminalObserved: result.terminalObserved ?? false }));

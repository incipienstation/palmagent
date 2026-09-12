// Normalized event schema shared by both agents and reused by the web client.
// The page only ever sees AgentEvent — it never knows whether it's talking to
// Claude or Codex.

export type AgentKind = "claude" | "codex";

export type AgentEventKind =
  | "status" // lifecycle: init, turn started/ended, reasoning, retries
  | "output_image" // bounded raster image; payload: ImageAttachment
  | "assistant_text" // streamed assistant prose (token deltas for Claude, items for Codex)
  | "tool_call" // a tool/command the agent decided to run
  | "tool_result" // the result of a tool/command
  | "approval_request" // agent is asking for permission (not expected under our non-interactive modes)
  | "question" // agent is asking the user a multiple-choice question (Claude AskUserQuestion); payload: QuestionRequest
  | "result" // the turn finished — carries final text / usage
  | "error";

// ---- AskUserQuestion (Claude) ----
// When a Claude turn calls the AskUserQuestion tool, the headless CLI surfaces it
// over the stream-json permission channel (--permission-prompt-tool stdio). The
// adapter normalizes it into a "question" event so the page can render a tap-to-
// answer UI agent-agnostically. Codex has no equivalent — this is Claude-only.
export interface AskQuestionOption {
  label: string; // the choice the user taps; sent back to the CLI verbatim
  description?: string; // optional one-line explanation shown under the label
}
export interface AskQuestion {
  question: string; // the question text (also the answer key the CLI expects)
  header?: string; // short category label (e.g. "Indentation")
  multiSelect?: boolean; // true => the user may pick more than one option
  options: AskQuestionOption[];
}
// The payload of a "question" event AND what the task carries while paused.
export interface QuestionRequest {
  requestId: string; // the CLI's control_request id — echoed back when answering
  questions: AskQuestion[];
}

export interface AgentEvent {
  taskId: string;
  agent: AgentKind;
  kind: AgentEventKind;
  sessionId?: string; // claude session_id | codex thread_id
  payload: unknown;
  ts: number;
}

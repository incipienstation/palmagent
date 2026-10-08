// Only project the fields Palmagent sends or consumes. Descriptions, unrelated
// methods, and additive optional fields are not compatibility failures.
const fields = (...names) => Object.fromEntries(names.map(name => [name, true]));
const thread = { id: true };
const turn = { id: true, status: true, error: { message: true } };
const input = { $items: { $variants: {
  text: true, image: true, skill: true,
} } };
const item = { $variants: {
  userMessage: fields('id', 'type', 'clientId'),
  agentMessage: fields('id', 'type', 'phase'),
  commandExecution: fields('id', 'type', 'command', 'aggregatedOutput', 'exitCode'),
  fileChange: fields('id', 'type', 'changes'),
  mcpToolCall: fields('id', 'type', 'result', 'tool'),
  webSearch: fields('id', 'type', 'action'),
  contextCompaction: fields('type'),
} };
const session = fields('cwd', 'approvalPolicy', 'sandbox', 'model', 'config');

export const protocolContracts = [
  ['ClientRequest', 'out', {
    initialize: { clientInfo: fields('name', 'version'), capabilities: {} },
    'thread/start': session,
    'thread/resume': { ...session, threadId: true },
    'thread/compact/start': fields('threadId'),
    'turn/start': { ...fields('threadId', 'clientUserMessageId', 'effort'), input },
    'turn/steer': { ...fields('threadId', 'clientUserMessageId', 'expectedTurnId'), input },
    'turn/interrupt': fields('threadId', 'turnId'),
  }],
  ['ClientNotification', 'out', { initialized: null }],
  ['ServerNotification', 'in', {
    'thread/started': { thread },
    'turn/started': { threadId: true, turn: { id: true } },
    'turn/completed': { threadId: true, turn },
    'item/agentMessage/delta': fields('threadId', 'itemId', 'delta'),
    'item/started': { threadId: true, item },
    'item/completed': { threadId: true, item },
    'thread/tokenUsage/updated': { threadId: true, tokenUsage: {
      last: fields('inputTokens', 'cachedInputTokens', 'outputTokens'),
    } },
    error: { threadId: true, error: { message: true } },
    'serverRequest/resolved': fields('threadId', 'requestId'),
  }],
  ['ServerRequest', 'in', {
    'item/commandExecution/requestApproval': {},
    'item/fileChange/requestApproval': {},
    'item/tool/requestUserInput': { threadId: true, questions: {
      $items: fields('id', 'question', 'header', 'options'),
    } },
  }],
];
export const responseContracts = {
  'v2/ThreadCompactStartResponse': {},
  'v2/ThreadStartResponse': { thread }, 'v2/ThreadResumeResponse': { thread },
  'v2/TurnStartResponse': { turn: { id: true } },
};

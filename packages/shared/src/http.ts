/** Error envelope shared by HTTP adapters and browser clients. */
export type ApiErrorResponse = { error: string; code?: string };

// Covers POST /tasks and /tasks/:id/messages, including request IDs, delivery
// semantics and response shapes. Bump on an incompatible change to either
// endpoint. A matching contract lets an older screen finish its pending send
// before the PWA replaces it; other writes still require the current build.
export const MESSAGE_PROTOCOL_VERSION = "1";
export const MESSAGE_PROTOCOL_HEADER = "x-palmagent-message-protocol";

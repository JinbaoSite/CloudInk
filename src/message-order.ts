export type OrderedMessage = {
  id?: string;
  role: string;
  content: string;
  created_at?: string;
};

/**
 * Message order is authoritative. The server persists stream events in arrival
 * order, so the client must never infer a different order from activity kind
 * or timestamp (multiple events can legitimately share a timestamp).
 */
export function preserveMessageOrder<T extends OrderedMessage>(messages: T[]) {
  return [...messages];
}

export function findActivityInCurrentTurn<T extends OrderedMessage>(
  messages: T[],
  toolUseId: string,
  streamingAssistantId?: string,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.id === streamingAssistantId &&
      streamingAssistantId
    )
      continue;
    if (message.role === "user" || message.role === "assistant") break;
    if (message.role !== "activity") continue;
    try {
      const activity = JSON.parse(message.content) as { toolUseId?: string };
      if (activity.toolUseId === toolUseId) return index;
    } catch {}
  }
  return -1;
}

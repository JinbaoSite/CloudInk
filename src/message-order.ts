type ActivityMessage = {
  role: string;
  content: string;
  created_at?: string;
};

function activityKind(message: ActivityMessage) {
  if (message.role !== "activity") return null;
  try {
    return (JSON.parse(message.content) as { kind?: string }).kind || null;
  } catch {
    return null;
  }
}

export function restoreNarrationOrder<T extends ActivityMessage>(
  messages: T[],
) {
  const ordered = [...messages];
  for (let index = 0; index < ordered.length; index += 1) {
    if (activityKind(ordered[index]) !== "narration") continue;
    const batchCreatedAt = ordered[index].created_at;
    if (!batchCreatedAt) continue;
    let target = index;
    while (
      target > 0 &&
      activityKind(ordered[target - 1]) === "tool" &&
      ordered[target - 1].created_at === batchCreatedAt
    )
      target -= 1;
    if (target === index) continue;
    const [narration] = ordered.splice(index, 1);
    ordered.splice(target, 0, narration);
  }
  return ordered;
}

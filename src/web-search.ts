type SearchActivity = {
  label: string;
  toolName?: string;
  detail?: string;
  output?: string;
  isError?: boolean;
};

export function isWebSearch(activity: SearchActivity) {
  return (
    activity.toolName === "WebSearch" ||
    /^(?:WebSearch|Web Search)(?:\s|$)/.test(activity.label)
  );
}

export function webSearchPresentation(activity: SearchActivity) {
  const detail = activity.detail?.trim() || "";
  let input = detail;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const data = parsed as Record<string, unknown>;
      if (typeof data.query === "string") input = data.query;
      else if (
        Array.isArray(data.queries) &&
        data.queries.every((value) => typeof value === "string")
      )
        input = data.queries.join("\n");
      else if (typeof data.url === "string") input = data.url;
      else
        input = Object.keys(data).length ? JSON.stringify(data, null, 2) : "";
    } else if (typeof parsed === "string") input = parsed;
  } catch {
    // Historical Codex events contain plain text rather than JSON tool input.
  }
  let output = activity.output;
  // Legacy Codex search completions only stored the query (or opened URL)
  // as their output. Do not present it as a search result or show an empty IN.
  if (
    !input &&
    !activity.isError &&
    /^Web Search(?:\s|$)/.test(activity.label)
  ) {
    if (output && output.trim() !== "完成") input = output.trim();
    output = undefined;
  }
  if (!input)
    input = activity.label
      .replace(/^(?:WebSearch|Web Search)(?:\s+|$)/, "")
      .trim();
  if (output?.trim() === input || output?.trim() === "完成") output = undefined;
  return { input, output, description: input.replace(/\s+/g, " ").trim() };
}

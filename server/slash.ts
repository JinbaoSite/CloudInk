import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const builtinDescriptions: Record<string, string> = {
  agents: "Manage and inspect Claude Code agents",
  autocompact: "Configure automatic context compaction",
  batch: "Run a large change in parallel across isolated worktrees",
  clear: "Clear the current conversation",
  "claude-api": "Build applications with the Claude API and Anthropic SDKs",
  color: "Change the current session color",
  compact: "Compact the conversation to free context space",
  config: "Open and manage Claude Code configuration",
  context: "Show current context and token usage",
  "code-review": "Review code changes for correctness and quality",
  dataviz: "Design guidance and fundamentals for Artifacts",
  debug: "Diagnose a problem and identify its root cause",
  "deep-research": "Research a topic deeply across multiple sources",
  doctor: "Check the health of the Claude Code installation",
  effort: "Set the reasoning effort level for the session",
  fast: "Toggle fast mode for the current session",
  "fewer-permission-prompts": "Reduce repeated tool permission prompts safely",
  goal: "Set or inspect the current session goal",
  heapdump: "Capture a heap dump for troubleshooting",
  init: "Initialize a CLAUDE.md file for the current project",
  insights: "Generate insights from recent Claude Code sessions",
  loop: "Repeat a prompt or command on an interval (for example, /loop 5m /foo)",
  mcp: "Manage Model Context Protocol servers",
  model: "Select or inspect the model used by the session",
  recap: "Summarize recent work in the current session",
  "reload-skills": "Reload available Skills and Commands from disk",
  rename: "Rename the current session",
  review: "Review the current workspace changes",
  run: "Run a configured Claude Code workflow",
  "run-skill-generator": "Create a reusable Skill from a task or workflow",
  "security-review": "Review code changes for security vulnerabilities",
  simplify: "Simplify code while preserving its behavior",
  "team-onboarding": "Create onboarding guidance for a project or team",
  "update-config": "Update Claude Code configuration safely",
  usage: "Show plan and usage information",
  verify: "Verify an implementation and its end-to-end behavior",
  "workflow-launch-exec": "Execute a launched Claude Code workflow",
};

const codexBuiltinDescriptions: Record<string, string> = {
  compact: "Compact the current conversation to free context space",
  feedback: "Send feedback about Codex",
  fork: "Fork the current conversation into a new session",
  init: "Create an AGENTS.md file with workspace instructions",
  logout: "Sign out of Codex",
  mcp: "Show configured Model Context Protocol servers",
  model: "Select the model and reasoning effort",
  new: "Start a new conversation",
  permissions: "Change what Codex can do without approval",
  plan: "Switch to plan mode",
  quit: "Exit Codex",
  resume: "Resume a previous conversation",
  review: "Review changes in the current workspace",
  status: "Show the current session configuration and token usage",
};

function unquote(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function metadata(content: string, fallbackName: string) {
  const frontMatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const source = frontMatter?.[1] || content.slice(0, 4_000);
  const name = source.match(/^name:\s*(.+)$/m)?.[1];
  const yamlDescription = source.match(/^description:\s*(.+)$/m)?.[1];
  const tomlDescription = source.match(/^description\s*=\s*(.+)$/m)?.[1];
  return {
    name: unquote(name || fallbackName).replace(/^\//, ""),
    description: unquote(yamlDescription || tomlDescription || ""),
  };
}

function scanDefinitions(
  directory: string,
  descriptions: Map<string, string>,
  discovered?: { commands: Set<string>; skills: Set<string> },
  depth = 0,
) {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanDefinitions(target, descriptions, discovered, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const isSkill = entry.name === "SKILL.md";
    const isCommand =
      [".md", ".toml"].includes(path.extname(entry.name).toLowerCase()) &&
      target
        .split(path.sep)
        .some((part) => part === "commands" || part === "prompts");
    if (!isSkill && !isCommand) continue;
    try {
      const fallbackName = isSkill
        ? path.basename(path.dirname(target))
        : path.basename(entry.name, path.extname(entry.name));
      const parsed = metadata(fs.readFileSync(target, "utf8"), fallbackName);
      if (!parsed.name) continue;
      if (parsed.description) descriptions.set(parsed.name, parsed.description);
      if (isSkill) discovered?.skills.add(parsed.name);
      else discovered?.commands.add(parsed.name);
    } catch {}
  }
}

export function discoverSlashDescriptions(
  workspace: string,
  backend: "claude" | "codex" = "claude",
) {
  const descriptions = new Map(
    Object.entries(
      backend === "codex" ? codexBuiltinDescriptions : builtinDescriptions,
    ),
  );
  if (backend === "codex") {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    scanDefinitions(path.join(codexHome, "plugins"), descriptions);
    scanDefinitions(path.join(codexHome, "prompts"), descriptions);
    scanDefinitions(path.join(codexHome, "commands"), descriptions);
    scanDefinitions(path.join(codexHome, "skills"), descriptions);
    scanDefinitions(path.join(workspace, ".codex", "prompts"), descriptions);
    scanDefinitions(path.join(workspace, ".codex", "commands"), descriptions);
    scanDefinitions(path.join(workspace, ".codex", "skills"), descriptions);
    scanDefinitions(path.join(workspace, ".agents", "skills"), descriptions);
    return descriptions;
  }
  const claudeHome = path.join(os.homedir(), ".claude");
  // Plugin definitions are lower priority than explicit user and project files.
  scanDefinitions(path.join(claudeHome, "plugins"), descriptions);
  scanDefinitions(path.join(claudeHome, "commands"), descriptions);
  scanDefinitions(path.join(claudeHome, "skills"), descriptions);
  scanDefinitions(path.join(workspace, ".claude", "commands"), descriptions);
  scanDefinitions(path.join(workspace, ".claude", "skills"), descriptions);
  return descriptions;
}

export function discoverCodexCapabilities(workspace: string) {
  const descriptions = new Map(Object.entries(codexBuiltinDescriptions));
  const discovered = {
    commands: new Set(Object.keys(codexBuiltinDescriptions)),
    skills: new Set<string>(),
  };
  const codexHome =
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  for (const directory of [
    path.join(codexHome, "plugins"),
    path.join(codexHome, "prompts"),
    path.join(codexHome, "commands"),
    path.join(codexHome, "skills"),
    path.join(workspace, ".codex", "prompts"),
    path.join(workspace, ".codex", "commands"),
    path.join(workspace, ".codex", "skills"),
    path.join(workspace, ".agents", "skills"),
  ])
    scanDefinitions(directory, descriptions, discovered);
  return {
    slashCommands: [...discovered.commands].sort(),
    skills: [...discovered.skills].sort(),
    descriptions,
  };
}

export function descriptionForSlashItem(
  descriptions: Map<string, string>,
  name: string,
  kind: "command" | "skill",
) {
  return (
    descriptions.get(name) ||
    `${name.replace(/[-_]/g, " ")} (${kind === "skill" ? "Skill" : "Command"})`
  );
}

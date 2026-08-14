import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "claude-code-web-ui",
  version: "1.0.0",
});

const apiBaseUrl = process.env.CLOUDINK_API_BASE_URL;
const sessionToken = process.env.CLOUDINK_SESSION_TOKEN;

async function cloudInkApi(path, init) {
  if (!apiBaseUrl || !sessionToken)
    throw new Error("CloudInk 定时任务服务没有提供身份上下文");
  const response = await fetch(`${apiBaseUrl}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${sessionToken}`,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `CloudInk 请求失败（${response.status}）`);
  }
  return response.status === 204 ? null : response.json();
}

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error.message || String(error) }],
  };
}

const taskFields = {
  name: z.string().min(1).max(80),
  prompt: z.string().min(1).max(100000),
  cronExpression: z
    .string()
    .min(5)
    .max(120)
    .describe("Five-part cron: minute hour day-of-month month day-of-week"),
  timezone: z.string().default("Asia/Shanghai"),
  model: z.string().nullable().optional(),
  mode: z.enum(["auto", "plan", "manual", "acceptEdits"]).default("auto"),
  overlapPolicy: z.enum(["skip", "queue"]).default("skip"),
  enabled: z.boolean().default(true),
};

server.registerTool(
  "ask_user",
  {
    title: "Ask the user",
    description:
      "Show one or more structured questions in the Web UI. Use this whenever user input is required before continuing.",
    inputSchema: {
      questions: z
        .array(
          z.object({
            question: z.string().min(1),
            header: z.string().optional(),
            multiSelect: z.boolean().optional().default(false),
            options: z
              .array(
                z.object({
                  label: z.string().min(1),
                  description: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        .min(1)
        .max(4),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async () => ({
    content: [
      {
        type: "text",
        text: "The questions are now visible in the Web UI. Stop this turn and wait for the user's next message containing their submitted answers.",
      },
    ],
  }),
);

server.registerTool(
  "list_scheduled_tasks",
  {
    title: "List CloudInk scheduled tasks",
    description:
      "List the current user's scheduled tasks. Use this to find task IDs before editing, running, pausing, or deleting tasks.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async () => {
    try {
      return toolResult(await cloudInkApi("/scheduled-tasks"));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "create_scheduled_task",
  {
    title: "Create a CloudInk scheduled task",
    description:
      "Create a scheduled task that will appear on CloudInk's 定时 page. Convert the user's schedule into a five-part cron expression. Use Asia/Shanghai unless the user specifies another timezone.",
    inputSchema: taskFields,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (input) => {
    try {
      const result = await cloudInkApi("/scheduled-tasks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return toolResult({
        message: "定时任务已创建，可在 CloudInk 的“定时”页面查看。",
        ...result,
      });
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "update_scheduled_task",
  {
    title: "Update a CloudInk scheduled task",
    description:
      "Update, enable, or pause an existing scheduled task. Omitted fields retain their current values. Call list_scheduled_tasks first if the task ID is unknown.",
    inputSchema: {
      id: z.string().uuid(),
      name: taskFields.name.optional(),
      prompt: taskFields.prompt.optional(),
      cronExpression: taskFields.cronExpression.optional(),
      timezone: z.string().optional(),
      model: z.string().nullable().optional(),
      mode: z.enum(["auto", "plan", "manual", "acceptEdits"]).optional(),
      overlapPolicy: z.enum(["skip", "queue"]).optional(),
      enabled: z.boolean().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ id, ...updates }) => {
    try {
      const tasks = await cloudInkApi("/scheduled-tasks");
      const task = tasks.find((item) => item.id === id);
      if (!task) throw new Error("定时任务不存在");
      const body = {
        name: updates.name ?? task.name,
        prompt: updates.prompt ?? task.prompt,
        cronExpression: updates.cronExpression ?? task.cron_expression,
        timezone: updates.timezone ?? task.timezone,
        model: updates.model === undefined ? task.model : updates.model,
        mode: updates.mode ?? task.permission_mode,
        overlapPolicy: updates.overlapPolicy ?? task.overlap_policy,
        enabled: updates.enabled ?? Boolean(task.enabled),
      };
      const result = await cloudInkApi(`/scheduled-tasks/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return toolResult({ message: "定时任务已更新。", ...result });
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "run_scheduled_task",
  {
    title: "Run a CloudInk scheduled task now",
    description:
      "Queue an existing CloudInk scheduled task for immediate execution. Call list_scheduled_tasks first if the task ID is unknown.",
    inputSchema: { id: z.string().uuid() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ id }) => {
    try {
      const result = await cloudInkApi(`/scheduled-tasks/${id}/run`, {
        method: "POST",
      });
      return toolResult({ message: "任务已加入执行队列。", ...result });
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "delete_scheduled_task",
  {
    title: "Delete a CloudInk scheduled task",
    description:
      "Delete a scheduled task and all of its execution history. Only call after the user explicitly asks to delete it. Call list_scheduled_tasks first if the task ID is unknown.",
    inputSchema: { id: z.string().uuid() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async ({ id }) => {
    try {
      await cloudInkApi(`/scheduled-tasks/${id}`, { method: "DELETE" });
      return toolResult("定时任务及其执行记录已删除。");
    } catch (error) {
      return toolError(error);
    }
  },
);

await server.connect(new StdioServerTransport());

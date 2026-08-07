import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "claude-code-web-ui",
  version: "1.0.0",
});

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

await server.connect(new StdioServerTransport());

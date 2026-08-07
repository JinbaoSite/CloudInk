# Agent 开发指南

本文档用于帮助后续开发代理安全地维护 Claude Code UI。用户使用说明见 `README.md`。

## 核心目标

- 提供接近 Claude Code CLI 和 VS Code 插件的聊天体验。
- 每个用户只能访问自己的会话、消息、附件和工作区。
- 保留 Claude 的流式文本与 Thinking、Read、Bash 等执行过程。
- 桌面端和手机端都必须可用。

## 代码地图

- `src/main.tsx`：认证、会话状态、附件、NDJSON 流读取、自动滚动、执行模式及主要 UI。
- `src/MarkdownMessage.tsx`：Markdown、GFM、延迟数学公式渲染和消息级错误边界。
- `src/styles.css`：应用框架、侧栏、顶部导航和 `700px` 移动端断点。
- `src/chat-layout.css`：滚动区域和用户/助手消息布局。
- `src/composer.css`：固定输入区、附件、Commands、Skills 和 Mode 面板。
- `src/activity.css`：Thinking、工具调用和工具结果。
- `server/index.ts`：认证、会话、消息、附件、执行轮文本分流、断裂会话恢复和 NDJSON API。
- `server/auth.ts`：JWT 签发、Cookie 和鉴权。
- `server/db.ts`：SQLite schema、兼容迁移和用户工作区。
- `server/claude.ts`：Claude CLI 参数、模型与指标、assistant 轮次及 `stream-json` 事件解析。
- `server/claude.test.ts`：Claude 事件解析和工具轮/最终轮分类测试。
- `server/ui-mcp.mjs`：把 Claude 的结构化提问桥接到 Web UI。
- `vite.config.ts`：读取 `WEB_PORT` 和 `PORT`，配置 Web UI 端口及 API 代理。

## 必须保持的约束

### 用户隔离

- 所有 session 查询、读取和删除必须同时匹配 `session.id` 与当前 `user_id`。
- 工作区必须使用 `<WORKSPACE_DIR>/<username>`；未配置时使用 `<DATA_DIR>/workspaces/<username>`，不能回退到所有用户共享的同一个目录。
- 附件路径必须解析到当前用户工作区内，并防止目录穿越。
- 不得将其他用户的邮箱、用户名、会话标题或文件路径返回给当前用户。

### 会话保存

- 点击桌面端“新对话”或手机端右上角 `+` 时，不得立即调用 `POST /api/sessions`。
- 新建操作只重置前端状态。
- 只有首次发送非空消息或附件时才创建会话。
- 空白会话不得出现在历史记录中。
- CLI 首轮使用新的 `--session-id`，后续使用 `--resume`。
- 对断裂会话发送“继续”等短指令时，必须从数据库补充原始问题和最近有效助手回答，忽略 `No response requested.`，使用新的无工具 CLI session，并将新 session ID 写回 Web 会话。

### 聊天与流式输出

- 用户消息位于右侧，助手消息位于左侧，不显示 avatar。
- 输入框固定在聊天区域底部，消息列表独立滚动。
- NDJSON 必须逐行解析，并保留未完成的 buffer。
- `delta` 追加到当前助手消息。
- 不得把一次 CLI 执行中的所有 `text_delta` 无条件拼成最终回答。完整 assistant message 含有 `tool_use` 时，该轮文本属于执行过程，必须用 `replace_answer` 从正文撤回并归入 Thinking；只有终止轮文本可以持久化为助手正文。
- 工具轮分类依赖完整 `assistant` 事件；修改 `--include-partial-messages`、事件顺序或流聚合逻辑时，必须覆盖“过程叙述 + tool_use + 最终回答”的回归测试。
- `activity` 插入助手消息之前，并持久化到数据库。
- Thinking 内容使用与助手正文一致的 Markdown 渲染能力；Read 应直接显示文件路径，Bash 应优先显示 description，工具详情保持折叠的 `IN` / `OUT` 结构。
- `question` 事件必须在输入框上方呈现 Submit answer 面板；提交答案后要继续同一个 Web 会话。
- 助手正文末尾保留复制、重试、耗时和 Token 统计控件；重试应复用对应的用户问题，而不是复制助手答案。
- 回答期间发送按钮必须切换为中止按钮；中止应关闭浏览器流和 Claude 子进程、保留部分输出且不显示为错误。
- 新消息发送后必须定位到最新内容；流式 `delta` 和 `activity` 到达时持续跟随底部。
- 用户主动上滚时应暂停自动跟随，回到底部附近后恢复。
- 流式阶段不得调用 MathJax 修改 React DOM；回答完成后才能统一执行公式排版。
- Markdown 渲染必须有消息级错误边界，单条内容异常时回退为纯文本，不能让应用根节点白屏。

### Claude 权限模式

前后端允许值必须保持一致：

- `auto`
- `plan`
- `manual`
- `acceptEdits`

修改 Mode 时同步检查 UI 文案、图标、Zod schema 和传给 Claude CLI 的 `--permission-mode`。

### 模型探测

- 未配置 `CLAUDE_MODEL` 时，服务启动只执行一次轻量探测并缓存 `system/init.model`。
- 探测必须禁用工具和会话持久化，并设置超时与 `CLI default` 回退。
- 正式聊天返回 `model` 事件时，前端仍应更新显示，以反映 fallback 或运行时模型变化。

### 响应式布局

- `index.html` 必须保留 `width=device-width` 的 viewport 声明。
- 桌面端显示固定历史会话侧栏。
- `max-width: 700px` 时侧栏变为默认关闭的抽屉。
- 手机端左上角汉堡按钮打开历史会话，右上角 `+` 新建本地空白会话。
- 抽屉通过遮罩、关闭按钮、会话选择和新建动作关闭。
- 输入框应考虑 `env(safe-area-inset-bottom)`。
- 桌面侧栏宽度可拖拽调整，并应设置合理的最小、最大宽度；历史会话过多时只能在侧栏内部滚动，不能挤压或破坏聊天布局。

### 工作区文件交互

- 左侧文件目录和输入框 `@` 菜单必须只读取 `/api/workspace/files` 返回的当前用户工作区文件。
- `@` 和 `/` 选择完成后，应在输入内容中高亮对应 token，并把光标恢复到插入内容之后。
- 文件与目录使用单色 Font Awesome 图标；同一种文件在侧栏和 `@` 菜单中应保持图标与对齐方式一致。
- `+` 上传的附件仍必须经过服务端路径校验，不能因为文件已在工作区列表中就绕过安全检查。

## 数据与安全边界

- 密码只允许以 bcrypt hash 保存。
- 登录状态使用 HttpOnly、SameSite Cookie。
- 生产环境必须配置强随机 `JWT_SECRET` 和 HTTPS。
- 上传限制为最多 10 个文件、单文件 20 MB；改变前后端限制时应同步修改。
- `CLAUDE_ALLOWED_TOOLS=Bash` 只是 CLI 权限配置，不提供操作系统沙箱。
- 不受信任的多用户部署需要容器或微虚拟机级隔离。

## 修改流程

1. 先定位对应前端状态、API、数据库和 CLI 层，确认是否需要联动修改。
2. 保留现有数据兼容性；数据库 schema 变更需要提供幂等迁移。
3. 使用 `apply_patch` 编辑文件，并避免覆盖无关改动。
4. 格式化所改文件。
5. 运行构建检查。
6. 涉及 UI 时用桌面和手机视口做真实浏览器验证。

常用检查命令：

```bash
npx prettier --write <changed-files>
npm run build
npm test
```

## UI 验证清单

- 登录与退出是否正常。
- 用户 A 是否无法访问用户 B 的会话 URL。
- 点击“新对话”后历史列表是否没有新增空记录。
- 首次发送内容后会话是否出现并正确生成标题。
- 用户/助手消息是否保持左右布局。
- Markdown、代码块、表格和数学公式是否正常。
- 数学公式密集的流式回答是否保持页面稳定，并在结束后完成排版。
- Thinking、Read、Bash 和执行结果是否按顺序展示。
- 工具调用前的普通文本是否被转入 Thinking，且最终正文不会包含 “Let me fix…” 等过程叙述。
- Thinking 中的 Markdown、工具卡片的描述与 `IN` / `OUT` 是否正常渲染。
- Claude 发起结构化提问时，Submit answer 是否弹出并能成功继续会话。
- 回答后的复制、重试、耗时和 Token 数据是否对应正确消息。
- 发送消息和流式回答时是否跟随底部，手动上滚时是否停止抢占位置。
- 中止回答后是否停止增长、保留部分内容并恢复发送按钮。
- 断裂会话输入“继续”时是否能恢复内容且不返回 `No response requested.`。
- Commands、Skills、Mode 面板是否位于输入框上方且不遮挡输入。
- 输入 `/`、`@` 的菜单选择、点击外部关闭及选择后的光标位置是否正确。
- 历史会话过多时侧栏是否独立滚动，拖拽调整宽度是否不会破坏聊天区域。
- 附件是否只能来自当前用户工作区。
- 手机端汉堡菜单、抽屉遮罩、右上角新建和底部输入框是否正常。

## 文档同步

以下变更完成后必须同步更新 `README.md` 和本文件：

- 环境变量、启动命令或端口
- API 路径或 NDJSON 事件格式
- 数据库 schema 或工作区路径
- Claude CLI 参数、工具权限或执行模式
- 上传限制、认证方式或安全模型
- 桌面/手机端核心交互

# Agent 开发指南

本文档用于帮助后续开发代理安全地维护 CloudInk。用户使用说明见 `README.md`。

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
- 每个已保存会话使用 `/sessions/:sessionId` 地址。首次发送、历史切换、刷新、前进/后退、删除当前会话和新对话操作都必须同步 URL 与 `active` 状态。
- 历史会话标题应使用真实 `<a href>`，同时由 History API 做无刷新切换；直接访问无权或不存在的会话时回到 `/` 并显示错误，不能泄露其他用户信息。
- CLI 首轮使用新的 `--session-id`，后续使用 `--resume`。
- 对断裂会话发送“继续”等短指令时，必须从数据库补充原始问题和最近有效助手回答，忽略 `No response requested.`，使用新的无工具 CLI session，并将新 session ID 写回 Web 会话。

### 聊天与流式输出

- 用户消息位于右侧，助手消息位于左侧，不显示 avatar。
- 输入框固定在聊天区域底部，消息列表独立滚动。
- 输入框使用普通 Enter 发送；`Ctrl+Enter` 和 `Shift+Enter` 必须插入换行，输入法仍在组合文字时不得误发送。
- NDJSON 必须逐行解析，并保留未完成的 buffer。
- `delta` 追加到当前助手消息。
- 不得把一次 CLI 执行中的所有 `text_delta` 无条件拼成最终回答。完整 assistant message 含有 `tool_use` 时，该轮文本属于执行过程，必须用 `replace_answer` 从正文撤回并归入 Thinking；只有终止轮文本可以持久化为助手正文。
- 工具轮分类依赖完整 `assistant` 事件；修改 `--include-partial-messages`、事件顺序或流聚合逻辑时，必须覆盖“过程叙述 + tool_use + 最终回答”的回归测试。
- `activity` 插入助手消息之前，并持久化到数据库。
- Thinking 内容使用与助手正文一致的 Markdown 渲染能力；Read 应直接显示文件路径，Bash 应优先显示 description，工具详情保持折叠的 `IN` / `OUT` 结构。
- `thinking_delta` 必须实时合并到同一条 Thinking activity 并持续更新，而不是等完整 assistant 事件后才显示或为每个 delta 新建消息。
- Claude 在工具调用前输出的普通 text narration 和子 Agent 文本必须使用独立 `narration` activity，像助手过程文字一样直接打印；不得归类为 Thinking，也不得拼入最终正文。Thinking、Read、Bash 等活动卡片继续默认折叠。
- narration 的实时事件和历史消息都必须重排到其对应的连续工具卡片之前，保持“过程说明 → 工具调用”的语义顺序。
- 带 `parent_tool_use_id` 的子 Agent `text_delta` 不能拼入最终助手正文；子 Agent 的完整 text block 必须作为可渲染 Markdown 的 Agent activity 展示和持久化。
- `question` 事件必须在输入框上方呈现 Submit answer 面板；提交答案后要继续同一个 Web 会话。
- 助手正文末尾保留复制、重试、耗时和 Token 统计控件；重试应复用对应的用户问题，而不是复制助手答案。
- 回答期间发送按钮必须切换为中止按钮；中止应关闭浏览器流和 Claude 子进程、保留部分输出且不显示为错误。
- 新消息发送后必须定位到最新内容；流式 `delta` 和 `activity` 到达时持续跟随底部。
- 用户主动上滚时应暂停自动跟随，回到底部附近后恢复。
- `.messages` 只允许纵向滚动；长链接、代码、表格、图片和工具内容必须在自身边界内换行或局部滚动，不得让整个对话区域出现横向滚动条。
- 流式阶段不得调用 MathJax 修改 React DOM；回答完成后才能统一执行公式排版。
- Markdown 围栏代码块使用 `rehype-highlight` 高亮：优先采用代码围栏声明的语言，未声明时自动检测，未知语言安全回退为普通代码；行内代码不得套用块级高亮样式。
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
- 桌面侧栏使用 Font Awesome 面板图标收起和展开，并持久化用户偏好；收起后必须保留可访问的展开按钮，且不能影响手机端抽屉。手机端打开和关闭也必须使用图标，不能回退为字符符号。
- 右侧 `.messages` 滚动条保持细且低对比度，只增强悬停状态；不要让其样式覆盖左侧历史会话和文件目录滚动条。

### 工作区文件交互

- 左侧文件目录和输入框 `@` 菜单必须只读取 `/api/workspace/files` 返回的当前用户工作区文件。
- `@` 和 `/` 选择完成后，应在输入内容中高亮对应 token，并把光标恢复到插入内容之后。
- `/` 菜单数据必须来自 `/api/slash-items` 动态发现。后端以当前用户工作区启动轻量 Claude CLI，读取 `system/init` 的 `slash_commands` 和 `skills`；不得再次把完整清单硬编码到前端。
- Commands/Skills 的 description 优先读取项目、用户和插件定义中的 YAML front matter 或 TOML 字段；工作区定义优先级最高。CLI 内置项使用对应的内置说明，不得返回“自动发现的 Skill/Command”等统一占位文案。
- 动态发现应在收到 `system/init` 后立即终止探测进程，并使用短时、按工作区隔离的缓存，避免为了刷新菜单完成一次模型回答或跨用户复用项目级 Skills。
- 文件与目录使用单色 Font Awesome 图标；同一种文件在侧栏和 `@` 菜单中应保持图标与对齐方式一致。
- `+` 上传的附件仍必须经过服务端路径校验，不能因为文件已在工作区列表中就绕过安全检查。
- 点击侧栏文件后在中间 Workspace 打开；多个文件使用标签页切换，编辑内容在切换时不能丢失，`Ctrl/Cmd+S` 和保存按钮必须写回当前用户工作区。
- Workspace 编辑器使用 CodeMirror；语言解析器必须按当前文件类型动态加载，支持常见前端、Python、Markdown、JSON、SQL 和 YAML 高亮，未知文本安全回退为无语法模式，不能把全部语言包加入聊天首屏。
- Workspace 中的 Markdown 文件默认进入预览模式，并可切换到 CodeMirror 源码编辑；预览复用统一 Markdown 渲染器，必须保留 GFM、代码高亮与 MathJax 支持。
- Workspace 中的 HTML 文件默认使用 sandbox iframe 预览并可切换源码编辑；未保存内容通过 `srcDoc` 实时预览，相对资源必须经当前用户鉴权的工作区预览路由加载，且不得允许 iframe 继承 Web UI 同源权限。
- 没有打开文件时中间 Workspace 不得占位；打开文件后桌面端保持“侧栏 / Workspace / 对话”三栏，窄屏以 Workspace 为主并保留打开侧栏和返回对话的入口。
- 文件读取与保存 API 只能处理当前用户工作区内已有的普通文本文件，必须同时防御 `..`、绝对路径、父目录符号链接、文件符号链接、二进制内容和编辑大小上限。
- Workspace 与 Chat 之间的分隔条可以拖拽并持久化宽度；窄屏下必须隐藏分隔条，不能造成横向溢出。
- 文件右键菜单的重命名、删除、剪切、复制、粘贴、下载、新建及上传操作必须刷新目录；文件管理操作不得使用浏览器 prompt/confirm 弹窗，外部文件拖入文件区域时上传到当前用户工作区，不能加入聊天附件列表。
- 文件与文件夹的 Rename、New File 和 New Folder 必须在文件树内显示可编辑命名行，并提供可见的保存/取消按钮；`Enter` 确认、`Esc` 取消。名称操作不得依赖失焦自动提交，也不得在请求完成前清除编辑状态；失败时必须在命名行下方展示原因并保留输入内容。右击文件夹创建时，输入行必须渲染在该目录节点内，后端目标路径必须是该目录的直接子项。
- Rename 必须使用独立于 New File/New Folder 的 saving/error 状态，并通过 `POST /api/workspace/rename` 单次提交 `{ path, name, kind }`；不得用自动重试掩盖网络错误或与创建操作共享命名状态。
- 文件夹 Delete 会递归删除其全部内容；后端必须先校验目标属于当前用户工作区且不是符号链接，前端必须关闭该目录下的编辑器标签并清理指向该目录的剪贴板状态。
- 桌面端打开 Workspace 时，未保存过自定义宽度的 Sidebar、Workspace、Chat 必须按 `15% / 60% / 25%` 初始化；拖拽宽度继续持久化，双击分隔线恢复对应默认比例。侧栏用户信息使用用户名首字符图标和用户名，不显示 `@username`。
- 桌面端 Sidebar 收起后必须保留 56px 图标轨道，轨道内提供展开、新对话、对话、文件及用户首字符入口；不得把桌面端展开按钮放入 Chat header。移动端继续使用完整侧栏抽屉，不应用图标轨道布局。
- 产品品牌名通过 `.env` 的 `APP_NAME` 配置，默认值为 `CloudInk`；登录页、侧边栏和浏览器标题必须统一使用 `/api/public-config` 返回的品牌名，不得在前端写死。
- Commands/Skills 菜单不得包含前端硬编码默认项，也不得复用后端缓存列表；每次打开菜单必须先清空旧项并展示扫描状态，只渲染当次 `/api/slash-items` 动态扫描返回的内容。
- `/` Commands/Skills 与 `@` 文件菜单必须支持键盘上下循环选择、Enter 确认和 Esc 关闭；键盘高亮与鼠标 hover 使用同一索引，并自动滚动到可见区域，不能让 Enter 在菜单有候选项时提交消息。
- 会话收藏状态存储在 `sessions.favorite`，通过 `POST /api/sessions/:id/favorite` 更新；所有收藏和删除操作必须同时校验 `session id + 当前 user_id`。历史列表按收藏优先、更新时间倒序排列；前端收藏必须乐观更新、请求中锁定，失败时回滚并显示错误。
- Cut/Copy 状态必须在源文件上可见；Paste 的目标目录来自右键位置，Cut 成功后必须同步已打开标签和 active path。同目录 Cut 是清除剪切状态的无操作，不能生成 `-copy-*` 文件。
- 文件树外部拖放必须按落点解析上传目录：文件夹节点使用自身路径，文件使用父目录，空白使用根目录；子节点必须阻止 drop 继续冒泡到根目录，并显示当前目标目录。
- `.html`/`.htm` 普通文件可单页发布；包含普通 `index.html` 的文件夹可发布为静态网站，并按原目录提供 HTML、CSS、JavaScript、图片和字体。单页公开地址为 `/<username>/published/<workspace-relative-page.html>?token=<48位token>`，文件夹首页必须为 `/<username>/published/<workspace-relative-folder>/?token=<48位token>` 并自动读取 `index.html`；缺少末尾斜杠时必须保留 token 重定向到规范地址。对外 HTML 必须是全屏 CSP 沙箱容器，并通过内部 token-in-path iframe 加载实际页面，使相对资源首次访问即可工作且用户 HTML 不能继承 Web UI 登录源权限；旧 token-in-path 地址继续兼容。
- Vite 开发服务器必须忽略 `DATA_DIR` 和 `WORKSPACE_DIR` 中的运行时文件，用户或 Claude 编辑工作区时不得触发 Web UI 整页刷新。文件目录请求不得等待发布状态查询或 CodeMirror 模块；编辑器仅在文件标签 hover 时预取，或在目录完成首屏渲染后延迟预载。通用 API 只允许对幂等 GET 请求进行短暂网络重试，禁止自动重放写操作。

## 数据与安全边界

- 密码只允许以 bcrypt hash 保存。
- 登录状态使用 HttpOnly、SameSite Cookie。
- 生产环境必须配置强随机 `JWT_SECRET` 和 HTTPS。
- 上传支持点击选择、拖拽文件/图片及粘贴剪贴板截图；限制为最多 10 个文件、单文件 500 MB。改变限制时必须同步修改前端预检、Multer 配置、错误文案和 README。
- 大文件必须由 Multer 直接流式写入当前用户工作区根目录，不得使用 `memoryStorage` 将整个文件缓存在 Node.js 堆中。聊天区点击选择、拖拽和粘贴截图三种上传入口必须使用同一规则；文件树上传仍按落点目录写入。
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
- 切换会话后 URL 是否更新，刷新和浏览器前进/后退是否恢复对应会话。
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
- 普通 Enter 是否发送，`Ctrl+Enter` / `Shift+Enter` 是否换行；侧栏收起后是否可以重新展开。
- 附件是否只能来自当前用户工作区。
- 点击、拖拽文件/图片和粘贴截图是否都能上传，拖拽遮罩是否正确出现和消失。
- 手机端汉堡菜单、抽屉遮罩、右上角新建和底部输入框是否正常。
- 点击文件是否展开 Workspace，多标签切换是否保留修改，保存、未保存关闭确认和 `Ctrl/Cmd+S` 是否正常；关闭最后一个文件后对话区是否恢复完整宽度。
- 不同文件类型是否显示行号和正确语法高亮，切换标签时语言模式是否同步变化，未知文本是否仍可编辑。
- Workspace/Chat 分隔条是否可拖拽且刷新后保留；文件与空白区域右键菜单、剪切复制粘贴、新建、下载和文件区拖拽上传是否正常。

## 文档同步

以下变更完成后必须同步更新 `README.md` 和本文件：

- 环境变量、启动命令或端口
- API 路径或 NDJSON 事件格式
- 数据库 schema 或工作区路径
- Claude CLI 参数、工具权限或执行模式
- 上传限制、认证方式或安全模型
- 桌面/手机端核心交互

# Claude Code UI（多用户版）

一个基于 React、Express、SQLite 和 Claude Code CLI 的多用户 Web UI。界面采用类似 Claude Code VS Code 插件的交互方式，支持流式对话、执行过程展示、工具调用、Markdown、数学公式、附件和多种执行模式。

## 功能

- 邮箱、用户名和密码注册登录
- 用户之间的会话、消息和工作区相互隔离
- Claude Code CLI 会话续接
- NDJSON 流式响应
- 回答过程中可强制中止，并保留已经输出的内容
- 发送消息和流式回答时自动跟随最新内容，手动上滚时暂停跟随
- Markdown、GFM 和 MathJax 数学公式渲染
- 中断会话支持通过“继续”恢复已保存的部分回答
- 展示 Thinking、Read、Bash、工具输入及执行结果
- 工具调用前的过程叙述会归入 Thinking，只有最终 `end_turn` 内容作为回答正文
- Thinking 支持 Markdown；工具卡片展示描述及折叠的 `IN` / `OUT` 内容
- Claude 需要用户确认时，在输入框上方展示 Submit answer 交互面板
- 助手回答支持复制、重试，并展示耗时和 Token 消耗
- 输入框底部展示 Claude CLI 实际使用的模型
- `Auto`、`Plan`、`Manual`、`Edit automatically` 执行模式
- `/` 命令与 Skills 选择面板
- `@` 工作区文件选择和文件引用
- 最多上传 10 个附件，单个文件最大 20 MB
- 桌面端历史会话与文件目录侧栏，支持拖拽调整宽度
- 手机端顶部导航和抽屉式历史会话
- 空白新对话不会写入历史记录，首次发送内容时才创建会话

## 技术栈

- 前端：React、TypeScript、Vite
- 后端：Express、TypeScript
- 数据库：SQLite（`better-sqlite3`）
- 身份认证：JWT HttpOnly Cookie、bcrypt
- AI 运行时：Claude Code CLI `stream-json`
- 内容渲染：`react-markdown`、GFM、MathJax

## 环境要求

- Node.js 20 或更高版本
- npm
- 已安装并完成认证的 Claude Code CLI

先确认 CLI 可以正常运行：

```bash
claude --version
claude
```

## 本地启动

```bash
npm install
cp .env.example .env
npm run dev
```

开发服务：

- Web UI：<http://localhost:5173>
- API：<http://localhost:3001>

Vite 会将 `/api` 代理到 Express 服务。修改 `.env` 中的 `WEB_PORT` 后，Web UI 地址中的端口会同步变化；修改 `PORT` 后，Vite 的 API 代理目标也会同步变化。

## 环境变量

```dotenv
PORT=3001
WEB_PORT=5173
JWT_SECRET=replace-with-at-least-32-random-characters
CLAUDE_CLI_PATH=claude
CLAUDE_ALLOWED_TOOLS=Bash
WORKSPACE_DIR=/absolute/path/to/workspaces
# CLAUDE_MODEL=sonnet
# DATA_DIR=data
```

| 变量                   | 说明                                      | 默认值                  |
| ---------------------- | ----------------------------------------- | ----------------------- |
| `PORT`                 | Express 服务端口                          | `3001`                  |
| `WEB_PORT`             | Vite Web UI 开发端口                      | `5173`                  |
| `JWT_SECRET`           | 登录 Cookie 的 JWT 密钥，生产环境必须替换 | 开发占位值              |
| `CLAUDE_CLI_PATH`      | Claude CLI 命令或绝对路径                 | `claude`                |
| `CLAUDE_ALLOWED_TOOLS` | 自动允许的 Claude 工具                    | `Bash`                  |
| `WORKSPACE_DIR`        | 所有用户工作区的根目录                    | `<DATA_DIR>/workspaces` |
| `CLAUDE_MODEL`         | 可选的 Claude 模型                        | CLI 默认模型            |
| `DATA_DIR`             | SQLite 数据目录                           | `data`                  |

## 生产运行

```bash
npm run build
NODE_ENV=production npm start
```

生产模式下 Express 会同时提供 `dist` 静态文件和 API。应使用 HTTPS 反向代理访问，否则设置为 `secure` 的登录 Cookie 不会通过普通 HTTP 发送。

## 数据与工作区

默认数据结构：

```text
data/
├── app.db
├── app.db-shm
├── app.db-wal
└── workspaces/
    └── <username>/
        └── uploads/
```

每个用户的 Claude 工作目录是：

```text
<WORKSPACE_DIR>/<username>
```

例如配置 `WORKSPACE_DIR=/srv/claude-workspaces` 后，用户 `jinbao` 的工作区为 `/srv/claude-workspaces/jinbao`。建议使用绝对路径，并确保运行服务的系统账号拥有该目录的读写权限。

修改 `WORKSPACE_DIR` 不会自动搬迁旧工作区。已有项目需要先停止服务，将原工作区文件移动到新的用户目录后再启动。

未配置 `CLAUDE_MODEL` 时，服务启动会执行一次无工具、无会话持久化的轻量 Claude 请求，从 `system/init` 事件中获取并缓存 CLI 实际模型。该探测可能产生少量额度消耗；失败或超时后界面显示 `CLI default`，正式对话仍会根据运行事件更新模型名称。

数据库关系为 `users → sessions → messages`。所有会话和消息接口都会同时校验当前登录用户，不能仅凭会话 ID 跨用户读取或删除数据。每个 Web 会话还对应独立的 Claude CLI session ID，首轮使用 `--session-id`，后续使用 `--resume`。

## 会话生命周期

1. 点击“新对话”只清空当前前端状态，不写入数据库。
2. 用户首次发送消息或附件时创建数据库会话。
3. 首条内容生成历史会话标题。
4. 后续消息通常使用同一个 Claude CLI session ID 进行 `--resume`。
5. Thinking、工具调用、工具结果和最终回答都会持久化。
6. 如果 CLI session 在回答中途断裂，发送“继续”时会从数据库补齐原始问题和最近有效回答，创建新的无工具 CLI session 继续生成。

Claude 在一次 CLI 请求中可能产生多轮 assistant message：带 `tool_use` 的轮次属于执行过程，以 `end_turn` 结束的最后一轮才是正式回答。服务端会先实时转发文本；当完整事件确认该轮调用了工具时，通过 `replace_answer` 从正文撤回该轮文本，并将其作为 Thinking 活动保存。这样既保留流式反馈，也不会把 “Let me fix…” 等执行叙述混入最终答案。

## 流式交互行为

- 用户发送消息时，消息区域立即定位到最新内容。
- `delta`、Thinking 和工具事件到达时持续跟随底部。
- 用户主动向上滚动时暂停自动跟随，回到底部附近后恢复。
- 回答期间发送按钮切换为中止按钮；中止会关闭响应流和 Claude 子进程，并保留已经生成的部分文本。
- 中止按钮使用持续旋转的状态动画表示 Claude 仍在运行。
- 工具执行轮的临时文本会被重新归类为 Thinking；最终回答仍通过 `delta` 实时追加。
- MathJax 在流式阶段不直接修改 React DOM，只在回答结束后统一排版公式。
- Markdown 渲染异常时仅将对应消息回退为纯文本，不会让整个页面白屏。

## API 概览

| 方法     | 路径                         | 用途                   |
| -------- | ---------------------------- | ---------------------- |
| `POST`   | `/api/auth/register`         | 注册并登录             |
| `POST`   | `/api/auth/login`            | 登录                   |
| `POST`   | `/api/auth/logout`           | 退出登录               |
| `GET`    | `/api/me`                    | 当前用户               |
| `GET`    | `/api/config`                | 当前 Claude 模型配置   |
| `GET`    | `/api/workspace/files`       | 当前用户的工作区文件   |
| `GET`    | `/api/sessions`              | 当前用户的历史会话     |
| `POST`   | `/api/sessions`              | 创建会话               |
| `GET`    | `/api/sessions/:id/messages` | 获取会话消息           |
| `POST`   | `/api/sessions/:id/messages` | 发送消息并流式返回结果 |
| `DELETE` | `/api/sessions/:id`          | 删除会话               |
| `POST`   | `/api/files`                 | 上传附件               |

消息接口返回 `application/x-ndjson`，主要事件类型如下：

| 事件             | 用途                                         |
| ---------------- | -------------------------------------------- |
| `delta`          | 追加当前候选回答文本                         |
| `replace_answer` | 工具轮结束后撤回过程叙述，只保留已确认的正文 |
| `activity`       | Thinking、工具调用和工具结果                 |
| `question`       | Claude 请求用户提交结构化答案                |
| `model`          | 当前 CLI 实际模型                            |
| `metrics`        | 回答耗时及输入、输出、缓存 Token 统计        |
| `done` / `error` | 流正常结束或异常结束                         |

## 常用命令

```bash
npm run dev       # 同时启动前端和后端开发服务
npm run dev:web   # 仅启动 Vite
npm run dev:server # 仅启动 Express
npm run build     # TypeScript 检查并构建前端
npm start         # 启动生产服务
npm test          # 运行 Node 测试
```

## 安全说明

当前的“用户隔离”是应用层数据与目录隔离，不是操作系统级沙箱。Claude Code 可以通过 Bash 运行命令，理论上能够访问运行服务账号有权限访问的其他路径。

公网或不受信任的多用户部署还应增加：

- 每用户独立容器或微虚拟机
- HTTPS、限流和 CSRF 防护
- 命令、路径和网络访问策略
- 上传文件扫描与存储配额
- 操作审计、日志轮换和数据库备份

## 项目结构

```text
src/
├── main.tsx             # 页面、认证、会话、流式聊天、自动滚动和移动端交互
├── MarkdownMessage.tsx  # Markdown、延迟 MathJax 渲染和错误回退
├── styles.css           # 基础、侧栏和响应式布局
├── chat-layout.css      # 消息区域与左右布局
├── composer.css         # 输入框、模式及命令面板
├── activity.css         # Claude 执行过程样式
└── markdown.css         # Markdown 内容样式
server/
├── index.ts             # API、上传、流式分流、问题提交和中断会话恢复
├── auth.ts              # JWT Cookie 与鉴权中间件
├── db.ts                # SQLite schema、迁移和工作区初始化
├── claude.ts            # Claude CLI 启动、模型探测和事件解析
├── claude.test.ts       # 事件解析、工具轮分流和指标测试
└── ui-mcp.mjs           # 非交互 CLI 向 Web UI 请求用户答案的 MCP 服务
```

## 验证

提交修改前至少运行：

```bash
npm test
npm run build
```

涉及页面布局或交互时，建议分别使用桌面视口和约 `390 × 844` 的手机视口检查登录、会话抽屉、消息发送和输入框布局。

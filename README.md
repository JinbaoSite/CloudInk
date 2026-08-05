# Claude Code UI（多用户版）

一个基于 React、Express、SQLite 和 Claude Code CLI 的多用户 Web UI。界面采用类似 Claude Code VS Code 插件的交互方式，支持流式对话、执行过程展示、工具调用、Markdown、数学公式、附件和多种执行模式。

## 功能

- 邮箱、用户名和密码注册登录
- 用户之间的会话、消息和工作区相互隔离
- Claude Code CLI 会话续接
- NDJSON 流式响应
- Markdown、GFM 和 MathJax 数学公式渲染
- 展示 Thinking、Read、Bash、工具输入及执行结果
- `Auto`、`Plan`、`Manual`、`Edit automatically` 执行模式
- `/` 命令与 Skills 选择面板
- 最多上传 10 个附件，单个文件最大 20 MB
- 桌面端历史会话侧栏
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

数据库关系为 `users → sessions → messages`。所有会话和消息接口都会同时校验当前登录用户，不能仅凭会话 ID 跨用户读取或删除数据。每个 Web 会话还对应独立的 Claude CLI session ID，首轮使用 `--session-id`，后续使用 `--resume`。

## 会话生命周期

1. 点击“新对话”只清空当前前端状态，不写入数据库。
2. 用户首次发送消息或附件时创建数据库会话。
3. 首条内容生成历史会话标题。
4. 后续消息继续使用同一个 Claude CLI session ID。
5. Thinking、工具调用、工具结果和最终回答都会持久化。

## API 概览

| 方法     | 路径                         | 用途                   |
| -------- | ---------------------------- | ---------------------- |
| `POST`   | `/api/auth/register`         | 注册并登录             |
| `POST`   | `/api/auth/login`            | 登录                   |
| `POST`   | `/api/auth/logout`           | 退出登录               |
| `GET`    | `/api/me`                    | 当前用户               |
| `GET`    | `/api/sessions`              | 当前用户的历史会话     |
| `POST`   | `/api/sessions`              | 创建会话               |
| `GET`    | `/api/sessions/:id/messages` | 获取会话消息           |
| `POST`   | `/api/sessions/:id/messages` | 发送消息并流式返回结果 |
| `DELETE` | `/api/sessions/:id`          | 删除会话               |
| `POST`   | `/api/files`                 | 上传附件               |

消息接口返回 `application/x-ndjson`，事件类型包括 `delta`、`activity`、`done` 和 `error`。

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
├── main.tsx             # 页面、认证、会话、流式聊天和移动端交互
├── MarkdownMessage.tsx  # Markdown 与数学公式渲染
├── styles.css           # 基础、侧栏和响应式布局
├── chat-layout.css      # 消息区域与左右布局
├── composer.css         # 输入框、模式及命令面板
├── activity.css         # Claude 执行过程样式
└── markdown.css         # Markdown 内容样式
server/
├── index.ts             # API、上传和流式响应
├── auth.ts              # JWT Cookie 与鉴权中间件
├── db.ts                # SQLite schema、迁移和工作区初始化
└── claude.ts            # Claude CLI 启动和事件解析
```

## 验证

提交修改前至少运行：

```bash
npm run build
```

涉及页面布局或交互时，建议分别使用桌面视口和约 `390 × 844` 的手机视口检查登录、会话抽屉、消息发送和输入框布局。

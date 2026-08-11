<h1 align="center">CloudInk</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  面向团队和个人的多用户 Claude Code Web 客户端<br />
  在浏览器中获得接近 Claude Code CLI 与 VS Code 插件的完整 Agent 体验
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square" />
  <img alt="React" src="https://img.shields.io/badge/React-TypeScript-3178c6?style=flat-square" />
  <img alt="Claude Code CLI" src="https://img.shields.io/badge/Runtime-Claude_Code_CLI-c15f3c?style=flat-square" />
  <img alt="Multi-user" src="https://img.shields.io/badge/Mode-Multi--user-5f5a52?style=flat-square" />
</p>

![CloudInk 桌面端界面](docs/images/desktop-ui.png)

CloudInk 是一个基于 React、Express、SQLite 和 Claude Code CLI 的多用户 AI 工作空间。它不仅展示最终回复，还会实时呈现 Thinking、Read、Bash、Agent、Skill 等执行过程，并为每位用户隔离会话、消息和工作区。

## 为什么选择它

- **真实 Claude Code 体验**：直接驱动本机 Claude Code CLI，支持会话续接、工具调用和执行模式。
- **完整执行过程**：分开展示 Thinking、工具描述、输入与输出，最终正文不会混入工具轮的过程叙述。
- **多用户隔离**：用户拥有独立的登录身份、聊天记录、CLI session 和工作区目录。
- **面向实际使用**：支持流式输出、中止、重试、附件、文件引用、Markdown、MathJax 和响应式布局。
- **可刷新、可分享的会话地址**：每个会话拥有独立 URL，刷新或浏览器前进/后退不会丢失当前位置。

## 核心功能

### 对话与 Agent 执行

- NDJSON 实时流式回复，可随时强制中止并保留已生成内容。
- Claude 在工具调用前输出的过程说明会直接打印在对应工具之前，子 Agent 中间文本也会进入对话流；Thinking、Read、Write、Edit、Bash、Skill 和工具结果按执行顺序展示。
- 工具卡片直接显示文件路径或 Bash description，详情中展示折叠的 `IN` / `OUT`。
- 工具调用轮文本自动归入 Thinking，只有最终回答保存为助手正文。
- Claude 需要确认时，在输入框上方显示 Submit answer 面板。
- 回答支持复制、重试、耗时及输入/输出/缓存 Token 统计。
- 中断后的会话可以通过“继续”恢复，避免返回 `No response requested.`。

### 输入与内容

- Markdown、GFM、自动语言识别的代码语法高亮和 MathJax 数学公式渲染。
- `Auto`、`Plan`、`Manual`、`Edit automatically` 四种执行模式。
- `/` 菜单动态读取 Claude CLI、用户配置、插件和工作区中的 Commands/Skills 及真实 description。
- `@` 搜索并引用当前用户工作区文件。
- 点击、拖拽或粘贴剪贴板截图上传附件；新附件直接保存到当前用户的工作区根目录，每条消息最多 10 个文件，单文件最大 500MB。
- 普通 `Enter` 发送，`Ctrl+Enter` 或 `Shift+Enter` 换行。

### 会话与工作区

- 邮箱、用户名和密码注册登录，密码使用 bcrypt 哈希保存。
- 用户之间的会话、消息、附件和工作区相互隔离。
- 会话地址为 `/sessions/:sessionId`，支持刷新恢复和 History API 导航。
- 历史会话支持收藏置顶、取消收藏和删除；收藏状态按用户持久化，刷新或重新登录后仍然保留。
- 新对话仅在首次发送真实内容时写入历史记录，不产生空白会话。
- 侧边栏可切换历史记录与文件目录，支持拖拽调宽；桌面端收起后保留 56px 图标栏，可从栏内展开或直接切换对话/文件，移动端仍使用抽屉。
- 点击文件可展开类似 VS Code 的中间 Workspace；CodeMirror 根据文件类型提供代码高亮、行号、括号匹配、折叠与自动补全，并支持多标签编辑、未保存状态提示、标签关闭，以及按钮或 `Ctrl/Cmd+S` 保存。没有打开文件时 Workspace 自动隐藏，对话区域恢复完整宽度。
- 桌面端首次打开 Workspace 时，侧边栏、Workspace、Chat 默认按 `15% / 60% / 25%` 分配宽度，仍可拖拽分隔线调整；双击分隔线可恢复默认比例。文件区域支持右键打开、重命名、删除、剪切、复制、粘贴、下载和新建文件；文件夹右键 Delete 会递归删除其中的所有文件和子目录，并关闭该目录下已经打开的编辑器标签。文件与文件夹的 Rename、New File 和 New Folder 都在文件树中直接内联命名，提供 ✓ 保存和 × 取消，也支持 `Enter` 确认、`Esc` 取消，不使用浏览器弹窗。Rename 使用独立状态和专用接口，提交期间会锁定当前命名行，成功后按服务端返回路径刷新文件树，失败则保留输入并在原位展示原因。右击文件夹后创建的文件或文件夹会放入该目录，空白区域也支持粘贴及上传，并可直接拖入文件上传。
- Cut/Copy 会在源文件上显示状态，Paste 到目录后自动刷新文件树；Cut 同时同步已打开标签的新路径。外部文件拖到文件夹节点时上传到该文件夹，拖到文件时上传到其所在目录，拖到空白处则上传到工作区根目录。
- HTML 文件支持通过右键菜单发布为公开网页；包含 `index.html` 的文件夹也可发布为完整静态网站，目录内的 HTML、CSS、JavaScript、图片和字体按原相对路径访问。单页地址格式为 `/<username>/published/<page.html>?token=<token>`，文件夹首页使用 `/<username>/published/<folder>/?token=<token>`，无需在 URL 中写 `index.html`；已发布页面可以打开、复制链接或取消发布。公开页面无需登录，始终读取工作区文件的最新内容，并使用浏览器沙箱与登录态隔离。
- 实际 Claude 工作目录为 `<WORKSPACE_DIR>/<username>`。

### 响应式体验

桌面端提供完整的历史会话、文件目录和可调节侧边栏；手机端使用顶部导航、抽屉式历史记录和适配安全区域的底部输入框。

<p align="center">
  <img src="docs/images/mobile-ui.jpg" alt="CloudInk 手机端界面" width="360" />
</p>

## 技术架构

| 层级      | 技术                                                    |
| --------- | ------------------------------------------------------- |
| Web       | React、TypeScript、Vite、CodeMirror、Font Awesome       |
| API       | Express、TypeScript、Zod、Multer                        |
| 数据      | SQLite、better-sqlite3                                  |
| 认证      | JWT HttpOnly Cookie、bcrypt                             |
| AI 运行时 | Claude Code CLI、`stream-json`、MCP                     |
| 内容渲染  | react-markdown、remark-gfm、remark-math、rehype-mathjax |

```text
Browser
  ├── React UI ─────────────── NDJSON stream ──────────────┐
  └── HttpOnly session cookie                              │
                                                          ▼
Express API ── SQLite (users / sessions / messages) ── Claude Code CLI
     │                                                     │
     └── <WORKSPACE_DIR>/<username> ◀── Read / Edit / Bash ┘
```

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm
- 已安装并完成认证的 Claude Code CLI

先确认 CLI 可以正常运行：

```bash
claude --version
claude
```

### 安装与启动

```bash
git clone https://github.com/JinbaoSite/CloudInk.git
cd CloudInk
npm install
cp .env.example .env
npm run dev
```

默认地址：

- Web UI：<http://localhost:5173>
- API：<http://localhost:3001>

开发模式下 Vite 会将 `/api` 代理到 Express。首次访问后注册账号即可开始使用。

## 配置

```dotenv
PORT=3001
WEB_PORT=5173
APP_NAME=CloudInk
JWT_SECRET=replace-with-at-least-32-random-characters
CLAUDE_CLI_PATH=claude
CLAUDE_ALLOWED_TOOLS=Bash
WORKSPACE_DIR=/absolute/path/to/workspaces
# CLAUDE_MODEL=sonnet
# DATA_DIR=data
```

| 变量                   | 说明                               | 默认值                  |
| ---------------------- | ---------------------------------- | ----------------------- |
| `PORT`                 | Express API 端口                   | `3001`                  |
| `WEB_PORT`             | Vite Web UI 端口                   | `5173`                  |
| `APP_NAME`             | 登录页、侧边栏与浏览器标题的品牌名 | `CloudInk`              |
| `JWT_SECRET`           | JWT 密钥；生产环境必须使用强随机值 | 开发占位值              |
| `CLAUDE_CLI_PATH`      | Claude CLI 命令或绝对路径          | `claude`                |
| `CLAUDE_ALLOWED_TOOLS` | 自动允许的 Claude 工具             | `Bash`                  |
| `WORKSPACE_DIR`        | 所有用户工作区的根目录             | `<DATA_DIR>/workspaces` |
| `CLAUDE_MODEL`         | 可选的固定 Claude 模型             | CLI 默认模型            |
| `DATA_DIR`             | SQLite 与默认工作区的数据目录      | `data`                  |

修改 `WORKSPACE_DIR` 不会自动迁移已有数据。请先停止服务，将旧工作区移动到新位置并确保运行服务的系统账号拥有读写权限。

## 生产部署

```bash
npm run build
NODE_ENV=production npm start
```

生产模式下 Express 同时提供 `dist` 静态文件和 API。建议使用 Nginx、Caddy 等反向代理：

- 启用 HTTPS；生产 Cookie 设置了 `Secure`，普通 HTTP 下不会发送。
- 将请求体大小和超时设置为能够容纳最长 500MB 的附件上传。
- 保持流式响应不被代理缓冲。
- 配置数据库和用户工作区的持久化存储及备份。

## 数据与会话

默认目录结构：

```text
data/
├── app.db
├── app.db-shm
├── app.db-wal
└── workspaces/
    └── <username>/
        └── <uploaded-files>
```

数据库关系为 `users → sessions → messages`。所有会话与消息查询都会同时校验当前用户。每个 Web 会话还对应一个独立 Claude CLI session ID：首轮使用 `--session-id`，后续使用 `--resume`。

未设置 `CLAUDE_MODEL` 时，服务启动会执行一次无工具、无会话持久化的轻量探测，从 Claude CLI 初始化事件读取实际模型；失败或超时后显示 `CLI default`，正式对话仍会根据运行事件更新模型。

工作区编辑器通过 `GET /api/workspace/file?path=...` 读取文件，通过 `PUT /api/workspace/file` 保存内容；文件管理接口位于 `/api/workspace/entry`、`/api/workspace/rename`、`/api/workspace/paste` 和 `/api/workspace/download`。接口只接受当前登录用户工作区内的路径，在线编辑上限为 5MB；聊天区上传的附件直接写入工作区根目录，文件区上传则按拖放目标目录写入，单文件上限均为 500MB。

网页发布通过 `/api/workspace/publications` 和 `/api/workspace/publish` 管理。单个 HTML 的公开入口为 `/:username/published/:pagePath?token=:token`；文件夹站点入口为 `/:username/published/:folderPath/?token=:token`，服务端自动读取根目录中的 `index.html`。缺少末尾 `/` 时会保留 token 并跳转到规范目录地址，避免相对资源解析错误。页面由全屏沙箱容器加载内部 token 资源路径，因此相对资源无需重复携带 query token，也不存在首次加载竞态。

## 流式事件

`POST /api/sessions/:id/messages` 返回 `application/x-ndjson`：

| 事件             | 用途                                         |
| ---------------- | -------------------------------------------- |
| `delta`          | 追加当前候选回答文本                         |
| `replace_answer` | 工具轮结束后撤回过程叙述，只保留确认后的正文 |
| `activity`       | Thinking、工具调用和工具结果                 |
| `question`       | 请求用户提交结构化答案                       |
| `model`          | 当前 CLI 实际模型                            |
| `metrics`        | 耗时及输入、输出、缓存 Token 统计            |
| `done` / `error` | 流正常结束或异常结束                         |

## 开发

```bash
npm run dev          # 同时启动 Web 与 API
npm run dev:web      # 仅启动 Vite
npm run dev:server   # 仅启动 Express
npm test             # 运行 Node 测试
npm run build        # TypeScript 检查并构建前端
npm start            # 启动生产服务
```

主要目录：

```text
src/                 React 页面、消息渲染、输入区与响应式样式
server/              认证、SQLite、上传、Claude CLI 与流事件解析
docs/images/         README 产品截图
data/                本地数据库和默认用户工作区（运行时生成）
Agent.md             后续开发代理的实现约束与验证清单
```

提交修改前至少运行：

```bash
npm test
npm run build
```

涉及 UI 时还应分别使用桌面视口和约 `390 × 844` 的手机视口验证登录、会话切换、消息发送、侧栏/抽屉和输入框。

## 安全边界

当前多用户能力提供的是**应用层的数据和目录隔离**，不是操作系统级沙箱。Claude Code 的 Bash 工具理论上可以访问运行服务账号有权限读取的其他路径。

面向公网或不受信任用户部署时，建议额外配置：

- 每用户独立容器或微虚拟机
- HTTPS、CSRF 防护、限流和登录风控
- 命令、文件路径与网络访问策略
- 上传文件扫描、磁盘配额和过期清理
- 审计日志、日志轮换与数据库备份

## 项目状态

项目仍处于快速迭代阶段，API、数据库结构和 UI 可能继续调整。升级前请备份 `DATA_DIR` 与 `WORKSPACE_DIR`。

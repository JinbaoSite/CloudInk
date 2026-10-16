import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// Exercise the real HTTP server and bridge without a model call or production data.
test(
  "conversation APIs preserve questions, search identity and user interruptions",
  { timeout: 60000 },
  async (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudink-question-api-"),
    );
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const home = path.join(dir, "codex");
    const cli = path.join(dir, "fake-codex.mjs");
    const password = crypto.randomBytes(18).toString("hex");
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    fs.mkdirSync(home);
    fs.writeFileSync(
      cli,
      `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
if(process.argv.includes('--version')){console.log('codex-test');process.exit(0);}
const emit=v=>console.log(JSON.stringify(v));
const args=process.argv.slice(2),resume=args.includes('resume'),thread=resume?args.at(-2):crypto.randomUUID();
emit({type:'thread.started',thread_id:thread});
const mode=args.at(-1);
if(mode.endsWith('search stream')){for(let n=0;n<2;n++)emit({type:'item.started',item:{type:'web_search',id:'search-1',query:'paper date'}});emit({type:'item.completed',item:{type:'web_search',id:'search-1',query:'paper date'}});emit({type:'item.completed',item:{type:'web_search',id:'search-2',query:'paper date'}});emit({type:'item.completed',item:{type:'agent_message',text:'search finished'}});emit({type:'turn.completed'});process.exit(0);}
if(mode.endsWith('stream interrupt')||mode.endsWith('silent interrupt')){if(mode.endsWith('stream interrupt'))emit({type:'item.completed',item:{type:'agent_message',text:'partial answer'}});setInterval(()=>{},1000);await new Promise(()=>{});}
if(mode.endsWith('failure')){emit({type:'turn.failed',error:{message:'fixture failure'}});process.exit(1);}

if(resume){emit({type:'item.completed',item:{type:'agent_message',text:'已收到用户选择，继续执行。'}});emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});process.exit(0);}
const question={questions:[{title:'只修改推荐算法，还是所有分类？',options:['只修改 recsys/index.md','修改所有分类，非单篇论文文章保留原日期']}]};
let unsafe;const startUnsafe=()=>unsafe=setTimeout(()=>{fs.writeFileSync(path.join(process.cwd(),'continued-without-answer'),'unsafe');emit({type:'turn.completed'});process.exit(0)},5000);
if(args.at(-1).endsWith('ask native')){startUnsafe();
 const logdir=path.join(process.env.CODEX_HOME,'sessions','2026','10','16');fs.mkdirSync(logdir,{recursive:true});
 fs.appendFileSync(path.join(logdir,'rollout-date-'+thread+'.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'function_call',name:'request_user_input_async',call_id:'native-call',arguments:JSON.stringify(question)}})+'\\n');
}else{
 const {Client}=await import(${JSON.stringify(new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js", import.meta.url).href)});
 const {StdioClientTransport}=await import(${JSON.stringify(new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js", import.meta.url).href)});
 const transport=new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(fileURLToPath(new URL("./ui-mcp.mjs", import.meta.url)))}],env:process.env});
 process.on('SIGTERM',()=>{clearTimeout(unsafe);void transport.close().finally(()=>process.exit(0));});
 const client=new Client({name:'question-test',version:'1.0.0'});await client.connect(transport);startUnsafe();
 await client.callTool({name:'ask_user',arguments:{questions:[{question:question.questions[0].title,options:question.questions[0].options.map(label=>({label}))}]}});
}
`,
      { mode: 0o700 },
    );
    const claudeCli = path.join(dir, "fake-claude.mjs");
    fs.writeFileSync(
      claudeCli,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial answer'}}}));setInterval(()=>{},1000);",
      { mode: 0o700 },
    );
    const server = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        cwd: repo,
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: String(port),
          HOST: "127.0.0.1",
          DATA_DIR: path.join(dir, "db"),
          WORKSPACE_DIR: path.join(dir, "workspace"),
          CODEX_HOME: home,
          CODEX_CLI_PATH: cli,
          CLAUDE_MODEL: "test-no-model",
          CLAUDE_CLI_PATH: claudeCli,
          DISABLE_TASK_SCHEDULER: "1",
          ROOT_EMAIL: "root@qa.example.test",
          ROOT_PASSWORD: password,
          JWT_SECRET: crypto.randomBytes(32).toString("hex"),
          COOKIE_SECURE: "false",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const stopped = once(server, "close");
    let startupError = "";
    server.stderr.on("data", (chunk) => {
      startupError = (startupError + chunk).slice(-5000);
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      const startupDeadline = Date.now() + 30000;
      while (Date.now() < startupDeadline && server.exitCode === null) {
        try {
          if ((await fetch(`${base}/api/public-config`)).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, `isolated server failed to start: ${startupError}`);
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "root", password }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const request = (url: string, method = "GET", data?: unknown) =>
        fetch(base + url, {
          method,
          headers: { cookie, "content-type": "application/json" },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
      assert.equal(
        (
          await request("/api/auth/register", "POST", {
            username: "other",
            email: "other@qa.example.test",
            password,
          })
        ).status,
        202,
      );
      const registrations = await (
        await request("/api/admin/registrations")
      ).json();
      const other = registrations.users.find(
        (user: { username: string }) => user.username === "other",
      );
      assert.equal(
        (
          await request(
            `/api/admin/registrations/${other.id}/approve`,
            "POST",
            {},
          )
        ).status,
        200,
      );
      const otherLogin = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "other", password }),
      });
      const otherCookie = otherLogin.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      for (const source of ["native", "mcp"])
        await t.test(source, async () => {
          const session = await (
            await request("/api/sessions", "POST", { backend: "codex" })
          ).json();
          const response = await request(
            `/api/sessions/${session.id}/messages`,
            "POST",
            { content: `ask ${source}`, backend: "codex" },
          );
          assert.equal(response.status, 200);
          const events = (await response.text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.equal(
            events.filter((event) => event.type === "question").length,
            1,
          );
          assert.ok(events.some((event) => event.type === "done"));
          assert.ok(!events.some((event) => event.type === "error"));
          assert.equal(
            fs.existsSync(
              path.join(dir, "workspace", "continued-without-answer"),
            ),
            false,
          );
          const run = await (
            await request(`/api/sessions/${session.id}/run`)
          ).json();
          assert.equal(run.running, false);
          assert.ok(
            !(
              await (
                await request(`/api/sessions/${session.id}/messages`)
              ).json()
            ).some((m: { role: string }) => m.role === "interruption"),
            "automatic question pause must not be called a user interruption",
          );
          for (const [endpoint, method, data] of [
            ["run", "GET", undefined],
            ["questions", "POST", { questions: [{ title: "wrong owner" }] }],
            [
              "questions/dismiss",
              "POST",
              { questionId: run.pendingQuestion.toolUseId },
            ],
          ] as const) {
            const denied = await fetch(
              `${base}/api/sessions/${session.id}/${endpoint}`,
              {
                method,
                headers: {
                  cookie: otherCookie,
                  "content-type": "application/json",
                },
                ...(data === undefined ? {} : { body: JSON.stringify(data) }),
              },
            );
            assert.equal(denied.status, 404);
          }
          assert.equal(run.pendingQuestion.questions[0].options.length, 2);
          const stale = await request(
            `/api/sessions/${session.id}/messages`,
            "POST",
            {
              content: "stale answer",
              backend: "codex",
              questionId: "wrong-id",
            },
          );
          assert.equal(stale.status, 409);
          assert.equal(
            (await (await request(`/api/sessions/${session.id}/run`)).json())
              .pendingQuestion.toolUseId,
            run.pendingQuestion.toolUseId,
          );
          const resumed = await request(
            `/api/sessions/${session.id}/messages`,
            "POST",
            {
              content: "只修改 recsys/index.md",
              backend: "codex",
              questionId: run.pendingQuestion.toolUseId,
            },
          );
          const output = await resumed.text();
          assert.match(output, /已收到用户选择/);
          assert.doesNotMatch(output, /"type":"question"/);
          assert.equal(
            (await (await request(`/api/sessions/${session.id}/run`)).json())
              .pendingQuestion,
            null,
          );
          const history = await (
            await request(`/api/sessions/${session.id}/messages`)
          ).json();
          assert.ok(
            history.some(
              (message: { role: string; content: string }) =>
                message.role === "user" &&
                message.content === "只修改 recsys/index.md",
            ),
          );
        });

      await t.test(
        "replayed search events update one record per call, not per query",
        async () => {
          const session = await (
            await request("/api/sessions", "POST", { backend: "codex" })
          ).json();
          const response = await request(
            `/api/sessions/${session.id}/messages`,
            "POST",
            { content: "search stream", backend: "codex" },
          );
          await response.text();
          const history = await (
            await request(`/api/sessions/${session.id}/messages`)
          ).json();
          const search = history
            .filter(
              (m: { role: string; content: string }) => m.role === "activity",
            )
            .map((m: { content: string }) => JSON.parse(m.content))
            .filter((a: { toolName: string }) => a.toolName === "WebSearch");
          assert.deepEqual(
            search.map((a: { toolUseId: string }) => a.toolUseId),
            ["search-1", "search-2"],
          );
          assert.ok(
            search.every((a: { output?: string }) => a.output !== undefined),
          );
          assert.ok(
            !history.some((m: { role: string }) => m.role === "interruption"),
          );
        },
      );
      for (const backend of ["codex", "claude"])
        await t.test(
          `${backend}: stop preserves partial answer with exactly one persistent notice`,
          async () => {
            const session = await (
              await request("/api/sessions", "POST", { backend })
            ).json();
            const response = await request(
              `/api/sessions/${session.id}/messages`,
              "POST",
              { content: "stream interrupt", backend },
            );
            const reader = response.body!.getReader(),
              decoder = new TextDecoder();
            let output = "";
            try {
              while (!output.includes("partial answer")) {
                const chunk = await reader.read();
                assert.ok(!chunk.done);
                output += decoder.decode(chunk.value, { stream: true });
              }
              const denied = await fetch(
                `${base}/api/sessions/${session.id}/stop`,
                { method: "POST", headers: { cookie: otherCookie } },
              );
              assert.equal(denied.status, 404);
              const stops = await Promise.all([
                request(`/api/sessions/${session.id}/stop`, "POST"),
                request(`/api/sessions/${session.id}/stop`, "POST"),
              ]);
              assert.ok(stops.every((r) => [200, 204].includes(r.status)));
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                output += decoder.decode(chunk.value, { stream: true });
              }
              assert.match(output, /"type":"interrupted"/);
              assert.doesNotMatch(output, /"type":"error"/);
              const history = await (
                await request(`/api/sessions/${session.id}/messages`)
              ).json();
              const notices = history.filter(
                (m: { role: string }) => m.role === "interruption",
              );
              assert.equal(notices.length, 1);
              const partial = history.find(
                (m: { role: string }) => m.role === "assistant",
              );
              assert.equal(partial.content, "partial answer");
              assert.equal(
                JSON.parse(notices[0].content).assistantMessageId,
                partial.id,
              );
              assert.ok(history.indexOf(notices[0]) > history.indexOf(partial));
              const repeated = await request(
                `/api/sessions/${session.id}/stop`,
                "POST",
              );
              assert.equal(repeated.status, 204);
              assert.equal(
                (
                  await (
                    await request(`/api/sessions/${session.id}/messages`)
                  ).json()
                ).filter((m: { role: string }) => m.role === "interruption")
                  .length,
                1,
              );
            } finally {
              await request(`/api/sessions/${session.id}/stop`, "POST");
            }
          },
        );
      await t.test(
        "stop before text still records a notice; failure does not pretend to be user stop",
        async () => {
          const silent = await (
            await request("/api/sessions", "POST", { backend: "codex" })
          ).json();
          const response = await request(
            `/api/sessions/${silent.id}/messages`,
            "POST",
            { content: "silent interrupt", backend: "codex" },
          );
          await request(`/api/sessions/${silent.id}/stop`, "POST");
          await response.text();
          const history = await (
            await request(`/api/sessions/${silent.id}/messages`)
          ).json();
          assert.equal(
            history.filter((m: { role: string }) => m.role === "interruption")
              .length,
            1,
          );
          const failed = await (
            await request("/api/sessions", "POST", { backend: "codex" })
          ).json();
          const error = await request(
            `/api/sessions/${failed.id}/messages`,
            "POST",
            { content: "failure", backend: "codex" },
          );
          assert.match(await error.text(), /fixture failure/);
          assert.ok(
            !(
              await (
                await request(`/api/sessions/${failed.id}/messages`)
              ).json()
            ).some((m: { role: string }) => m.role === "interruption"),
          );
        },
      );
    } finally {
      server.kill("SIGTERM");
      await stopped;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

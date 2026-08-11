import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const webPort = Number(env.WEB_PORT) || 5173;
  const apiPort = Number(env.PORT) || 3001;
  const workspaceDirectory = path
    .resolve(
      env.WORKSPACE_DIR || env.DATA_DIR || "data",
      env.WORKSPACE_DIR ? "" : "workspaces",
    )
    .split(path.sep)
    .join("/");

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: webPort,
      strictPort: true,
      // User and Claude activity writes workspace files frequently. They are
      // runtime data, not frontend source, and must never trigger a page reload.
      watch: { ignored: ["**/data/**", `${workspaceDirectory}/**`] },
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
        "/published": `http://127.0.0.1:${apiPort}`,
        "^/[a-z0-9][a-z0-9_-]*/published/": `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});

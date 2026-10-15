// Entry point: configuration from the environment, idle sweeper, graceful shutdown.

import { Projects } from "./projects.js";
import { createGateway, probe } from "./server.js";

const env = process.env;
const secret = env.TELEBROWSER_SECRET || "";
if (secret.length < 32) {
  console.error("TELEBROWSER_SECRET must be set (at least 32 characters)");
  process.exit(1);
}

const port = Number(env.PORT || 5858);
const projects = new Projects({
  runDir: env.RUN_DIR || "/data/run",
  portStart: Number(env.DEBUG_PORT_START || 9300),
  portEnd: Number(env.DEBUG_PORT_END || 9399),
  idleMs: Number(env.IDLE_MINUTES ?? 60) * 60_000,
  readyTimeoutMs: Number(env.READY_TIMEOUT_SECONDS || 45) * 1000,
  probe,
});

const server = createGateway({
  secret,
  projects,
  hostDataDir: env.HOST_DATA_DIR || "/data",
  viewUrl: env.VIEW_URL || "",
});

setInterval(() => {
  for (const p of projects.sweep()) console.log(`idle stop ${p}`);
}, 60_000).unref();

server.listen(port, env.LISTEN_HOST || "0.0.0.0", () => console.log(`telebrowser gateway listening on :${port}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}

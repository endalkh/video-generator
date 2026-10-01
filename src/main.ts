import "dotenv/config";
import { startServer } from "./api/server.js";
import { createContainer } from "./container.js";
import { log, setLogLevel } from "./util/log.js";

/** Entry point: wire services (Postgres via Prisma) and serve the web UI on localhost. */
async function main() {
  if (process.argv.includes("--verbose") || process.argv.includes("-v")) setLogLevel("debug");
  const container = await createContainer();
  const server = await startServer(container);

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    log.info("Shutting down… (running projects are paused and can be resumed)");
    server.close();
    server.closeAllConnections();
    await container.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  log.error((err as Error).message ?? String(err));
  process.exit(1);
});

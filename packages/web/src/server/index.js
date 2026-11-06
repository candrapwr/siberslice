import { createServer } from "node:http";
import { ensureSessionsDirectory } from "./session-store.js";
import { sendError } from "./http.js";
import { routeRequest } from "./router.js";
import { recordServerError } from "./server-log.js";
import { config } from "../config/env.js";

await ensureSessionsDirectory();

const server = createServer((req, res) => {
  routeRequest(req, res).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await recordServerError({
      level: "error",
      type: "request_failed",
      method: req.method,
      path: new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        res.end();
      }
    } else {
      sendError(res, 500, message);
    }
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`SiberSlice listening on http://localhost:${config.port}`);
});

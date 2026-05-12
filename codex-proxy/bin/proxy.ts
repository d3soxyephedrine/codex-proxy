import { startServer } from "../src/server";

const parsedPort = Number.parseInt(process.env.CODEX_PROXY_PORT || "3462", 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 3462;
const host = process.env.CODEX_PROXY_HOST || "127.0.0.1";

startServer({ port, host });

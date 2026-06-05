import { listen } from "@colyseus/tools";
import app from "./app.config";

// Plain HTTP on 127.0.0.1:2567 (or $PORT). Caddy terminates TLS and proxies
// WebSocket upgrade transparently — see ../Caddyfile and CADDY_SETUP.md.
listen(app);

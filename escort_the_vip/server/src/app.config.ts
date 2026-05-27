// Lift the schema encoder buffer ABOVE the default 8 KB before any room
// schema is encoded. The maze alone replicates 6 × 480-element uint8 arrays
// (types/states/HP/maxHP + claim teams/ack) plus players, items, bombs and
// the result history — together this can spill past the default and trigger
// the `@colyseus/schema buffer overflow` warning, with later state diffs
// silently dropped.
import { Encoder } from "@colyseus/schema";
Encoder.BUFFER_SIZE = 32 * 1024;

import config from "@colyseus/tools";
import { monitor } from "@colyseus/monitor";
import { playground } from "@colyseus/playground";
import express from "express";

import { GameRoom } from "./rooms/GameRoom";
import { issueToken, isRateLimited } from "./auth";

export default config({
    initializeGameServer: (gameServer) => {
        gameServer.define("game_room", GameRoom);
    },

    initializeExpress: (app) => {
        // Trust X-Forwarded-* from Caddy (loopback only)
        app.set("trust proxy", "loopback");

        // CORS — required for Decentraland's browser to reach matchmaking HTTP.
        // Colyseus does ws upgrade AFTER an initial POST to /matchmake/...
        // Without these headers the browser blocks the preflight.
        app.use((req, res, next) => {
            const origin = req.headers.origin;
            if (origin) {
                res.header("Access-Control-Allow-Origin", origin);
                res.header("Vary", "Origin");
            } else {
                res.header("Access-Control-Allow-Origin", "*");
            }
            res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.header("Access-Control-Allow-Headers", "Origin, Content-Type, Accept, Authorization");
            if (req.method === "OPTIONS") {
                res.sendStatus(200);
                return;
            }
            next();
        });

        // IMPORTANT: do NOT use express.json() globally — it would drain the
        // body stream of /matchmake/joinOrCreate/* POSTs, leaving Colyseus
        // unable to read the auth token. Apply express.json() only on /auth.

        app.get("/health", (_req, res) => {
            res.json({ status: "ok", timestamp: new Date().toISOString() });
        });

        // Auth endpoint — clients call this BEFORE joinOrCreate. They send their
        // DCL userId/displayName (and, on a real realm, X-Identity-Auth-Chain-N
        // headers added by signedFetch). Server hands back a single-use token
        // that GameRoom.onAuth validates; without it the room refuses the conn.
        app.post("/auth", express.json(), (req, res) => {
            const fwd = req.headers["x-forwarded-for"];
            const fwdStr = Array.isArray(fwd) ? fwd[0] : (fwd ?? "");
            const ip = (fwdStr || req.socket.remoteAddress || "unknown").split(",")[0].trim();
            if (isRateLimited(ip)) {
                res.status(429).json({ error: "Too many auth requests — try again in a minute" });
                return;
            }
            const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
            const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
            if (!userId) {
                res.status(400).json({ error: "userId is required" });
                return;
            }
            const hasAuthChain = Object.keys(req.headers).some((h) =>
                h.toLowerCase().startsWith("x-identity-auth-chain-"),
            );
            const token = issueToken(userId, displayName);
            console.log(`[Auth] Issued token for ${userId}${hasAuthChain ? " (signed)" : " (unsigned)"}`);
            res.json({ token });
        });

        // Colyseus monitor — protect with basic auth in production via Caddy.
        app.use("/monitor", monitor());

        // Playground — handy during development; disable in production.
        if (process.env.NODE_ENV !== "production") {
            app.use("/playground", playground());
        }
    },

    beforeListen: () => {
        // Called once before the server starts listening. Nothing required here:
        // Caddy handles SSL + WebSocket upgrade, so the Colyseus process just
        // binds plain HTTP on 127.0.0.1:2567 (or PORT env var).
    },
});

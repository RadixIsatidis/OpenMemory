import express from "express";
import { env, tier } from "../core/cfg";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { mcp } from "../ai/mcp";
import { routes } from "./routes";
import {
    authenticate_api_request,
    log_authenticated_request,
} from "./middleware/auth";
import { start_reflection } from "../memory/reflect";
import { start_user_summary_reflection } from "../memory/user_summary";
import { sendTelemetry } from "../core/telemetry";
import { req_tracker_mw } from "./routes/dashboard";

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `;

// Create Express application
const app = express();

console.log(ASC);
console.log(`[CONFIG] Vector Dimension: ${env.vec_dim}`);
console.log(`[CONFIG] Cache Segments: ${env.cache_segments}`);
console.log(`[CONFIG] Max Active Queries: ${env.max_active}`);

// Warn about configuration mismatch that causes embedding incompatibility
if (env.emb_kind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    console.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
        `         OM_EMBEDDINGS=${env.emb_kind} but OM_TIER=${tier}\n` +
        `         Storage will use ${env.emb_kind} embeddings, but queries will use synthetic embeddings.\n` +
        `         This causes semantic search to fail. Set OM_TIER=deep to fix.`
    );
}

// ==================== MIDDLEWARE ====================

// Body parsing middleware (critical for MCP)
const payloadLimit = env.max_payload_size || 10_000_000;
app.use(express.json({ 
    limit: payloadLimit,
    // Handle JSON parsing errors gracefully
    verify: (req: any, res: any, buf: Buffer, encoding: string) => {
        try {
            JSON.parse(buf.toString());
        } catch (e) {
            throw new SyntaxError('Invalid JSON payload');
        }
    }
}));
app.use(express.urlencoded({ extended: true, limit: payloadLimit }));

// JSON parsing error handler
app.use((err: any, req: any, res: any, next: any) => {
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32700,
                message: "Parse error: Invalid JSON"
            },
            id: null
        });
    }
    next(err);
});

// Request tracking
app.use(req_tracker_mw());

// CORS middleware
app.use((req: any, res: any, next: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,x-api-key,Mcp-Session-Id,MCP-Protocol-Version,Origin",
    );
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    next();
});

app.use(authenticate_api_request);

if (process.env.OM_LOG_AUTH === "true") {
    app.use(log_authenticated_request);
}

routes(app);

// MCP Integration - Streamable HTTP endpoint
console.log("[MCP] Initializing MCP server with Streamable HTTP transport...");
mcp(app);
console.log("[MCP] Endpoint configured at POST /mcp");
console.log("[MCP] Compatible with: Gemini CLI, Claude Code, VS Code, Copilot, Codex CLI");
console.log("[MCP] For IntelliJ: Use mcp-proxy adapter (see documentation)");

if (env.mode === "langgraph") {
    console.log("[MODE] LangGraph integration enabled");
}

const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
console.log(
    `[DECAY] Interval: ${env.decay_interval_minutes} minutes (${decayIntervalMs / 1000}s)`,
);

setInterval(async () => {
    console.log("[DECAY] Running HSG decay process...");
    try {
        const result = await run_decay_process();
        console.log(
            `[DECAY] Completed: ${result.decayed}/${result.processed} memories updated`,
        );
    } catch (error) {
        console.error("[DECAY] Process failed:", error);
    }
}, decayIntervalMs);
setInterval(
    async () => {
        console.log("[PRUNE] Pruning weak waypoints...");
        try {
            const pruned = await prune_weak_waypoints();
            console.log(`[PRUNE] Completed: ${pruned} waypoints removed`);
        } catch (error) {
            console.error("[PRUNE] Failed:", error);
        }
    },
    7 * 24 * 60 * 60 * 1000,
);
run_decay_process()
    .then((result: any) => {
        console.log(
            `[INIT] Initial decay: ${result.decayed}/${result.processed} memories updated`,
        );
    })
    .catch(console.error);

start_reflection();
start_user_summary_reflection();

console.log(`[SERVER] Starting on port ${env.port}`);
// Bind to 127.0.0.1 for local security (prevents LAN scanning)
// For production deployment, configure via environment or load balancer
const host = process.env.OM_BIND_HOST || "127.0.0.1";
app.listen(env.port, host, () => {
    console.log(`[SERVER] Running on http://${host}:${env.port}`);
    sendTelemetry().catch(() => {
        // ignore telemetry failures
    });
});

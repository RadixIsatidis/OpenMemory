import express from "express";
import { env, tier } from "../core/cfg";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { createMcpServer, handleMcpRequest } from "../ai/mcp";
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

// Create Express app
const app = express();

console.log(ASC);
console.log(`[CONFIG] Vector Dimension: ${env.vec_dim}`);
console.log(`[CONFIG] Cache Segments: ${env.cache_segments}`);
console.log(`[CONFIG] Max Active Queries: ${env.max_active}`);

// Warn about configuration mismatch
if (env.emb_kind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    console.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
        `         OM_EMBEDDINGS=${env.emb_kind} but OM_TIER=${tier}\n` +
        `         Storage will use ${env.emb_kind} embeddings, but queries will use synthetic embeddings.\n` +
        `         This causes semantic search to fail. Set OM_TIER=deep to fix.`
    );
}

// ==================== MIDDLEWARE ====================

// Body parsers
const payloadLimit = env.max_payload_size || 10_000_000;
app.use(express.json({ limit: payloadLimit }));
app.use(express.urlencoded({ extended: true, limit: payloadLimit }));

// Request tracking
app.use(req_tracker_mw());

// CORS headers
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,x-api-key",
    );
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    next();
});

// Authentication middleware
app.use(authenticate_api_request);

if (process.env.OM_LOG_AUTH === "true") {
    app.use(log_authenticated_request);
}

// ==================== ROUTES ====================

// Regular REST API routes
routes(app);

// ==================== MCP INTEGRATION ====================

// Create single MCP server instance
const mcpServer = createMcpServer();
console.log("[MCP] Server instance created");

/**
 * MCP Endpoint - Handles both GET (SSE) and POST (Streamable HTTP) requests
 * Implements authentication and user context injection
 */
app.all("/mcp", async (req, res) => {
    try {
        // Authentication check
        const authHeader = req.headers["authorization"];
        const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
        const expectedKey = process.env.OM_API_KEY;
        
        // Support both Authorization: Bearer and X-API-Key headers
        let token: string | undefined;
        if (authHeader) {
            token = authHeader.replace("Bearer ", "").trim();
        } else if (apiKeyHeader) {
            token = apiKeyHeader.trim();
        }
        
        // Validate API key if configured
        if (expectedKey && token !== expectedKey) {
            res.status(401).json({
                jsonrpc: "2.0",
                error: {
                    code: -32600,
                    message: "Unauthorized: Invalid API Key",
                },
                id: null,
            });
            return;
        }
        
        // Determine user ID for multi-tenant isolation
        // Strategy: Use API key as user identifier, or default user
        const userId = token || process.env.OM_MCP_DEFAULT_USER || "mcp_user";
        
        console.log(`[MCP] Request from user: ${userId}, method: ${req.method}`);
        
        // Handle request with MCP server
        await handleMcpRequest(req, res, mcpServer, userId);
        
    } catch (error) {
        console.error("[MCP] Endpoint error:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                },
                id: null,
            });
        }
    }
});

// Handle connection close
app.use("/mcp", (req, res, next) => {
    req.on("close", () => {
        console.log("[MCP] Client disconnected");
    });
    next();
});

console.log("[MCP] Endpoint configured at /mcp");
console.log("[MCP] Supports: Streamable HTTP (POST), SSE (GET)");
console.log("[MCP] Authentication: Authorization: Bearer <token> or X-API-Key: <token>");

if (env.mode === "langgraph") {
    console.log("[MODE] LangGraph integration enabled");
}

// ==================== BACKGROUND TASKS ====================

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

// ==================== SERVER START ====================

console.log(`[SERVER] Starting on port ${env.port}`);
app.listen(env.port, () => {
    console.log(`[SERVER] Running on http://localhost:${env.port}`);
    console.log(`[MCP] Endpoint: http://localhost:${env.port}/mcp`);
    console.log(`[MCP] Usage: claude mcp add --transport http --url http://localhost:${env.port}/mcp --header "Authorization: Bearer YOUR_API_KEY"`);
    sendTelemetry().catch(() => {
        // ignore telemetry failures
    });
});

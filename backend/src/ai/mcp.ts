import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { env } from "../core/cfg";
import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    sector_configs,
} from "../memory/hsg";
import { q, all_async, memories_table } from "../core/db";
import { getEmbeddingInfo } from "../memory/embed";
import { j, p } from "../utils";
import type { sector_type, mem_row, rpc_err_code } from "../core/types";
import { update_user_summary } from "../memory/user_summary";

const sec_enum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

// Pre-define Zod schemas to avoid TypeScript type inference memory issues
const QueryInputSchema = z.object({
    query: z
        .string()
        .min(1, "query text is required")
        .describe("Natural language search query or question to find relevant memories"),
    k: z
        .number()
        .min(1)
        .max(32)
        .default(8)
        .describe("Maximum number of results to return (1-32)"),
    sector: sec_enum
        .optional()
        .describe("Restrict search to a specific sector"),
    min_salience: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum salience threshold"),
    user_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Isolate results to a specific user identifier"),
});

const StoreInputSchema = z.object({
    content: z.string().min(1).describe("The text content, information, or knowledge to remember and store"),
    tags: z.array(z.string()).optional().describe("Optional tags for categorization and filtering"),
    metadata: z
        .record(z.any())
        .optional()
        .describe("Optional metadata object for additional structured information"),
    user_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("User identifier for multi-tenant isolation (optional, defaults to system user)"),
});

const ReinforceInputSchema = z.object({
    id: z.string().min(1).describe("Unique identifier of the memory to reinforce"),
    boost: z
        .number()
        .min(0.01)
        .max(1)
        .default(0.1)
        .describe("Amount to increase salience by (0.01-1.0, default 0.1)"),
});

const ListInputSchema = z.object({
    limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of memories to return (1-50)"),
    sector: sec_enum
        .optional()
        .describe("Filter by memory sector: episodic (events), semantic (facts), procedural (how-to), emotional (feelings), or reflective (insights)"),
    user_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Filter memories for specific user (optional, for multi-tenant scenarios)"),
});

const GetInputSchema = z.object({
    id: z.string().min(1).describe("Unique identifier of the memory to retrieve"),
    include_vectors: z
        .boolean()
        .default(false)
        .describe("Include detailed vector embedding information (optional, for advanced use)"),
    user_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Verify user ownership before returning memory (optional, for multi-tenant scenarios)"),
});

const SearchPromptSchema = z.object({
    query: z.string().min(1).describe("Search query text"),
    max_results: z.string().optional().describe("Maximum number of results (default: 5)"),
});

const ContextPromptSchema = z.object({
    topic: z.string().optional().describe("Optional topic to focus on"),
    max_memories: z.string().optional().describe("Maximum memories to include (default: 10)"),
});

const trunc = (val: string, max = 200) =>
    val.length <= max ? val : `${val.slice(0, max).trimEnd()}...`;

const build_mem_snap = (row: mem_row) => ({
    id: row.id,
    primary_sector: row.primary_sector,
    salience: Number(row.salience.toFixed(3)),
    last_seen_at: row.last_seen_at,
    user_id: row.user_id,
    content_preview: trunc(row.content, 240),
});

const fmt_matches = (matches: Awaited<ReturnType<typeof hsg_query>>) =>
    matches
        .map((m: any, idx: any) => {
            const prev = trunc(m.content.replace(/\s+/g, " ").trim(), 200);
            return `${idx + 1}. [${m.primary_sector}] score=${m.score.toFixed(3)} salience=${m.salience.toFixed(3)} id=${m.id}\n${prev}`;
        })
        .join("\n\n");

const set_hdrs = (res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    // Note: CORS headers are handled by Nginx reverse proxy
};

const send_err = (
    res: ServerResponse,
    code: rpc_err_code,
    msg: string,
    id: number | string | null = null,
    status = 400,
) => {
    if (!res.headersSent) {
        res.statusCode = status;
        set_hdrs(res);
        res.end(
            JSON.stringify({
                jsonrpc: "2.0",
                error: { code, message: msg },
                id,
            }),
        );
    }
};

const uid = (val?: string | null) => (val?.trim() ? val.trim() : undefined);

export const create_mcp_srv = () => {
    const srv = new McpServer(
        {
            name: "openmemory-mcp",
            version: "2.1.0",
        },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } },
    );

    (srv as any).registerTool(
        "openmemory_query",
        {
            description: "Search and retrieve memories using semantic similarity. Returns relevant memories ranked by similarity score, useful for finding information, context, or related knowledge from the memory system.",
            inputSchema: QueryInputSchema,
        },
        async (args: any) => {
            const { query, k = 8, sector, min_salience, user_id } = args;
            const u = uid(user_id);
            const flt =
                sector || min_salience !== undefined || u
                    ? {
                        ...(sector
                            ? { sectors: [sector as sector_type] }
                            : {}),
                        ...(min_salience !== undefined
                            ? { minSalience: min_salience }
                            : {}),
                        ...(u ? { user_id: u } : {}),
                    }
                    : undefined;
            const matches = await hsg_query(query, k ?? 8, flt);
            const summ = matches.length
                ? fmt_matches(matches)
                : "No memories matched the supplied query.";
            const pay = matches.map((m: any) => ({
                id: m.id,
                score: Number(m.score.toFixed(4)),
                primary_sector: m.primary_sector,
                sectors: m.sectors,
                salience: Number(m.salience.toFixed(4)),
                last_seen_at: m.last_seen_at,
                path: m.path,
                content: m.content,
            }));
            return {
                content: [
                    { type: "text", text: summ },
                    {
                        type: "text",
                        text: JSON.stringify({ query, matches: pay }, null, 2),
                    },
                ],
            };
        },
    );

    (srv as any).registerTool(
        "openmemory_store",
        {
            description: "Store new information, facts, or knowledge into OpenMemory for future retrieval. Creates a new memory entry that can be searched and retrieved later. Automatically classifies content into appropriate memory sectors (episodic, semantic, procedural, emotional, reflective).",
            inputSchema: StoreInputSchema,
        },
        async (args: any) => {
            const { content, tags, metadata, user_id } = args;
            const u = uid(user_id);
            const res = await add_hsg_memory(
                content,
                j(tags || []),
                metadata,
                u,
            );
            if (u)
                update_user_summary(u).catch((err) =>
                    console.error("[MCP] user summary update failed:", err),
                );
            const txt = `Stored memory ${res.id} (primary=${res.primary_sector}) across sectors: ${res.sectors.join(", ")}${u ? ` [user=${u}]` : ""}`;
            const payload = {
                id: res.id,
                primary_sector: res.primary_sector,
                sectors: res.sectors,
                user_id: u ?? null,
            };
            return {
                content: [
                    { type: "text", text: txt },
                    { type: "text", text: JSON.stringify(payload, null, 2) },
                ],
            };
        },
    );

    (srv as any).registerTool(
        "openmemory_reinforce",
        {
            description: "Increase the importance (salience) of an existing memory, making it more likely to be retrieved in future searches. Use this when a memory proves valuable or needs to be prioritized.",
            inputSchema: ReinforceInputSchema,
        },
        async (args: any) => {
            const { id, boost = 0.1 } = args;
            await reinforce_memory(id, boost);
            return {
                content: [
                    {
                        type: "text",
                        text: `Reinforced memory ${id} by ${boost}`,
                    },
                ],
            };
        },
    );

    (srv as any).registerTool(
        "openmemory_list",
        {
            description: "List and browse recent memories stored in the system. Returns a paginated list of memories sorted by recency, useful for reviewing what has been stored or finding specific information.",
            inputSchema: ListInputSchema,
        },
        async (args: any) => {
            const { limit = 10, sector, user_id } = args;
            const u = uid(user_id);
            let rows: mem_row[];
            if (u) {
                const all = await q.all_mem_by_user.all(u, limit ?? 10, 0);
                rows = sector
                    ? all.filter((row) => row.primary_sector === sector)
                    : all;
            } else {
                rows = sector
                    ? await q.all_mem_by_sector.all(sector, limit ?? 10, 0)
                    : await q.all_mem.all(limit ?? 10, 0);
            }
            const items = rows.map((row) => ({
                ...build_mem_snap(row),
                tags: p(row.tags || "[]") as string[],
                metadata: p(row.meta || "{}") as Record<string, unknown>,
            }));
            const lns = items.map(
                (item, idx) =>
                    `${idx + 1}. [${item.primary_sector}] salience=${item.salience} id=${item.id}${item.tags.length ? ` tags=${item.tags.join(", ")}` : ""}${item.user_id ? ` user=${item.user_id}` : ""}\n${item.content_preview}`,
            );
            return {
                content: [
                    {
                        type: "text",
                        text: lns.join("\n\n") || "No memories stored yet.",
                    },
                    { type: "text", text: JSON.stringify({ items }, null, 2) },
                ],
            };
        },
    );

    (srv as any).registerTool(
        "openmemory_get",
        {
            description: "Retrieve detailed information about a specific memory by its unique identifier. Returns the complete memory object including content, metadata, timestamps, and optionally vector embeddings.",
            inputSchema: GetInputSchema,
        },
        async (args: any) => {
            const { id, include_vectors = false, user_id } = args;
            const u = uid(user_id);
            const mem = await q.get_mem.get(id);
            if (!mem)
                return {
                    content: [
                        { type: "text", text: `Memory ${id} not found.` },
                    ],
                };
            if (u && mem.user_id !== u)
                return {
                    content: [
                        {
                            type: "text",
                            text: `Memory ${id} not found for user ${u}.`,
                        },
                    ],
                };
            const vecs = include_vectors ? await q.get_vecs_by_id.all(id) : [];
            const pay = {
                id: mem.id,
                content: mem.content,
                primary_sector: mem.primary_sector,
                salience: mem.salience,
                decay_lambda: mem.decay_lambda,
                created_at: mem.created_at,
                updated_at: mem.updated_at,
                last_seen_at: mem.last_seen_at,
                user_id: mem.user_id,
                tags: p(mem.tags || "[]"),
                metadata: p(mem.meta || "{}"),
                sectors: include_vectors
                    ? vecs.map((v) => v.sector)
                    : undefined,
            };
            return {
                content: [{ type: "text", text: JSON.stringify(pay, null, 2) }],
            };
        },
    );

    srv.resource(
        "openmemory-config",
        "openmemory://config",
        {
            mimeType: "application/json",
            description:
                "Runtime configuration snapshot for the OpenMemory MCP server",
        },
        async () => {
            const stats = await all_async(
                `select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from ${memories_table} group by primary_sector`,
            );
            const pay = {
                mode: env.mode,
                sectors: sector_configs,
                stats,
                embeddings: getEmbeddingInfo(),
                server: { version: "2.1.0", protocol: "2025-06-18" },
                available_tools: [
                    "openmemory_query",
                    "openmemory_store",
                    "openmemory_reinforce",
                    "openmemory_list",
                    "openmemory_get",
                ],
                available_prompts: [
                    "memory_search",
                    "memory_context",
                ],
            };
            return {
                contents: [
                    {
                        uri: "openmemory://config",
                        text: JSON.stringify(pay, null, 2),
                    },
                ],
            };
        },
    );

    // ==================== PROMPTS ====================

    (srv as any).registerPrompt(
        "memory_search",
        {
            description: "Search memories and format results for LLM consumption",
            argsSchema: SearchPromptSchema.shape,
        },
        async (args: any) => {
            const { query, max_results } = args;
            const limit = max_results ? parseInt(max_results, 10) : 5;
            const results = await hsg_query(query, limit);

            const formatted = results.length > 0
                ? results.map((m: any, i: number) =>
                    `${i + 1}. [${m.primary_sector}] (score: ${m.score.toFixed(3)})\n${m.content}`
                  ).join('\n\n')
                : 'No relevant memories found.';

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Search results for "${query}":\n\n${formatted}`
                        }
                    }
                ]
            };
        }
    );

    (srv as any).registerPrompt(
        "memory_context",
        {
            description: "Build context from recent memories for conversation",
            argsSchema: ContextPromptSchema.shape,
        },
        async (args: any) => {
            const { topic, max_memories } = args;
            const limit = max_memories ? Math.min(parseInt(max_memories) || 10, 30) : 10;

            let memories;
            if (topic) {
                memories = await hsg_query(topic, limit);
            } else {
                const rows = await q.all_mem.all(limit, 0);
                memories = rows;
            }

            const context = memories
                .map((m: any, i: number) => `${i + 1}. ${m.content}`)
                .join('\n');

            const message = topic
                ? `Relevant context about "${topic}":\n\n${context}`
                : `Recent memory context:\n\n${context}`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: message
                        }
                    }
                ]
            };
        }
    );

    srv.server.oninitialized = () => {
        // Use stderr for debug output, not stdout
        console.error(
            "[MCP] initialization completed with client:",
            srv.server.getClientVersion(),
        );
    };
    return srv;
};

const extract_pay = async (req: IncomingMessage & { body?: any }) => {
    if (req.body !== undefined) {
        if (typeof req.body === "string") {
            if (!req.body.trim()) return undefined;
            return JSON.parse(req.body);
        }
        if (typeof req.body === "object" && req.body !== null) return req.body;
        return undefined;
    }
    const raw = await new Promise<string>((resolve, reject) => {
        let buf = "";
        req.on("data", (chunk) => {
            buf += chunk;
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
    });
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
};

export const mcp = (app: any) => {
    const srv = create_mcp_srv();

    // Session management: store active transports by session ID
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    // Configuration: Origin whitelist (configurable via environment)
    const allowed_origins = process.env.OM_MCP_ALLOWED_ORIGINS
        ? process.env.OM_MCP_ALLOWED_ORIGINS.split(',')
        : [
            'http://localhost',
            'http://127.0.0.1',
            'https://localhost',
            'https://127.0.0.1',
        ];

    // Configuration: Enable authentication (optional, via environment)
    const require_auth = process.env.OM_MCP_REQUIRE_AUTH === 'true';
    const auth_token = process.env.OM_MCP_AUTH_TOKEN;

    // Configuration: Log level (error, warn, info, debug)
    const log_level = process.env.OM_MCP_LOG_LEVEL || 'info';
    const should_log = (level: 'error' | 'warn' | 'info' | 'debug') => {
        const levels = ['error', 'warn', 'info', 'debug'];
        return levels.indexOf(level) <= levels.indexOf(log_level as any);
    };

    // Security: validate Origin header to prevent DNS rebinding attacks
    const validate_origin = (req: any): boolean => {
        const origin = req.headers.origin;
        if (!origin) return true; // Allow requests without Origin (e.g., from CLI tools)

        return allowed_origins.some(prefix => origin.startsWith(prefix));
    };

    // Security: validate authentication token
    const validate_auth = (req: any): boolean => {
        if (!require_auth) return true; // Auth disabled
        if (!auth_token) return true; // No token configured

        const auth_header = req.headers['authorization'];
        if (!auth_header) return false;

        // Support both "Bearer <token>" and direct token
        const token = auth_header.startsWith('Bearer ')
            ? auth_header.slice(7)
            : auth_header;

        return token === auth_token;
    };

    // Security: validate MCP protocol version
    const validate_protocol_version = (req: any): boolean => {
        const version = req.headers['mcp-protocol-version'];
        if (!version) return true; // Allow requests without version for backwards compatibility

        const supported = ['2025-03-26', '2025-06-18'];
        return supported.includes(version);
    };

    const handle_req = async (req: any, res: any) => {
        try {
            // Security: validate Origin to prevent DNS rebinding attacks
            if (!validate_origin(req)) {
                if (should_log('warn')) {
                    console.error("[MCP] Rejected request from invalid origin:", req.headers.origin);
                }
                send_err(res, -32600, "Invalid Origin header", null, 403);
                return;
            }

            // Security: validate authentication token
            if (!validate_auth(req)) {
                if (should_log('warn')) {
                    console.error("[MCP] Rejected request with invalid authentication");
                }
                send_err(res, -32600, "Authentication required", null, 401);
                return;
            }

            // Security: validate MCP protocol version
            if (!validate_protocol_version(req)) {
                if (should_log('warn')) {
                    console.error("[MCP] Rejected request with unsupported protocol version:", req.headers['mcp-protocol-version']);
                }
                send_err(res, -32600, "Unsupported MCP protocol version", null, 400);
                return;
            }

            const pay = await extract_pay(req);
            if (!pay || typeof pay !== "object") {
                send_err(res, -32600, "Request body must be a JSON object");
                return;
            }

            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            // Session management: reuse existing session or create new one
            if (sessionId && transports[sessionId]) {
                // Reuse existing session transport
                transport = transports[sessionId];
                if (should_log('debug')) {
                    console.error("[MCP] Reusing session:", sessionId);
                }
            } else if (!sessionId && isInitializeRequest(pay)) {
                // New session initialization
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: true,
                    onsessioninitialized: (id) => {
                        transports[id] = transport;
                        if (should_log('info')) {
                            console.error("[MCP] Session initialized:", id);
                        }
                    },
                    onsessionclosed: (id) => {
                        delete transports[id];
                        if (should_log('info')) {
                            console.error("[MCP] Session closed:", id);
                        }
                    },
                });

                // Resource cleanup: remove transport when connection closes
                transport.onclose = () => {
                    if (transport.sessionId) {
                        delete transports[transport.sessionId];
                        if (should_log('debug')) {
                            console.error("[MCP] Transport closed for session:", transport.sessionId);
                        }
                    }
                };

                // Connect server to new transport
                await srv.connect(transport);
                if (should_log('info')) {
                    console.error("[MCP] New session created");
                }
            } else {
                // Invalid: non-initialize request without valid session ID
                send_err(res, -32000, "Invalid session: missing or invalid session ID for non-initialize request", null, 400);
                return;
            }

            if (should_log('debug')) {
                console.error("[MCP] Processing request:", pay.method);
            }
            set_hdrs(res);

            // Resource cleanup: close transport when response finishes
            res.on('close', () => {
                if (!transport.sessionId) {
                    // Stateless transport can be closed immediately
                    transport.close().catch((err: any) => {
                        console.error("[MCP] Error closing transport:", err);
                    });
                }
            });

            await transport.handleRequest(req, res, pay);
        } catch (error) {
            console.error("[MCP] Error handling request:", error);
            if (error instanceof SyntaxError) {
                send_err(res, -32700, "Parse error: Invalid JSON");
                return;
            }
            if (!res.headersSent)
                send_err(
                    res,
                    -32603,
                    "Internal server error",
                    (error as any)?.id ?? null,
                    500,
                );
        }
    };

    app.post("/mcp", (req: any, res: any) => {
        void handle_req(req, res);
    });

    // GET /mcp: Support SSE streams for server-initiated messages
    app.get("/mcp", async (req: any, res: any) => {
        try {
            // Security: validate Origin
            if (!validate_origin(req)) {
                send_err(res, -32600, "Invalid Origin header", null, 403);
                return;
            }

            const sessionId = req.headers['mcp-session-id'] as string;
            const transport = transports[sessionId];

            if (!transport) {
                send_err(res, -32000, "Invalid session ID", null, 400);
                return;
            }

            if (should_log('debug')) {
                console.error("[MCP] GET request for session:", sessionId);
            }
            set_hdrs(res);
            await transport.handleRequest(req, res);
        } catch (error) {
            console.error("[MCP] Error handling GET request:", error);
            if (!res.headersSent) {
                send_err(res, -32603, "Internal server error", null, 500);
            }
        }
    });

    // DELETE /mcp: Support explicit session termination
    app.delete("/mcp", async (req: any, res: any) => {
        try {
            const sessionId = req.headers['mcp-session-id'] as string;
            const transport = transports[sessionId];

            if (!transport) {
                send_err(res, -32000, "Invalid session ID", null, 404);
                return;
            }

            if (should_log('info')) {
                console.error("[MCP] DELETE request for session:", sessionId);
            }

            // Close and cleanup session
            await transport.close();
            delete transports[sessionId];

            res.statusCode = 200;
            set_hdrs(res);
            res.end(JSON.stringify({ jsonrpc: "2.0", result: { success: true }, id: null }));
        } catch (error) {
            console.error("[MCP] Error handling DELETE request:", error);
            if (!res.headersSent) {
                send_err(res, -32603, "Internal server error", null, 500);
            }
        }
    });

    app.options("/mcp", (_req: any, res: any) => {
        res.statusCode = 204;
        set_hdrs(res);
        res.end();
    });

    app.put("/mcp", (_req: any, res: any) => {
        send_err(res, -32600, "Method not supported. Use POST /mcp with JSON payload.", null, 405);
    });
};

export const start_mcp_stdio = async () => {
    const srv = create_mcp_srv();
    const trans = new StdioServerTransport();
    await srv.connect(trans);
    // console.error("[MCP] STDIO transport connected"); // Use stderr for debug output, not stdout
};

if (typeof require !== "undefined" && require.main === module) {
    void start_mcp_stdio().catch((error) => {
        console.error("[MCP] STDIO startup failed:", error);
        process.exitCode = 1;
    });
}

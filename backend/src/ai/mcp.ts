import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import type { sector_type, mem_row } from "../core/types";
import { update_user_summary } from "../memory/user_summary";

const sec_enum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

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

const uid = (val?: string | null) => (val?.trim() ? val.trim() : undefined);

/**
 * Extract user ID from request context
 * Implements multi-tenant isolation strategy from the PDF spec
 */
function getUserIdFromContext(context: any): string {
    // Strategy 1: Use authenticated user from Bearer token mapping
    if (context?.userId) {
        return context.userId;
    }
    
    // Strategy 2: Use default MCP user from environment
    const defaultUser = process.env.OM_MCP_DEFAULT_USER || "mcp_user";
    return defaultUser;
}

/**
 * Create MCP Server Instance
 * Implements the complete MCP protocol with all capabilities
 */
export const createMcpServer = () => {
    const srv = new McpServer(
        {
            name: "openmemory-mcp",
            version: "2.1.0",
        },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } },
    );

    // ==================== TOOLS ====================

    srv.tool(
        "openmemory_query",
        "Run a semantic retrieval against OpenMemory",
        {
            query: z
                .string()
                .min(1, "query text is required")
                .describe("Free-form search text"),
            k: z
                .number()
                .int()
                .min(1)
                .max(32)
                .default(8)
                .describe("Maximum results to return"),
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
        },
        async ({ query, k, sector, min_salience, user_id }, extra) => {
            // Get user ID from context or parameter
            const contextUserId = getUserIdFromContext((extra as any)?.requestContext);
            const u = uid(user_id) || contextUserId;
            
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
            
            // Format as Markdown for LLM consumption
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

    srv.tool(
        "openmemory_store",
        "Persist new content into OpenMemory",
        {
            content: z.string().min(1).describe("Raw memory text to store"),
            tags: z.array(z.string()).optional().describe("Optional tag list"),
            metadata: z
                .record(z.any())
                .optional()
                .describe("Arbitrary metadata blob"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                    "Associate the memory with a specific user identifier",
                ),
        },
        async ({ content, tags, metadata, user_id }, extra) => {
            // Get user ID from context or parameter
            const contextUserId = getUserIdFromContext((extra as any)?.requestContext);
            const u = uid(user_id) || contextUserId;
            
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

    srv.tool(
        "openmemory_reinforce",
        "Boost salience for an existing memory",
        {
            id: z.string().min(1).describe("Memory identifier to reinforce"),
            boost: z
                .number()
                .min(0.01)
                .max(1)
                .default(0.1)
                .describe("Salience boost amount (default 0.1)"),
        },
        async ({ id, boost }) => {
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

    srv.tool(
        "openmemory_list",
        "List recent memories for quick inspection",
        {
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(10)
                .describe("Number of memories to return"),
            sector: sec_enum
                .optional()
                .describe("Optionally limit to a sector"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Restrict results to a specific user identifier"),
        },
        async ({ limit, sector, user_id }, extra) => {
            // Get user ID from context or parameter
            const contextUserId = getUserIdFromContext((extra as any)?.requestContext);
            const u = uid(user_id) || contextUserId;
            
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

    srv.tool(
        "openmemory_get",
        "Fetch a single memory by identifier",
        {
            id: z.string().min(1).describe("Memory identifier to load"),
            include_vectors: z
                .boolean()
                .default(false)
                .describe("Include sector vector metadata"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                    "Validate ownership against a specific user identifier",
                ),
        },
        async ({ id, include_vectors, user_id }, extra) => {
            // Get user ID from context or parameter
            const contextUserId = getUserIdFromContext((extra as any)?.requestContext);
            const u = uid(user_id) || contextUserId;
            
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

    // ==================== RESOURCES ====================

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
                    "memory_context_builder",
                    "memory_search_assistant",
                    "memory_consolidation_prompt",
                    "memory_reflection_prompt",
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

    srv.prompt(
        "memory_context_builder",
        "Build comprehensive context from user memories for LLM conversation",
        {
            user_id: z
                .string()
                .trim()
                .min(1)
                .describe("User identifier to retrieve memories for"),
            topic: z
                .string()
                .optional()
                .describe("Optional topic to focus the context on"),
            max_memories: z
                .string()
                .optional()
                .describe(
                    "Maximum number of memories to include (default: 10, max: 50)",
                ),
        },
        async ({ user_id, topic, max_memories }) => {
            const u = uid(user_id);
            if (!u)
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: "Error: user_id is required",
                            },
                        },
                    ],
                };

            const maxMem = max_memories
                ? Math.min(Math.max(1, parseInt(max_memories, 10) || 10), 50)
                : 10;

            let memories;
            if (topic) {
                memories = await hsg_query(topic, maxMem, {
                    user_id: u,
                });
            } else {
                const rows = await q.all_mem_by_user.all(u, maxMem, 0);
                memories = rows;
            }

            const context = memories
                .map(
                    (m: any, idx: number) =>
                        `${idx + 1}. [${m.primary_sector}] ${m.content}`,
                )
                .join("\n\n");

            const promptText = topic
                ? `Here is relevant context about ${topic} from user ${u}'s memory:\n\n${context}\n\nUse this context to provide informed responses.`
                : `Here is recent context from user ${u}'s memory:\n\n${context}\n\nUse this context to provide personalized responses.`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: promptText,
                        },
                    },
                ],
            };
        },
    );

    srv.prompt(
        "memory_search_assistant",
        "Search and format memories for specific queries",
        {
            query: z.string().min(1).describe("Search query text"),
            user_id: z
                .string()
                .trim()
                .optional()
                .describe("Optional user identifier to filter results"),
            sector: z
                .string()
                .optional()
                .describe(
                    "Optional sector to filter results (episodic, semantic, procedural, emotional, reflective)",
                ),
            format: z
                .string()
                .optional()
                .describe(
                    "Output format preference: detailed, summary, or bullet (default: detailed)",
                ),
        },
        async ({ query, user_id, sector, format }) => {
            const u = uid(user_id);
            const matches = await hsg_query(query, 10, {
                ...(sector ? { sectors: [sector as sector_type] } : {}),
                ...(u ? { user_id: u } : {}),
            });

            if (matches.length === 0) {
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: `No memories found matching "${query}".`,
                            },
                        },
                    ],
                };
            }

            const fmt = format || "detailed";
            let formattedResults: string;
            if (fmt === "summary") {
                formattedResults = `Found ${matches.length} memories related to "${query}":\n\n${matches.map((m: any) => `- ${m.content.substring(0, 100)}...`).join("\n")}`;
            } else if (fmt === "bullet") {
                formattedResults = `Memory search results for "${query}":\n${matches.map((m: any, i: number) => `• ${i + 1}. [${m.primary_sector}] ${m.content}`).join("\n")}`;
            } else {
                formattedResults = `Detailed memory search results for "${query}":\n\n${matches
                    .map(
                        (m: any, i: number) =>
                            `${i + 1}. [${m.primary_sector}] Score: ${m.score.toFixed(3)}\n   Salience: ${m.salience.toFixed(3)}\n   Content: ${m.content}\n   Last seen: ${m.last_seen_at}`,
                    )
                    .join("\n\n")}`;
            }

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: formattedResults,
                        },
                    },
                ],
            };
        },
    );

    srv.prompt(
        "memory_consolidation_prompt",
        "Generate prompt for reviewing and consolidating similar memories",
        {
            user_id: z
                .string()
                .trim()
                .min(1)
                .describe("User identifier to analyze memories for"),
            sector: z
                .string()
                .optional()
                .describe(
                    "Optional sector to focus consolidation on (episodic, semantic, procedural, emotional, reflective)",
                ),
        },
        async ({ user_id, sector }) => {
            const u = uid(user_id);
            if (!u)
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: "Error: user_id is required",
                            },
                        },
                    ],
                };

            const rows = sector
                ? await q.all_mem_by_sector.all(sector as sector_type, 50, 0)
                : await q.all_mem_by_user.all(u, 50, 0);

            const filtered = sector
                ? rows.filter((r) => r.user_id === u)
                : rows;

            if (filtered.length === 0) {
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: `No memories found for consolidation${sector ? ` in ${sector} sector` : ""}.`,
                            },
                        },
                    ],
                };
            }

            const memoryList = filtered
                .map(
                    (m, i) =>
                        `${i + 1}. [ID: ${m.id}] [${m.primary_sector}] Salience: ${m.salience.toFixed(3)}\n   ${m.content}`,
                )
                .join("\n\n");

            const promptText = `Review these ${filtered.length} memories${sector ? ` from the ${sector} sector` : ""} and identify:
1. Duplicate or highly similar memories that could be merged
2. Memories that contradict each other and need resolution
3. Memories that could be better organized or categorized

Memories:
${memoryList}

Please provide recommendations for consolidating these memories to improve the memory system's efficiency and accuracy.`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: promptText,
                        },
                    },
                ],
            };
        },
    );

    srv.prompt(
        "memory_reflection_prompt",
        "Generate reflective analysis of user's memory patterns",
        {
            user_id: z
                .string()
                .trim()
                .min(1)
                .describe("User identifier to analyze"),
            focus: z
                .string()
                .optional()
                .describe(
                    "Optional focus area for reflection: habits, preferences, knowledge, skills, or emotions",
                ),
        },
        async ({ user_id, focus }) => {
            const u = uid(user_id);
            if (!u)
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: "Error: user_id is required",
                            },
                        },
                    ],
                };

            const sectorMap: Record<string, sector_type[]> = {
                habits: ["procedural", "episodic"],
                preferences: ["emotional", "semantic"],
                knowledge: ["semantic", "episodic"],
                skills: ["procedural", "semantic"],
                emotions: ["emotional", "reflective"],
            };

            let memories: mem_row[];
            if (focus && sectorMap[focus]) {
                const allMems: mem_row[] = [];
                for (const sector of sectorMap[focus]) {
                    const sectorMems = await q.all_mem_by_sector.all(
                        sector,
                        20,
                        0,
                    );
                    allMems.push(
                        ...sectorMems.filter((m) => m.user_id === u),
                    );
                }
                memories = allMems;
            } else {
                memories = await q.all_mem_by_user.all(u, 30, 0);
            }

            if (memories.length === 0) {
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: `No memories found for user ${u}${focus ? ` related to ${focus}` : ""}.`,
                            },
                        },
                    ],
                };
            }

            const memoryText = memories
                .map(
                    (m, i) =>
                        `${i + 1}. [${m.primary_sector}] ${m.content} (salience: ${m.salience.toFixed(3)})`,
                )
                .join("\n");

            const promptText = `Analyze these ${memories.length} memories for user ${u}${focus ? ` focusing on ${focus}` : ""} and provide:
1. Key patterns and recurring themes
2. Important insights about the user's ${focus || "behavior and preferences"}
3. Suggestions for how this understanding can improve personalized interactions

Memories:
${memoryText}

Please provide a thoughtful reflection on what these memories reveal about the user.`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: promptText,
                        },
                    },
                ],
            };
        },
    );

    // ==================== INITIALIZATION ====================

    srv.server.oninitialized = () => {
        console.error(
            "[MCP] Server initialized with client:",
            srv.server.getClientVersion(),
        );
    };
    
    return srv;
};

/**
 * Handle MCP HTTP Requests
 * Implements Streamable HTTP transport as per PDF requirements
 */
export async function handleMcpRequest(
    req: Request,
    res: Response,
    mcpServer: McpServer,
    userId?: string
) {
    try {
        // Create transport for this request
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        
        // Connect server to transport
        await mcpServer.connect(transport);
        
        // Set request context for user ID
        const requestContext = { userId };
        
        // Handle the request
        if (req.method === "POST") {
            // Pass the already-parsed body from Express
            await transport.handleRequest(req as any, res as any, req.body);
        } else if (req.method === "GET") {
            // Handle SSE connection requests if needed
            await transport.handleRequest(req as any, res as any, null);
        }
        
    } catch (error) {
        console.error("[MCP] Request handling error:", error);
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
}

/**
 * Start MCP STDIO Server
 * For CLI tools
 */
export const startMcpStdio = async () => {
    const srv = createMcpServer();
    const trans = new StdioServerTransport();
    await srv.connect(trans);
};

// CLI entry point
if (typeof require !== "undefined" && require.main === module) {
    void startMcpStdio().catch((error) => {
        console.error("[MCP] STDIO startup failed:", error);
        process.exitCode = 1;
    });
}

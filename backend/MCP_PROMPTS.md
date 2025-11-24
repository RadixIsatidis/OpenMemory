# MCP Prompts Implementation

## Overview

OpenMemory now implements complete MCP (Model Context Protocol) support including the **Prompts** capability, which enables AI-assisted memory workflows through pre-defined prompt templates.

## Implementation Details

### Capabilities

The OpenMemory MCP server now supports all standard MCP capabilities:

- ✅ **Tools** (5 tools for memory operations)
- ✅ **Resources** (1 resource for configuration)
- ✅ **Prompts** (4 prompts for AI workflows) - **NEW!**
- ✅ **Logging** (debug and error logging)

### Registered Prompts

#### 1. `memory_context_builder`

**Description:** Build comprehensive context from user memories for LLM conversation

**Parameters:**
- `user_id` (required, string): User identifier to retrieve memories for
- `topic` (optional, string): Optional topic to focus the context on
- `max_memories` (optional, string): Maximum number of memories to include (default: 10, max: 50)

**Use Case:** Prepare context for an AI conversation by retrieving relevant memories for a user. Can be topic-focused or general.

**Example:**
```json
{
  "user_id": "user123",
  "topic": "Python programming",
  "max_memories": "15"
}
```

#### 2. `memory_search_assistant`

**Description:** Search and format memories for specific queries

**Parameters:**
- `query` (required, string): Search query text
- `user_id` (optional, string): Optional user identifier to filter results
- `sector` (optional, string): Optional sector to filter results (episodic, semantic, procedural, emotional, reflective)
- `format` (optional, string): Output format preference: detailed, summary, or bullet (default: detailed)

**Use Case:** Execute a semantic search and format the results in a user-friendly way for AI consumption.

**Example:**
```json
{
  "query": "machine learning projects",
  "user_id": "user123",
  "sector": "semantic",
  "format": "bullet"
}
```

#### 3. `memory_consolidation_prompt`

**Description:** Generate prompt for reviewing and consolidating similar memories

**Parameters:**
- `user_id` (required, string): User identifier to analyze memories for
- `sector` (optional, string): Optional sector to focus consolidation on (episodic, semantic, procedural, emotional, reflective)

**Use Case:** Identify duplicate, similar, or conflicting memories that should be merged or resolved.

**Example:**
```json
{
  "user_id": "user123",
  "sector": "semantic"
}
```

#### 4. `memory_reflection_prompt`

**Description:** Generate reflective analysis of user's memory patterns

**Parameters:**
- `user_id` (required, string): User identifier to analyze
- `focus` (optional, string): Optional focus area for reflection: habits, preferences, knowledge, skills, or emotions

**Use Case:** Analyze a user's memory patterns to extract insights and understand their behavior, preferences, or learning patterns.

**Example:**
```json
{
  "user_id": "user123",
  "focus": "habits"
}
```

## Protocol Compliance

### MCP Specification Version
- Protocol: `2025-06-18`
- Server Version: `2.1.0`

### Transport Support
- ✅ HTTP POST endpoint: `/mcp`
- ✅ STDIO transport for CLI tools
- ✅ JSON-RPC 2.0 protocol

### Parameter Requirements

All prompt parameters follow MCP specification requirements:
- All parameters must be strings or optional strings
- No numeric or enum types (converted to strings with validation in handler)
- Proper Zod schema validation

## Testing

Run the verification script to validate the implementation:

```bash
cd backend
node verify-mcp.js
```

Expected output:
```
✅ MCP Server verification PASSED
   - 5 Tools for memory operations
   - 1 Resource for configuration access
   - 4 Prompts for AI-assisted memory workflows
   - Logging capability enabled
```

## Integration Examples

### Claude Desktop

```bash
claude mcp add --transport http openmemory http://localhost:8080/mcp
```

### Cursor / Windsurf

Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "openmemory": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### Using Prompts

Once connected, AI assistants can use prompts like:

```
Use the memory_context_builder prompt to get context about user123's Python knowledge
```

The prompt will return a formatted message with relevant memories that the AI can use to provide informed responses.

## Benefits

1. **AI-Assisted Workflows**: Prompts enable complex memory operations without manual tool chaining
2. **Context Building**: Automatically gather and format memories for AI consumption
3. **Memory Maintenance**: Built-in prompts for consolidation and reflection
4. **Flexible Queries**: Multiple output formats and filtering options
5. **Protocol Compliant**: Follows MCP specification for maximum compatibility

## Architecture

Prompts are registered in the MCP server during initialization:

```typescript
srv.prompt(
    "memory_context_builder",
    "Build comprehensive context from user memories for LLM conversation",
    {
        user_id: z.string().trim().min(1).describe("User identifier"),
        topic: z.string().optional().describe("Optional topic"),
        max_memories: z.string().optional().describe("Max memories")
    },
    async ({ user_id, topic, max_memories }) => {
        // Implementation
        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: promptText
                    }
                }
            ]
        };
    }
);
```

## Future Enhancements

Potential additions to the prompts capability:

1. **Dynamic Prompt Generation**: AI-generated prompts based on user behavior
2. **Multi-User Prompts**: Cross-user memory analysis for collaboration
3. **Temporal Prompts**: Time-based memory analysis and evolution tracking
4. **Graph Prompts**: Waypoint and relationship exploration prompts
5. **Custom Prompt Registration**: User-defined prompt templates

## See Also

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18/)
- [OpenMemory Documentation](../README.md)
- [MCP Tools Documentation](../README.md#8-mcp-integration)

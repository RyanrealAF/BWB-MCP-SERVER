// ENTRY POINT: bwb-mcp-server/src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface Env {
  GROQ_API_KEY:         string;
  GH_TOKEN:             string;
  GH_USER:              string;
  CF_ACCOUNT_ID:        string;
  CF_KV_NS_ID:          string;
  CF_D1_DB_ID:          string;
  CLOUDFLARE_API_TOKEN: string;
  MCP_AUTH_TOKEN:       string;
  DB:                   D1Database;
  BWB_NOTES:            KVNamespace;
}

async function groqChat(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens = 200
): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent },
      ],
    }),
  });
  if (!res.ok) { const errText = await res.text(); throw new Error(`Groq API error: ${res.status} ${errText}`); }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

const NARRATIVE_MODEL  = "llama-3.1-8b-instant";
const DISTORTION_MODEL = "llama-3.3-70b-versatile";

const SYS_NARRATIVE  = "Urban myth engine. Input: seed. Output: 100-word street-level myth, second person present tense, end mid-thought. No fantasy. No heroes.";

const SYS_DISTORTION = "Input: myth. Output: same myth with one impossible-but-inevitable detail injected. No explanation. No resolution. 100 words max.";

const SYS_ARCHETYPE  = "Input: myth. Output: JSON array only, 1-3 archetype names. Example: [\"The Corner\",\"The Signal\"]";

async function generateMyth(env: Env, seed: string): Promise<{
  seed: string;
  narrative: string;
  distorted: string;
  archetypes: string[];
}> {
  const archetypeRows = await env.DB.prepare(
    "SELECT name, count, mutations FROM archetypes ORDER BY count DESC LIMIT 5"
  ).all();

  let archCtx = "";
  if (archetypeRows.results?.length) {
    const lines = archetypeRows.results.map((a: Record<string, unknown>) => {
      const mutations: string[] = JSON.parse((a.mutations as string) || "[]");
      return "[" + a.name + "] seen:" + a.count + " last:" + (mutations.slice(-1)[0] || "none");
    });
    archCtx = "ARCHETYPE MEMORY:\n" + lines.join("\n") + "\n\n";
  }

  const narrative = await groqChat(env.GROQ_API_KEY, NARRATIVE_MODEL, SYS_NARRATIVE, archCtx + "Seed: " + seed);
  const distorted = await groqChat(env.GROQ_API_KEY, DISTORTION_MODEL, SYS_DISTORTION, narrative);

  const archetypeRaw = await groqChat(env.GROQ_API_KEY, NARRATIVE_MODEL, SYS_ARCHETYPE, distorted, 100);

  let archetypes: string[] = [];
  try {
    archetypes = JSON.parse(archetypeRaw.replace(/```json|```/g, "").trim());
  } catch (_) {}

  for (const name of archetypes) {
    const existing = await env.DB.prepare(
      "SELECT mutations FROM archetypes WHERE name = ?"
    ).bind(name).first();

    if (existing) {
      const mutations: string[] = JSON.parse((existing.mutations as string) || "[]");
      mutations.push(distorted.slice(0, 100));
      if (mutations.length > 10) mutations.shift();
      await env.DB.prepare(
        "UPDATE archetypes SET count = count + 1, mutations = ?, lastSeen = ? WHERE name = ?"
      ).bind(JSON.stringify(mutations), new Date().toISOString(), name).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO archetypes (name, count, mutations, lastSeen) VALUES (?, 1, ?, ?)"
      ).bind(name, JSON.stringify([distorted.slice(0, 100)]), new Date().toISOString()).run();
    }
  }

  return { seed, narrative, distorted, archetypes };
}

async function ghRequest(token: string, endpoint: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch("https://api.github.com" + endpoint, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "BWB-MCP-Server",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) { const errText = await res.text(); throw new Error(`GitHub API error: ${res.status} ${errText}`); }
  return res.json();
}
function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "bwb-mcp-server", version: "1.0.0" });

  server.registerTool(
    "bwb_generate_myth",
    {
      title: "Generate Urban Myth",
      description: "Generate a BWB urban myth from a seed phrase using dual-model inference. Stage 1 narrative, Stage 2 distortion. Updates archetype cache in D1.",
      inputSchema: z.object({
        seed: z.string().min(3).max(200).describe("Seed phrase for the myth"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ seed }) => {
      const result = await generateMyth(env, seed);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "bwb_list_archetypes",
    {
      title: "List Archetypes",
      description: "List all cached archetypes from the BWB myth engine ordered by frequency.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20).describe("Max archetypes to return"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const rows = await env.DB.prepare(
        "SELECT name, count, lastSeen FROM archetypes ORDER BY count DESC LIMIT ?"
      ).bind(limit).all();
      return { content: [{ type: "text", text: JSON.stringify(rows.results || [], null, 2) }] };
    }
  );

  server.registerTool(
    "bwb_archetype_history",
    {
      title: "Get Archetype History",
      description: "Get the full mutation history of a specific archetype by name.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact archetype name"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const row = await env.DB.prepare("SELECT * FROM archetypes WHERE name = ?").bind(name).first();
      if (!row) return { content: [{ type: "text", text: "Archetype not found: " + name }] };
      const result = {
        name: row.name,
        count: row.count,
        mutations: JSON.parse((row.mutations as string) || "[]"),
        lastSeen: row.lastSeen,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "bwb_gh_pull",
    {
      title: "Pull File from GitHub",
      description: "Pull a file from a RyanrealAF GitHub repository. Returns file contents as string.",
      inputSchema: z.object({
        repo:     z.string().describe("Repository name e.g. BWB-CODE-ASSISTANT"),
        filepath: z.string().describe("File path within the repo e.g. src/index.ts"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repo, filepath }) => {
      const data = await ghRequest(env.GH_TOKEN, "/repos/" + env.GH_USER + "/" + repo + "/contents/" + filepath) as { content?: string; message?: string };
      if (data.message) return { content: [{ type: "text", text: "GitHub error: " + data.message }] };
      const content = data.content ? Buffer.from(data.content, "base64").toString("utf8") : "(empty)";
      return { content: [{ type: "text", text: content }] };
    }
  );

  server.registerTool(
    "bwb_gh_list",
    {
      title: "List GitHub Repo Files",
      description: "List files and directories in a RyanrealAF GitHub repository.",
      inputSchema: z.object({
        repo: z.string().describe("Repository name"),
        path: z.string().default("").describe("Directory path within repo"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ repo, path }) => {
      const data = await ghRequest(env.GH_TOKEN, "/repos/" + env.GH_USER + "/" + repo + "/contents/" + path) as Array<{ name: string; type: string; size: number }> | { message: string };
      if (!Array.isArray(data)) return { content: [{ type: "text", text: "GitHub error: " + data.message }] };
      const files = data.map(f => ({ name: f.name, type: f.type, size: f.size }));
      return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
    }
  );

  server.registerTool(
    "bwb_gh_push",
    {
      title: "Push File to GitHub",
      description: "Update a file in a RyanrealAF GitHub repository. This will create a new commit.",
      inputSchema: z.object({
        repo: z.string().describe("Repository name e.g. BWB-CODE-ASSISTANT"),
        filepath: z.string().describe("File path within the repo e.g. src/index.ts"),
        content: z.string().describe("The new content of the file."),
        commitMessage: z.string().describe("The commit message."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ repo, filepath, content, commitMessage }) => {
      // Try to get the SHA of the file.
      const fileData = await ghRequest(env.GH_TOKEN, "/repos/" + env.GH_USER + "/" + repo + "/contents/" + filepath) as { sha?: string; message?: string };

      let sha: string | undefined = undefined;
      if (fileData.sha) {
        sha = fileData.sha;
      } else if (fileData.message && fileData.message !== 'Not Found') {
        // If there's an error and it's not 'Not Found', then we can't proceed.
        return { content: [{ type: "text", text: "GitHub error (getting SHA): " + fileData.message }] };
      }

      const updateResult = await ghRequest(
        env.GH_TOKEN,
        "/repos/" + env.GH_USER + "/" + repo + "/contents/" + filepath,
        "PUT",
        {
          message: commitMessage,
          content: Buffer.from(content).toString("base64"),
          ...(sha ? { sha } : {}), // Conditionally add sha
        }
      ) as { commit?: { sha: string }; message?: string };

      if (updateResult.message) {
        return { content: [{ type: "text", text: "GitHub error (updating file): " + updateResult.message }] };
      }

      return { content: [{ type: "text", text: `Successfully committed to ${repo}/${filepath} with commit SHA: ${updateResult.commit?.sha}` }] };
    }
  );

  server.registerTool(
    "bwb_kv_get",
    {
      title: "Get KV Note",
      description: "Retrieve a stored note from BWB_NOTES KV by key.",
      inputSchema: z.object({
        key: z.string().describe("KV key e.g. note:note_1234567890"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ key }) => {
      const value = await env.BWB_NOTES.get(key);
      if (!value) return { content: [{ type: "text", text: "Key not found: " + key }] };
      return { content: [{ type: "text", text: value }] };
    }
  );


  server.registerTool(
    "bwb_kv_put",
    {
      title: "Put KV Note",
      description: "Store a note in BWB_NOTES KV.",
      inputSchema: z.object({
        key: z.string().describe("KV key"),
        value: z.string().describe("Content to store"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ key, value }) => {
      await env.BWB_NOTES.put(key, value);
      return { content: [{ type: "text", text: "Successfully stored: " + key }] };
    }
  );

  server.registerTool(
    "bwb_note_save",
    {
      title: "Save Note to D1",
      description: "Save a structured note to the D1 database.",
      inputSchema: z.object({
        id: z.string().describe("Unique note ID"),
        project: z.string().describe("Project name"),
        signal_type: z.string().describe("Type of signal (e.g. log, error, metric)"),
        note: z.string().describe("The note content"),
        tags: z.string().describe("Comma-separated tags"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, project, signal_type, note, tags }) => {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO notes (id, project, timestamp, signal_type, note, tags) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, project, new Date().toISOString(), signal_type, note, tags).run();
      return { content: [{ type: "text", text: "Note saved: " + id }] };
    }
  );

  server.registerTool(
    "bwb_note_list",
    {
      title: "List Notes from D1",
      description: "List notes for a project from the D1 database.",
      inputSchema: z.object({
        project: z.string().describe("Project name"),
        limit: z.number().int().min(1).max(100).default(50).describe("Max notes to return"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, limit }) => {
      const rows = await env.DB.prepare(
        "SELECT * FROM notes WHERE project = ? ORDER BY timestamp DESC LIMIT ?"
      ).bind(project, limit).all();
      return { content: [{ type: "text", text: JSON.stringify(rows.results || [], null, 2) }] };
    }
  );

  server.registerTool(
    "bwb_conv_save",
    {
      title: "Save Conversation to D1",
      description: "Save a conversation history to the D1 database.",
      inputSchema: z.object({
        id: z.string().describe("Unique conversation ID"),
        project: z.string().describe("Project name"),
        turns: z.string().describe("JSON string of conversation turns"),
        note_ids: z.string().describe("Comma-separated note IDs referenced"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, project, turns, note_ids }) => {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO conversations (id, project, timestamp, turns, note_ids) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, project, new Date().toISOString(), turns, note_ids).run();
      return { content: [{ type: "text", text: "Conversation saved: " + id }] };
    }
  );

  server.registerTool(
    "bwb_conv_get",
    {
      title: "Get Conversation from D1",
      description: "Retrieve a conversation history from the D1 database.",
      inputSchema: z.object({
        id: z.string().describe("Conversation ID"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const row = await env.DB.prepare("SELECT * FROM conversations WHERE id = ?").bind(id).first();
      if (!row) return { content: [{ type: "text", text: "Conversation not found: " + id }] };
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }
  );
  return server;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {

    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (token !== env.MCP_AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", server: "bwb-mcp-server" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      const server    = createServer(env);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse:  true,
      });

      await server.connect(transport);

      const body = await request.json();

      let responseBody = "";
      const mockRes = {
        setHeader: () => {},
        writeHead: () => {},
        write:     (data: string) => { responseBody += data; },
        end:       () => {},
        on:        () => {},
      };

      await transport.handleRequest(
        request as unknown as Parameters<typeof transport.handleRequest>[0],
        mockRes as unknown as Parameters<typeof transport.handleRequest>[1],
        body
      );

      return new Response(responseBody, {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

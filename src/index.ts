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
  maxTokens = 400
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
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

const NARRATIVE_MODEL  = "llama-3.1-8b-instant";
const DISTORTION_MODEL = "llama-3.3-70b-versatile";

const SYS_NARRATIVE = "You are the BWB Urban Myth Engine - narrative layer. Take a seed and generate a grounded urban myth. Raw, specific, street-level. No fantasy tropes. No heroes. Real locations, real tensions, real consequences. Write in second person present tense. 150 words max. End mid-thought.";

const SYS_DISTORTION = "You are the BWB Urban Myth Engine - distortion layer. Take a narrative and inject controlled symbolic anomalies. Rules: preserve structure, insert exactly one impossible detail that feels inevitable, do not explain the anomaly, do not resolve contradictions. 150 words max.";

const SYS_ARCHETYPE = "You are an archetype extractor. Return ONLY a JSON array of 1-3 archetype names. No explanation. No markdown. Example: [\"The Witness\",\"The Corner\",\"The Signal\"]";

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

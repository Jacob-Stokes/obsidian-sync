import { serve } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

const app = new Hono();

const API_KEY = process.env.API_KEY || "";
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const PORT = parseInt(process.env.PORT || "3000", 10);

// ── Auth ──────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  // Health check bypasses auth.
  if (c.req.path === "/health") return next();

  if (!API_KEY) {
    return c.json({ error: "API_KEY not configured" }, 500);
  }
  const key =
    c.req.query("apiKey") || c.req.header("x-api-key") || "";
  if (key !== API_KEY) {
    return c.json({ error: "Invalid API key" }, 401);
  }
  await next();
});

// ── Helpers ───────────────────────────────────────────────────────

function resolvePath(filePath: string): string | null {
  // Normalise and prevent path traversal.
  const resolved = path.resolve(VAULT_PATH, filePath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) return null;
  return resolved;
}

function walkDir(
  dir: string,
  base: string,
  results: string[] = [],
): string[] {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip hidden files/dirs (.obsidian, .trash, etc.)
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      walkDir(path.join(dir, entry.name), rel, results);
    } else {
      results.push(rel);
    }
  }
  return results;
}

// ── Routes ────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok" }));

// List all files in the vault.
app.get("/files", (c) => {
  const ext = c.req.query("ext"); // optional filter, e.g. "md"
  let files = walkDir(VAULT_PATH, "");
  if (ext) {
    files = files.filter((f) => f.endsWith(`.${ext}`));
  }
  return c.json({ files });
});

// Read a file's content.
app.get("/files/*", (c) => {
  const filePath = c.req.path.replace(/^\/files\//, "");
  const resolved = resolvePath(decodeURIComponent(filePath));
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) {
    return c.json({ error: "File not found" }, 404);
  }
  const content = fs.readFileSync(resolved, "utf-8");
  const stat = fs.statSync(resolved);
  return c.json({
    path: filePath,
    content,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  });
});

// Create or overwrite a file.
app.put("/files/*", async (c) => {
  const filePath = c.req.path.replace(/^\/files\//, "");
  const resolved = resolvePath(decodeURIComponent(filePath));
  if (!resolved) return c.json({ error: "Invalid path" }, 400);

  const body = await c.req.json();
  if (typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  // Ensure parent directory exists.
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, body.content, "utf-8");
  return c.json({ path: filePath, written: true }, 201);
});

// Append to a file (useful for daily notes).
app.post("/files/*", async (c) => {
  const filePath = c.req.path.replace(/^\/files\//, "");
  const resolved = resolvePath(decodeURIComponent(filePath));
  if (!resolved) return c.json({ error: "Invalid path" }, 400);

  const body = await c.req.json();
  if (typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(resolved, body.content, "utf-8");
  return c.json({ path: filePath, appended: true });
});

// Delete a file.
app.delete("/files/*", (c) => {
  const filePath = c.req.path.replace(/^\/files\//, "");
  const resolved = resolvePath(decodeURIComponent(filePath));
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) {
    return c.json({ error: "File not found" }, 404);
  }
  fs.unlinkSync(resolved);
  return c.json({ path: filePath, deleted: true });
});

// Search vault files by content (simple grep).
app.get("/search", (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "q param required" }, 400);

  const files = walkDir(VAULT_PATH, "").filter((f) =>
    f.endsWith(".md"),
  );
  const lower = query.toLowerCase();
  const results: Array<{
    path: string;
    matches: string[];
  }> = [];

  for (const file of files) {
    const resolved = resolvePath(file);
    if (!resolved || !fs.existsSync(resolved)) continue;
    const content = fs.readFileSync(resolved, "utf-8");
    if (content.toLowerCase().includes(lower)) {
      // Return matching lines for context.
      const lines = content.split("\n");
      const matching = lines.filter((l) =>
        l.toLowerCase().includes(lower),
      );
      results.push({
        path: file,
        matches: matching.slice(0, 5),
      });
    }
  }

  return c.json({ query, count: results.length, results });
});

// Daily note: append to today's daily note.
app.post("/daily/append", async (c) => {
  const body = await c.req.json();
  if (typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  // Default daily note format: YYYY-MM-DD.md in root or Daily/
  const today = new Date().toISOString().slice(0, 10);
  const dailyDir = body.folder ?? "Daily";
  const filePath = `${dailyDir}/${today}.md`;
  const resolved = resolvePath(filePath);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);

  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  // If file doesn't exist, create with a header.
  if (!fs.existsSync(resolved)) {
    fs.writeFileSync(
      resolved,
      `# ${today}\n\n${body.content}\n`,
      "utf-8",
    );
  } else {
    fs.appendFileSync(resolved, `\n${body.content}\n`, "utf-8");
  }

  return c.json({ path: filePath, appended: true });
});

// ── Start ────────────────────────────────────────────────────────

console.log(`obsidian-api listening on :${PORT}, vault: ${VAULT_PATH}`);
serve({ fetch: app.fetch, port: PORT });

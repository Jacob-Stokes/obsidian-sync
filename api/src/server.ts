import { serve } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

const app = new Hono();

const API_KEY = process.env.API_KEY || "";
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_BULK = parseInt(process.env.MAX_BULK || "500", 10);

// ── Auth ──────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  if (!API_KEY) return c.json({ error: "API_KEY not configured" }, 500);
  const key = c.req.query("apiKey") || c.req.header("x-api-key") || "";
  if (key !== API_KEY) return c.json({ error: "Invalid API key" }, 401);
  await next();
});

// ── Helpers ───────────────────────────────────────────────────────

function resolvePath(p: string): string | null {
  const cleaned = p.replace(/^\/+/, "");
  const resolved = path.resolve(VAULT_PATH, cleaned);
  const root = path.resolve(VAULT_PATH);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

interface WalkOpts {
  depth?: number;
  ext?: string;
  includeDirs?: boolean;
  dirsOnly?: boolean;
}

function walk(
  dir: string,
  base: string,
  opts: WalkOpts,
  results: Array<{ path: string; type: "file" | "dir" }> = [],
  currentDepth = 0,
): Array<{ path: string; type: "file" | "dir" }> {
  if (!fs.existsSync(dir)) return results;
  if (opts.depth !== undefined && currentDepth > opts.depth) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (opts.includeDirs || opts.dirsOnly) results.push({ path: rel, type: "dir" });
      walk(full, rel, opts, results, currentDepth + 1);
    } else if (!opts.dirsOnly) {
      if (opts.ext && !entry.name.endsWith(`.${opts.ext}`)) continue;
      results.push({ path: rel, type: "file" });
    }
  }
  return results;
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  modified?: string;
  children?: TreeNode[];
}

function buildTree(dir: string, base: string, depth?: number, currentDepth = 0): TreeNode[] {
  if (!fs.existsSync(dir)) return [];
  if (depth !== undefined && currentDepth >= depth) return [];
  const out: TreeNode[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        path: rel,
        type: "dir",
        children: buildTree(full, rel, depth, currentDepth + 1),
      });
    } else {
      const stat = fs.statSync(full);
      out.push({
        name: entry.name,
        path: rel,
        type: "file",
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function decodeSplat(c: any, prefix: string): string {
  return decodeURIComponent(c.req.path.replace(new RegExp(`^${prefix}/?`), ""));
}

// ── Health ────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", vault: VAULT_PATH }));

// ── Files ─────────────────────────────────────────────────────────

app.get("/files", (c) => {
  const dirQ = c.req.query("dir") || "";
  const ext = c.req.query("ext");
  const depth = c.req.query("depth") ? parseInt(c.req.query("depth")!, 10) : undefined;
  const root = dirQ ? resolvePath(dirQ) : VAULT_PATH;
  if (!root) return c.json({ error: "Invalid dir" }, 400);
  const results = walk(root, dirQ.replace(/^\/+|\/+$/g, ""), { ext, depth });
  return c.json({ dir: dirQ, files: results.map((r) => r.path) });
});

app.get("/files/*", (c) => {
  const rel = decodeSplat(c, "/files");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) return c.json({ error: "File not found" }, 404);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return c.json({ error: "Path is a directory — use /folders/*" }, 400);
  const format = c.req.query("format");
  if (format === "base64") {
    const buf = fs.readFileSync(resolved);
    return c.json({
      path: rel,
      contentBase64: buf.toString("base64"),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }
  const content = fs.readFileSync(resolved, "utf-8");
  return c.json({
    path: rel,
    content,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  });
});

app.on("HEAD", "/files/*", (c) => {
  const rel = decodeSplat(c, "/files");
  const resolved = resolvePath(rel);
  if (!resolved || !fs.existsSync(resolved)) return c.body(null, 404);
  const stat = fs.statSync(resolved);
  c.header("X-Size", String(stat.size));
  c.header("X-Modified", stat.mtime.toISOString());
  c.header("X-Type", stat.isDirectory() ? "dir" : "file");
  return c.body(null, 200);
});

app.put("/files/*", async (c) => {
  const rel = decodeSplat(c, "/files");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  const body = await c.req.json();
  if (typeof body.content !== "string" && typeof body.contentBase64 !== "string") {
    return c.json({ error: "content or contentBase64 is required" }, 400);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (typeof body.contentBase64 === "string") {
    fs.writeFileSync(resolved, Buffer.from(body.contentBase64, "base64"));
  } else {
    fs.writeFileSync(resolved, body.content, "utf-8");
  }
  const stat = fs.statSync(resolved);
  return c.json({ path: rel, written: true, size: stat.size }, 201);
});

app.post("/files/*", async (c) => {
  const rel = decodeSplat(c, "/files");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  const body = await c.req.json();
  if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, body.content, "utf-8");
  return c.json({ path: rel, appended: true });
});

app.delete("/files/*", (c) => {
  const rel = decodeSplat(c, "/files");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) return c.json({ error: "File not found" }, 404);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return c.json({ error: "Path is a directory — use /folders/*" }, 400);
  fs.unlinkSync(resolved);
  return c.json({ path: rel, deleted: true });
});

// ── Folders ───────────────────────────────────────────────────────

app.get("/folders", (c) => {
  const dirQ = c.req.query("dir") || "";
  const depth = c.req.query("depth") ? parseInt(c.req.query("depth")!, 10) : undefined;
  const root = dirQ ? resolvePath(dirQ) : VAULT_PATH;
  if (!root) return c.json({ error: "Invalid dir" }, 400);
  const results = walk(root, dirQ.replace(/^\/+|\/+$/g, ""), { dirsOnly: true, depth });
  return c.json({ dir: dirQ, folders: results.map((r) => r.path) });
});

app.get("/folders/*", (c) => {
  const rel = decodeSplat(c, "/folders");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) return c.json({ error: "Folder not found" }, 404);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return c.json({ error: "Not a folder" }, 400);
  const children: Array<{ name: string; type: "file" | "dir"; size?: number; modified?: string }> = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue;
    const full = path.join(resolved, entry.name);
    const s = fs.statSync(full);
    const item: { name: string; type: "file" | "dir"; size?: number; modified?: string } = {
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
    };
    if (entry.isFile()) {
      item.size = s.size;
      item.modified = s.mtime.toISOString();
    }
    children.push(item);
  }
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return c.json({
    path: rel,
    children,
    counts: {
      files: children.filter((x) => x.type === "file").length,
      folders: children.filter((x) => x.type === "dir").length,
    },
  });
});

app.put("/folders/*", (c) => {
  const rel = decodeSplat(c, "/folders");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  const existed = fs.existsSync(resolved);
  if (existed) {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return c.json({ error: "Path exists and is not a folder" }, 409);
  }
  fs.mkdirSync(resolved, { recursive: true });
  return c.json({ path: rel, created: !existed, existed }, existed ? 200 : 201);
});

app.on("HEAD", "/folders/*", (c) => {
  const rel = decodeSplat(c, "/folders");
  const resolved = resolvePath(rel);
  if (!resolved || !fs.existsSync(resolved)) return c.body(null, 404);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return c.body(null, 400);
  return c.body(null, 200);
});

app.delete("/folders/*", (c) => {
  const rel = decodeSplat(c, "/folders");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (resolved === path.resolve(VAULT_PATH)) return c.json({ error: "Refusing to delete vault root" }, 400);
  if (!fs.existsSync(resolved)) return c.json({ error: "Folder not found" }, 404);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return c.json({ error: "Not a folder" }, 400);
  const recursive = c.req.query("recursive") === "true";
  if (recursive) {
    fs.rmSync(resolved, { recursive: true, force: true });
  } else {
    const entries = fs.readdirSync(resolved).filter((n) => !isHidden(n));
    if (entries.length > 0) return c.json({ error: "Folder not empty — pass ?recursive=true" }, 409);
    fs.rmdirSync(resolved);
  }
  return c.json({ path: rel, deleted: true, recursive });
});

// ── Move / Copy ──────────────────────────────────────────────────

function moveOrCopy(mode: "move" | "copy") {
  return async (c: any) => {
    const body = await c.req.json();
    if (typeof body.from !== "string" || typeof body.to !== "string") {
      return c.json({ error: "from and to are required" }, 400);
    }
    const src = resolvePath(body.from);
    const dst = resolvePath(body.to);
    if (!src || !dst) return c.json({ error: "Invalid path" }, 400);
    if (!fs.existsSync(src)) return c.json({ error: "Source not found" }, 404);
    if (fs.existsSync(dst) && !body.overwrite) {
      return c.json({ error: "Destination exists — pass overwrite: true" }, 409);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (mode === "move") {
      fs.renameSync(src, dst);
    } else {
      const srcStat = fs.statSync(src);
      if (srcStat.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true, force: !!body.overwrite });
      } else {
        fs.copyFileSync(src, dst);
      }
    }
    const verb = mode === "move" ? "moved" : "copied";
    return c.json({ from: body.from, to: body.to, [verb]: true });
  };
}

app.post("/move", moveOrCopy("move"));
app.post("/copy", moveOrCopy("copy"));

// ── Tree ─────────────────────────────────────────────────────────

app.get("/tree", (c) => {
  const depth = c.req.query("depth") ? parseInt(c.req.query("depth")!, 10) : undefined;
  return c.json({ root: "", tree: buildTree(VAULT_PATH, "", depth) });
});

app.get("/tree/*", (c) => {
  const rel = decodeSplat(c, "/tree");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) return c.json({ error: "Not found" }, 404);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return c.json({ error: "Not a folder" }, 400);
  const depth = c.req.query("depth") ? parseInt(c.req.query("depth")!, 10) : undefined;
  return c.json({ root: rel, tree: buildTree(resolved, rel, depth) });
});

// ── Stats ────────────────────────────────────────────────────────

app.get("/stats", (c) => {
  let files = 0, folders = 0, notes = 0, totalSize = 0;
  const all = walk(VAULT_PATH, "", { includeDirs: true });
  for (const entry of all) {
    if (entry.type === "dir") {
      folders++;
    } else {
      files++;
      if (entry.path.endsWith(".md")) notes++;
      const abs = resolvePath(entry.path);
      if (abs) totalSize += fs.statSync(abs).size;
    }
  }
  return c.json({ files, folders, notes, totalSize, vault: VAULT_PATH });
});

// ── Search ───────────────────────────────────────────────────────

app.get("/search", (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "q param required" }, 400);
  const dirQ = c.req.query("path") || "";
  const regex = c.req.query("regex") === "true";
  const caseSensitive = c.req.query("case") === "true";
  const ext = c.req.query("ext") || "md";
  const root = dirQ ? resolvePath(dirQ) : VAULT_PATH;
  if (!root) return c.json({ error: "Invalid path" }, 400);

  let matcher: (line: string) => boolean;
  if (regex) {
    try {
      const re = new RegExp(query, caseSensitive ? "" : "i");
      matcher = (l) => re.test(l);
    } catch (e: any) {
      return c.json({ error: `Invalid regex: ${e.message}` }, 400);
    }
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matcher = (l) => (caseSensitive ? l : l.toLowerCase()).includes(needle);
  }

  const files = walk(root, dirQ.replace(/^\/+|\/+$/g, ""), { ext }).map((r) => r.path);
  const results: Array<{ path: string; matches: string[] }> = [];
  for (const file of files) {
    const abs = resolvePath(file);
    if (!abs || !fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    const hit = lines.filter(matcher);
    if (hit.length > 0) results.push({ path: file, matches: hit.slice(0, 5) });
  }
  return c.json({ query, path: dirQ, regex, case: caseSensitive, count: results.length, results });
});

// ── Daily ────────────────────────────────────────────────────────

function dailyFolder(override?: string): string {
  return override ?? "Daily";
}

app.get("/daily", (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const folder = dailyFolder(c.req.query("folder") || undefined);
  const rel = `${folder}/${today}.md`;
  const abs = resolvePath(rel);
  if (!abs || !fs.existsSync(abs)) return c.json({ path: rel, exists: false }, 404);
  return c.json({ path: rel, exists: true, content: fs.readFileSync(abs, "utf-8") });
});

app.get("/daily/:date", (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const folder = dailyFolder(c.req.query("folder") || undefined);
  const rel = `${folder}/${date}.md`;
  const abs = resolvePath(rel);
  if (!abs || !fs.existsSync(abs)) return c.json({ path: rel, exists: false }, 404);
  return c.json({ path: rel, exists: true, content: fs.readFileSync(abs, "utf-8") });
});

app.post("/daily/append", async (c) => {
  const body = await c.req.json();
  if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
  const today = new Date().toISOString().slice(0, 10);
  const folder = dailyFolder(body.folder);
  const rel = `${folder}/${today}.md`;
  const abs = resolvePath(rel);
  if (!abs) return c.json({ error: "Invalid path" }, 400);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, `# ${today}\n\n${body.content}\n`, "utf-8");
  } else {
    fs.appendFileSync(abs, `\n${body.content}\n`, "utf-8");
  }
  return c.json({ path: rel, appended: true });
});

// ── Bulk ────────────────────────────────────────────────────────

app.post("/bulk/write", async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body.files)) return c.json({ error: "files array required" }, 400);
  if (body.files.length > MAX_BULK) return c.json({ error: `max ${MAX_BULK} files per request` }, 400);
  const results: Array<{ path: string; written?: boolean; error?: string }> = [];
  for (const f of body.files) {
    if (typeof f.path !== "string" || (typeof f.content !== "string" && typeof f.contentBase64 !== "string")) {
      results.push({ path: String(f.path), error: "path + content or contentBase64 required" });
      continue;
    }
    const abs = resolvePath(f.path);
    if (!abs) {
      results.push({ path: f.path, error: "invalid path" });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (typeof f.contentBase64 === "string") {
        fs.writeFileSync(abs, Buffer.from(f.contentBase64, "base64"));
      } else {
        fs.writeFileSync(abs, f.content, "utf-8");
      }
      results.push({ path: f.path, written: true });
    } catch (e: any) {
      results.push({ path: f.path, error: e.message });
    }
  }
  const ok = results.filter((r) => r.written).length;
  return c.json({ count: results.length, written: ok, results });
});

app.post("/bulk/delete", async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body.paths)) return c.json({ error: "paths array required" }, 400);
  if (body.paths.length > MAX_BULK) return c.json({ error: `max ${MAX_BULK} paths per request` }, 400);
  const recursive = !!body.recursive;
  const results: Array<{ path: string; deleted?: boolean; error?: string }> = [];
  for (const p of body.paths) {
    const abs = resolvePath(p);
    if (!abs) {
      results.push({ path: p, error: "invalid path" });
      continue;
    }
    if (abs === path.resolve(VAULT_PATH)) {
      results.push({ path: p, error: "refusing to delete vault root" });
      continue;
    }
    if (!fs.existsSync(abs)) {
      results.push({ path: p, error: "not found" });
      continue;
    }
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        if (recursive) {
          fs.rmSync(abs, { recursive: true, force: true });
        } else {
          fs.rmdirSync(abs);
        }
      } else {
        fs.unlinkSync(abs);
      }
      results.push({ path: p, deleted: true });
    } catch (e: any) {
      results.push({ path: p, error: e.message });
    }
  }
  const ok = results.filter((r) => r.deleted).length;
  return c.json({ count: results.length, deleted: ok, results });
});

// ── Start ────────────────────────────────────────────────────────

console.log(`obsidian-api listening on :${PORT}, vault: ${VAULT_PATH}`);
serve({ fetch: app.fetch, port: PORT });

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

/**
 * PATCH /frontmatter/* — merge the given fields into the file's YAML
 * frontmatter block, preserving everything else (unknown fields, the
 * note body, quoting style, field order).
 *
 * Body: { fields: { [key]: string | number | boolean | null } }
 *   - Scalar values only. null means "delete this field".
 *   - To set an array or nested object, use PUT /files/* instead.
 *
 * If the file has no frontmatter block yet, one is prepended.
 *
 * This is safer than fetching the whole file, modifying, and PUTting
 * back — it's a single atomic read-modify-write on the server.
 */
app.patch("/frontmatter/*", async (c) => {
  const rel = decodeSplat(c, "/frontmatter");
  const resolved = resolvePath(rel);
  if (!resolved) return c.json({ error: "Invalid path" }, 400);
  if (!fs.existsSync(resolved)) return c.json({ error: "File not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body.fields !== "object" || body.fields === null) {
    return c.json({ error: "fields object required" }, 400);
  }
  const patch = body.fields as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null &&
      typeof v !== "string" &&
      typeof v !== "number" &&
      typeof v !== "boolean"
    ) {
      return c.json({ error: `field ${k} must be scalar or null` }, 400);
    }
  }

  const original = fs.readFileSync(resolved, "utf-8");
  const updated = mergeFrontmatter(original, patch);
  fs.writeFileSync(resolved, updated, "utf-8");
  const stat = fs.statSync(resolved);
  return c.json({ path: rel, written: true, size: stat.size });
});

/**
 * Same as PATCH /frontmatter/* but for N files in one request.
 *
 * Body: { patches: [{ path, fields }, ...] }
 */
app.post("/bulk/frontmatter", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.patches)) return c.json({ error: "patches array required" }, 400);
  if (body.patches.length > MAX_BULK) return c.json({ error: `max ${MAX_BULK} patches per request` }, 400);

  const results = await Promise.all(
    body.patches.map(async (p: unknown) => {
      if (!p || typeof p !== "object") return { path: String(p), error: "invalid patch" };
      const rec = p as Record<string, unknown>;
      const path_ = typeof rec.path === "string" ? rec.path : "";
      if (!path_) return { path: path_, error: "path required" };
      const fields = rec.fields as Record<string, unknown> | undefined;
      if (!fields || typeof fields !== "object") return { path: path_, error: "fields object required" };
      for (const [k, v] of Object.entries(fields)) {
        if (
          v !== null &&
          typeof v !== "string" &&
          typeof v !== "number" &&
          typeof v !== "boolean"
        ) {
          return { path: path_, error: `field ${k} must be scalar or null` };
        }
      }
      const abs = resolvePath(path_);
      if (!abs) return { path: path_, error: "invalid path" };
      if (!fs.existsSync(abs)) return { path: path_, error: "not found" };
      try {
        const original = fs.readFileSync(abs, "utf-8");
        const updated = mergeFrontmatter(original, fields);
        fs.writeFileSync(abs, updated, "utf-8");
        return { path: path_, written: true };
      } catch (e: any) {
        return { path: path_, error: e.message };
      }
    }),
  );

  const ok = results.filter((r) => r.written).length;
  return c.json({ count: results.length, written: ok, results });
});

/**
 * Merge a scalar patch into an existing markdown file's YAML
 * frontmatter. Preserves field order, quoting style, surrounding
 * body. Hand-rolled — no YAML parser dependency.
 *
 * Rules:
 *   - If the frontmatter block exists, each patch key replaces the
 *     existing value line (or is appended before `---` if missing).
 *   - If the file has no frontmatter, one is prepended.
 *   - null patch value removes the field.
 *   - Quoting: booleans/numbers unquoted, strings quoted with " if
 *     they'd otherwise be ambiguous (contains : # [ ] { } , or
 *     starts/ends with whitespace).
 */
function mergeFrontmatter(original: string, patch: Record<string, unknown>): string {
  const fenceStart = "---\n";
  const closingFence = "\n---";

  let fmBlock: string; // everything between the opening ---\n and the closing \n---
  let rest: string;    // everything after the closing fence (incl. the trailing \n)
  let hadFrontmatter: boolean;

  if (original.startsWith(fenceStart)) {
    const end = original.indexOf(closingFence, fenceStart.length);
    if (end === -1) {
      // Malformed: treat as no frontmatter.
      hadFrontmatter = false;
      fmBlock = "";
      rest = original;
    } else {
      hadFrontmatter = true;
      fmBlock = original.slice(fenceStart.length, end);
      rest = original.slice(end + closingFence.length);
    }
  } else {
    hadFrontmatter = false;
    fmBlock = "";
    rest = original;
  }

  const lines = fmBlock.length > 0 ? fmBlock.split("\n") : [];

  for (const [key, value] of Object.entries(patch)) {
    const { start, end } = findKeyBlock(lines, key);
    if (value === null) {
      if (start !== -1) lines.splice(start, end - start + 1);
      continue;
    }
    const formatted = `${key}: ${formatScalar(value as string | number | boolean)}`;
    if (start === -1) {
      lines.push(formatted);
    } else {
      // Replace the existing block (which might be multi-line for
      // lists) with a single scalar line. We only ever patch scalars,
      // so this is correct.
      lines.splice(start, end - start + 1, formatted);
    }
  }

  const newBlock = lines.join("\n");
  if (!hadFrontmatter) {
    return `${fenceStart}${newBlock}\n---\n${rest.startsWith("\n") ? rest.slice(1) : rest}`;
  }
  return `${fenceStart}${newBlock}${closingFence}${rest}`;
}

/**
 * Find the line range [start, end] inclusive that makes up the entry
 * for `key` in a frontmatter block. Handles both scalar (single line)
 * and list (multi-line with `  - item` continuations) forms. Returns
 * {start:-1, end:-1} if not found.
 */
function findKeyBlock(lines: string[], key: string): { start: number; end: number } {
  const keyRe = new RegExp(`^${escapeRegex(key)}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    // If the scalar after `:` is empty, we might be starting a list —
    // consume subsequent `  -` continuation lines.
    let end = i;
    if ((m[1] ?? "").trim() === "") {
      while (end + 1 < lines.length && /^\s{2,}-\s/.test(lines[end + 1])) {
        end++;
      }
    }
    return { start: i, end };
  }
  return { start: -1, end: -1 };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatScalar(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // String — quote if it could be ambiguous or contains control chars.
  const needsQuotes =
    /[:#\[\]\{\},&*!|>'"`%@]/.test(v) ||
    /^\s|\s$/.test(v) ||
    v === "" ||
    v === "true" ||
    v === "false" ||
    v === "null" ||
    /^-?\d/.test(v);
  if (!needsQuotes) return v;
  // Double-quoted, escape backslashes and double quotes.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

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

/**
 * Bulk read many files in one request. Much cheaper than N HTTP
 * round-trips when callers need a lot of files' content (e.g. a
 * Thesys "list all unread articles" view building an index).
 *
 * Body:
 *   paths:            string[]   — required, up to MAX_BULK entries
 *   frontmatterOnly:  boolean    — if true, return only the YAML
 *                                  frontmatter block ("---\n...\n---"),
 *                                  not the full body. Large wins on
 *                                  long notes. Defaults to false.
 *   format:           "utf-8" | "base64" — mirrors GET /files/*
 *
 * Response:
 *   { count, results: [{ path, content?, contentBase64?, size, modified } | { path, error }] }
 */
app.post("/bulk/read", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.paths)) return c.json({ error: "paths array required" }, 400);
  if (body.paths.length > MAX_BULK) return c.json({ error: `max ${MAX_BULK} paths per request` }, 400);
  const frontmatterOnly = body.frontmatterOnly === true;
  const format = body.format === "base64" ? "base64" : "utf-8";

  const results = await Promise.all(
    body.paths.map(async (p: unknown) => {
      if (typeof p !== "string") return { path: String(p), error: "invalid path" };
      const abs = resolvePath(p);
      if (!abs) return { path: p, error: "invalid path" };
      if (!fs.existsSync(abs)) return { path: p, error: "not found" };
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) return { path: p, error: "is a directory" };

        if (format === "base64") {
          // base64 + frontmatterOnly is a weird combo; we just read the
          // full bytes — frontmatterOnly only makes sense for utf-8.
          const buf = fs.readFileSync(abs);
          return {
            path: p,
            contentBase64: buf.toString("base64"),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        }

        const full = fs.readFileSync(abs, "utf-8");
        const content = frontmatterOnly ? sliceFrontmatter(full) : full;
        return {
          path: p,
          content,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };
      } catch (e: any) {
        return { path: p, error: e.message };
      }
    }),
  );

  return c.json({ count: results.length, results });
});

/**
 * Extract just the YAML frontmatter block (including the fences) from
 * a markdown file. Returns empty string if the file has no frontmatter.
 * Matches Obsidian's own convention: `---\n` at the very start, closing
 * `\n---` on its own line.
 */
function sliceFrontmatter(full: string): string {
  if (!full.startsWith("---\n")) return "";
  const end = full.indexOf("\n---", 4);
  if (end === -1) return "";
  return full.slice(0, end + 4);
}

// ── Start ────────────────────────────────────────────────────────

console.log(`obsidian-api listening on :${PORT}, vault: ${VAULT_PATH}`);
serve({ fetch: app.fetch, port: PORT });

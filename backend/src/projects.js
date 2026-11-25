// Build mode: turn a model's multi-file reply into a project (parse, sanitise, merge, check, zip).
import JSZip from "jszip";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_FILES = 80;
export const MAX_FILE_BYTES = 300_000;
export const MAX_TOTAL_BYTES = 2_000_000;

export const STACKS = [
  "Auto", "Python", "JavaScript (Node.js)", "TypeScript", "HTML/CSS/JavaScript (web)", "React",
  "Java", "C#", "Go", "Rust", "C++", "PHP", "Ruby", "Kotlin", "Swift",
];

const KNOWN_NAMES = new Set(["dockerfile", "makefile", "procfile", "gemfile", "rakefile", ".gitignore", ".env.example"]);

// Only relative paths inside the project. Blocks "../", absolute paths and drive letters (zip-slip).
export function cleanPath(p) {
  const s = String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!s || s.length > 200) return null;
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return null;
  if (/[\x00-\x1f<>|?*":]/.test(s)) return null;
  if (s.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return s;
}

// "### `src/app.py`", "**File: app.py**", "File: main.go:", "- `index.html`" -> the path, or null.
function labelOf(line) {
  const t = line
    .replace(/^[\s#>*\-\d.)]+/, "")
    .replace(/^(file(name)?|path)\s*:\s*/i, "")
    .replace(/^[`*_\s]+/, "")
    .replace(/[`*_:\s]+$/, "");
  if (!t || /\s/.test(t) || !/^[\w@.\-/\\]+$/.test(t)) return null;
  const base = t.split(/[\\/]/).pop().toLowerCase();
  if (!(KNOWN_NAMES.has(base) || /\.[A-Za-z0-9]{1,10}$/.test(base))) return null;
  return t;
}

const COMMENT_LABEL = /^\s*(?:\/\/|#|<!--|\/\*|--)\s*(?:file(?:name)?|path)\s*:\s*(\S+?)\s*(?:-->|\*\/)?\s*$/i;

export function parseFiles(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let label = null, labelAt = -10;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^\s*(```+|~~~+)[\w+#.-]*\s*$/.exec(line);
    if (!open) {
      if (line.trim()) { const l = labelOf(line); if (l) { label = l; labelAt = i; } }
      continue;
    }
    const fence = open[1];
    const body = [];
    let closed = false, j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*(```+|~~~+)\s*$/.test(lines[j])) { closed = true; break; }
      body.push(lines[j]);
    }
    let p = i - labelAt <= 3 ? label : null;
    if (!p && body.length) {
      const m = COMMENT_LABEL.exec(body[0]);
      if (m) { p = m[1]; body.shift(); }
    }
    if (p) out.push({ path: p, content: body.join("\n").replace(/\s+$/, "") + "\n", incomplete: !closed });
    label = null;
    i = closed ? j : lines.length;
  }
  return out;
}

// Merge new files over existing ones (same path = replaced). Returns the merged list plus problems.
export function mergeFiles(existing, incoming) {
  const map = new Map(existing.map((f) => [f.path, f.content]));
  const problems = [];
  const incomplete = [];
  for (const f of incoming) {
    const p = cleanPath(f.path);
    if (!p) { problems.push(`Skipped unsafe or invalid path "${f.path}".`); continue; }
    if (Buffer.byteLength(f.content) > MAX_FILE_BYTES) { problems.push(`Skipped ${p}: file is larger than ${MAX_FILE_BYTES / 1000} KB.`); continue; }
    if (!map.has(p) && map.size >= MAX_FILES) { problems.push(`Skipped ${p}: a project can have at most ${MAX_FILES} files.`); continue; }
    map.set(p, f.content);
    if (f.incomplete) incomplete.push(p);
  }
  let files = [...map].map(([p, content]) => ({ path: p, content })).sort((a, b) => a.path.localeCompare(b.path));
  let total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  while (total > MAX_TOTAL_BYTES && files.length) { // drop the largest until it fits
    const big = files.reduce((m, f) => (f.content.length > m.content.length ? f : m));
    problems.push(`Dropped ${big.path}: project exceeded ${MAX_TOTAL_BYTES / 1e6} MB.`);
    files = files.filter((f) => f !== big);
    total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  }
  return { files, problems, incomplete };
}

// Syntax-only checks (never executes the code): JavaScript via `node --check`, and JSON.
function nodeCheck(code, ext) {
  return new Promise(async (resolve) => {
    let dir;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), "chk-"));
      const file = path.join(dir, `f${ext}`);
      await writeFile(file, code);
      execFile(process.execPath, ["--check", file], { timeout: 10000 }, (err, _o, stderr) => {
        if (!err) return resolve(null);
        const lines = String(stderr).split("\n").map((l) => l.trim()).filter(Boolean);
        const msg = lines.find((l) => /Error/.test(l)) || lines[0] || err.message;
        const at = lines.find((l) => /:\d+$/.test(l))?.replace(/^.*[\\/]/, "");
        resolve(`${msg}${at ? ` (${at.replace(/^f\.[a-z]+/, "line")})` : ""}`);
      });
    } catch (e) { resolve(null); }
    finally { if (dir) setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => {}), 12000); }
  });
}

export async function checkFiles(files) {
  const warnings = [];
  for (const f of files) {
    if (/\.(js|mjs|cjs)$/i.test(f.path)) {
      const esm = /^\s*(import\s|export\s)/m.test(f.content) || f.path.endsWith(".mjs");
      const msg = await nodeCheck(f.content, esm ? ".mjs" : ".cjs");
      if (msg) warnings.push({ path: f.path, message: msg });
    } else if (/\.json$/i.test(f.path)) {
      try { JSON.parse(f.content); } catch (e) { warnings.push({ path: f.path, message: `Invalid JSON: ${e.message}` }); }
    }
  }
  return warnings;
}

export async function toZip(files, root) {
  const zip = new JSZip();
  for (const f of files) zip.file(`${root}/${f.path}`, f.content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project";

// ---------- prompt ----------
export function buildSystemPrompt(stack, files, budgetChars) {
  let ctx = "";
  if (files.length) {
    const list = files.map((f) => `- ${f.path}`).join("\n");
    let used = 0, shown = "";
    for (const f of files) {
      const room = budgetChars - used;
      if (room < 300) break;
      const body = f.content.length > room ? f.content.slice(0, room) + "\n… (truncated)" : f.content;
      shown += `\n### \`${f.path}\`\n\`\`\`\n${body}\n\`\`\`\n`;
      used += body.length + f.path.length + 20;
    }
    ctx = `\n\nThe project already exists. Files:\n${list}\n\nCurrent contents:${shown}\nWhen the user asks for changes, output ONLY the files that change or are new, each one complete.`;
  }
  return `You are an expert software engineer. Build a complete, working application for the user.
${stack && stack !== "Auto" ? `Use ${stack}.` : "Pick the language and framework that best fit the request, unless the user names one."}

Rules:
1. Begin with a short plan (2 to 4 lines) naming the files you will write.
2. Then output EVERY file in full. For each file write a heading line with the path in backticks, like ### \`src/main.py\`, followed by one fenced code block holding the complete file. Never use "..." or "rest of the code unchanged".
3. Include the dependency and config files the stack needs (requirements.txt, package.json, pom.xml, go.mod, Cargo.toml, and so on) and a README.md with exact setup and run commands.
4. Keep it as small and simple as will work. Prefer the standard library.
5. A web app with no backend must be index.html + style.css + script.js so it can be previewed.
6. End with a short "How to run" section.${ctx}`;
}

import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { readFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import Papa from "papaparse";
import * as cheerio from "cheerio";

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---------- files ----------
export function csvToDocument(text) {
  const parsed = Papa.parse(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true });
  const rows = parsed.data
    .map((row) =>
      Object.entries(row)
        .filter(([, v]) => v !== "" && v != null)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ")
    )
    .filter(Boolean);
  if (!rows.length) throw bad("That CSV file has no rows with data.");
  // One line per row, so the splitter breaks between rows rather than inside them.
  return new Document({ pageContent: rows.join("\n"), metadata: {} });
}

export async function loadFileDocs(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return new PDFLoader(filePath, { splitPages: true }).load();
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    if (!value.trim()) throw bad("No text found in that Word document.");
    return [new Document({ pageContent: value, metadata: {} })];
  }
  if (ext === ".csv") return [csvToDocument(await readFile(filePath, "utf8"))];
  return [new Document({ pageContent: await readFile(filePath, "utf8"), metadata: {} })];
}

// ---------- web pages ----------
// Basic guard so the server can't be pointed at local or private addresses.
export function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw bad("That doesn't look like a valid URL."); }
  if (!/^https?:$/.test(url.protocol)) throw bad("Only http and https URLs are supported.");
  const h = url.hostname.toLowerCase();
  const privateHost =
    h === "localhost" || h === "[::1]" || h.endsWith(".local") || h.endsWith(".internal") ||
    /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (privateHost) throw bad("Local and private addresses are not allowed.");
  return url;
}

export function extractPage(html) {
  const $ = cheerio.load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  $("script,style,noscript,nav,footer,header,aside,form,svg,iframe").remove();
  $("p,div,li,h1,h2,h3,h4,h5,h6,tr,br,section").after("\n");
  const root = $("main, article").first().length ? $("main, article").first() : $("body");
  const text = root.text()
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function loadUrlDocs(raw, timeoutMs = 20000) {
  const url = assertPublicUrl(raw);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DocQA/1.0)", Accept: "text/html,text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw bad(`Couldn't fetch that URL: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw bad(`The page returned HTTP ${res.status}.`);
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
    throw bad("Only HTML or text pages are supported. For a PDF, download it and upload the file.");
  }
  const body = (await res.text()).slice(0, 5_000_000);
  const { title, text } = /html/.test(type) ? extractPage(body) : { title: "", text: body.trim() };
  if (text.length < 200) {
    throw bad("Couldn't extract readable text from that page (it may need JavaScript to load).");
  }
  return {
    filename: title || `${url.hostname}${url.pathname}`.slice(0, 120),
    url: url.toString(),
    docs: [new Document({ pageContent: text, metadata: {} })],
  };
}

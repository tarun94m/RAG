// Turns Markdown into downloadable files (Word, PDF, Excel, CSV, HTML, MD, TXT)
// and decides when a chat message is asking for one.
import { marked, Marked } from "marked";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, LevelFormat, AlignmentType, ShadingType, BorderStyle,
} from "docx";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";

// ---------- intent detection ----------
const VERB = /\b(create|make|generate|write|draft|build|prepare|produce|compose|export|save|convert|turn|give|put)\b/i;
const EXPLICIT_AS = /\b(as|into|in|to)\s+(a |an |the )?(ms |microsoft )?(pdf|word|docx|excel|xlsx|spreadsheet|csv)\b/i;
const CODEY = /\b(script|code|function|program|python|javascript|typescript|node\.?js|java|api|library|module|regex|sql|class|react|bash|command)\b/i;
const FORMATS = [
  ["pdf", /\bpdf\b/i],
  ["docx", /\bdocx\b|\bword\b.{0,12}\b(doc|document|file|report)\b|\b(as|in|into|to)\s+(a |an )?(ms |microsoft )?word\b/i],
  ["xlsx", /\b(excel|xlsx|spreadsheet)\b/i],
  ["csv", /\bcsv\b/i],
  ["html", /\.html\b|\bhtml file\b/i],
  ["md", /\b(markdown|md) file\b|\.md\b/i],
  ["txt", /\b(text|txt) file\b|\.txt\b/i],
];

export function detectFileRequest(text) {
  const t = String(text || "");
  if (!VERB.test(t) && !EXPLICIT_AS.test(t)) return null;
  const hit = FORMATS.find(([, re]) => re.test(t));
  if (!hit) return null;
  if (CODEY.test(t) && !EXPLICIT_AS.test(t)) return null;
  return hit[0];
}

export const FORMAT_LABELS = {
  docx: "Word document", pdf: "PDF document", xlsx: "Excel spreadsheet",
  csv: "CSV file", html: "HTML page", md: "Markdown file", txt: "text file",
};

// ---------- helpers ----------
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Inline tokens -> flat list of styled text runs.
function runs(tokens = [], style = {}) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case "strong": out.push(...runs(t.tokens, { ...style, bold: true })); break;
      case "em": out.push(...runs(t.tokens, { ...style, italic: true })); break;
      case "del": out.push(...runs(t.tokens, { ...style, strike: true })); break;
      case "link": out.push(...runs(t.tokens, { ...style, link: t.href })); break;
      case "codespan": out.push({ ...style, text: decode(t.text), code: true }); break;
      case "br": out.push({ ...style, text: "\n" }); break;
      case "html": break;
      default:
        if (t.tokens?.length) out.push(...runs(t.tokens, style));
        else out.push({ ...style, text: decode(t.text ?? t.raw ?? "") });
    }
  }
  return out;
}
const plain = (tokens) => runs(tokens).map((r) => r.text).join("");
const inlineOf = (tok) => tok.tokens || [{ type: "text", text: tok.text }];

export function titleOf(md) {
  const m = /^#\s+(.+)$/m.exec(md);
  return (m ? m[1] : "document").replace(/[*_`#]/g, "").trim();
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";

// ---------- Word ----------
async function toDocx(md) {
  const tokens = marked.lexer(md);
  const children = [];
  const numbering = [];
  let listNo = 0;

  const levels = (fmt) => [0, 1, 2, 3].map((i) => ({
    level: i, format: fmt, text: fmt === LevelFormat.BULLET ? "•" : `%${i + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
  }));
  numbering.push({ reference: "bul", levels: levels(LevelFormat.BULLET) });

  const mk = (rs) => rs.map((r) =>
    r.text === "\n" ? new TextRun({ break: 1 }) :
    new TextRun({
      text: r.text, bold: r.bold, italics: r.italic, strike: r.strike,
      font: r.code ? "Consolas" : undefined,
      color: r.link ? "0563C1" : undefined, underline: r.link ? {} : undefined,
    }));

  const heads = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

  function list(l, depth) {
    let ref = "bul";
    if (l.ordered) { ref = `num${++listNo}`; numbering.push({ reference: ref, levels: levels(LevelFormat.DECIMAL) }); }
    for (const item of l.items) {
      for (const sub of item.tokens) {
        if (sub.type === "text" || sub.type === "paragraph") {
          children.push(new Paragraph({ children: mk(runs(inlineOf(sub))), numbering: { reference: ref, level: Math.min(depth, 3) } }));
        } else if (sub.type === "list") list(sub, depth + 1);
        else block(sub);
      }
    }
  }

  function block(t) {
    switch (t.type) {
      case "heading":
        children.push(new Paragraph({ heading: heads[Math.min(t.depth, 6) - 1], children: mk(runs(t.tokens)) })); break;
      case "paragraph":
        children.push(new Paragraph({ spacing: { after: 120 }, children: mk(runs(t.tokens)) })); break;
      case "text":
        children.push(new Paragraph({ children: mk(runs(inlineOf(t))) })); break;
      case "list": list(t, 0); break;
      case "code":
        for (const line of t.text.split("\n")) {
          children.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
            children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
          }));
        }
        children.push(new Paragraph({ children: [] }));
        break;
      case "blockquote":
        for (const sub of t.tokens) {
          if (sub.type === "paragraph" || sub.type === "text") {
            children.push(new Paragraph({
              indent: { left: 540 },
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: "AAAAAA", space: 8 } },
              children: mk(runs(inlineOf(sub), { italic: true })),
            }));
          }
        }
        break;
      case "hr":
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" } }, children: [] })); break;
      case "table": {
        const n = t.header.length;
        const cell = (c, bold) => new TableCell({
          width: { size: Math.floor(100 / n), type: WidthType.PERCENTAGE },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: mk(runs(c.tokens, bold ? { bold: true } : {})) })],
          shading: bold ? { type: ShadingType.CLEAR, fill: "E7E6E6" } : undefined,
        });
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }),
            ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
          ],
        }));
        children.push(new Paragraph({ children: [] }));
        break;
      }
      default: break; // space, html
    }
  }

  tokens.forEach(block);
  if (!children.length) children.push(new Paragraph({ children: [new TextRun(" ")] }));
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: { config: numbering },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// ---------- PDF ----------
async function toPdf(md) {
  const doc = new PDFDocument({ margin: 56, size: "A4", info: { Title: titleOf(md) } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const finished = new Promise((r) => doc.on("end", r));

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const fontFor = (r) =>
    r.code ? "Courier" :
    r.bold && r.italic ? "Helvetica-BoldOblique" :
    r.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : "Helvetica";

  function inline(rs, { size = 11, indent = 0, gap = 0.4 } = {}) {
    rs = rs.filter((r) => r.text !== "");
    if (!rs.length) return;
    rs.forEach((r, i) => {
      doc.font(fontFor(r)).fontSize(size).fillColor(r.link ? "#0563C1" : "#111111");
      const last = i === rs.length - 1;
      const opts = { continued: !last, width: width - indent, link: r.link, underline: !!r.link, strike: !!r.strike };
      if (i === 0) doc.text(r.text, left + indent, undefined, opts);
      else doc.text(r.text, opts);
    });
    doc.x = left;
    doc.moveDown(gap);
  }

  function list(l, depth) {
    let n = l.start || 1;
    for (const item of l.items) {
      let first = true;
      for (const sub of item.tokens) {
        if (sub.type === "text" || sub.type === "paragraph") {
          const marker = l.ordered ? `${n}. ` : "•  ";
          inline([{ text: marker }, ...runs(inlineOf(sub))], { indent: 14 * (depth + 1), gap: 0.2 });
          first = false;
        } else if (sub.type === "list") list(sub, depth + 1);
        else block(sub);
      }
      if (first) n += 0;
      n++;
    }
    doc.moveDown(0.2);
  }

  function table(t) {
    const n = t.header.length, pad = 4, w = width / n;
    const draw = (cells, header) => {
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      const texts = cells.map((c) => plain(c.tokens));
      const h = Math.max(...texts.map((s) => doc.heightOfString(s, { width: w - 2 * pad }))) + 2 * pad;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const y = doc.y;
      texts.forEach((s, i) => {
        if (header) doc.rect(left + i * w, y, w, h).fillAndStroke("#E7E6E6", "#999999");
        else doc.rect(left + i * w, y, w, h).stroke("#999999");
        doc.fillColor("#111111").font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9)
          .text(s, left + i * w + pad, y + pad, { width: w - 2 * pad });
      });
      doc.x = left; doc.y = y + h;
    };
    draw(t.header, true);
    t.rows.forEach((r) => draw(r, false));
    doc.x = left; doc.moveDown(0.8);
  }

  const sizes = [22, 18, 15, 13, 12, 11];
  function block(t) {
    switch (t.type) {
      case "heading":
        doc.moveDown(0.3);
        inline(runs(t.tokens, { bold: true }), { size: sizes[Math.min(t.depth, 6) - 1], gap: 0.4 });
        break;
      case "paragraph": case "text": inline(runs(inlineOf(t))); break;
      case "list": list(t, 0); break;
      case "code": {
        doc.font("Courier").fontSize(9);
        const h = doc.heightOfString(t.text, { width: width - 12 }) + 12;
        if (h < doc.page.height - doc.page.margins.top - doc.page.margins.bottom) {
          if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
          doc.rect(left, doc.y, width, h).fill("#F2F2F2");
          doc.fillColor("#111111").text(t.text, left + 6, doc.y + 6, { width: width - 12 });
          doc.y += 6;
        } else doc.fillColor("#111111").text(t.text, left, undefined, { width });
        doc.x = left; doc.moveDown(0.6);
        break;
      }
      case "blockquote":
        for (const sub of t.tokens) {
          if (sub.type === "paragraph" || sub.type === "text") inline(runs(inlineOf(sub), { italic: true }), { indent: 16 });
        }
        break;
      case "hr":
        doc.moveTo(left, doc.y).lineTo(left + width, doc.y).stroke("#999999"); doc.moveDown(0.6); break;
      case "table": table(t); break;
      default: break;
    }
  }

  marked.lexer(md).forEach(block);
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

// ---------- Excel / CSV ----------
const cellValue = (s) => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : s);

async function toXlsx(md) {
  const wb = new ExcelJS.Workbook();
  const used = new Set();
  let heading = "", n = 0;
  const sheetName = (base) => {
    let name = base.replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 28) || `Sheet${n}`;
    let i = 2, out = name;
    while (used.has(out.toLowerCase())) out = `${name.slice(0, 25)} ${i++}`;
    used.add(out.toLowerCase());
    return out;
  };

  const tokens = marked.lexer(md);
  for (const t of tokens) {
    if (t.type === "heading") heading = plain(t.tokens);
    if (t.type !== "table") continue;
    n++;
    const ws = wb.addWorksheet(sheetName(heading || `Sheet${n}`));
    const rows = [t.header.map((c) => plain(c.tokens)), ...t.rows.map((r) => r.map((c) => cellValue(plain(c.tokens))))];
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.columns.forEach((col, i) => {
      const longest = Math.max(...rows.map((r) => String(r[i] ?? "").length));
      col.width = Math.min(Math.max(longest + 2, 10), 60);
    });
  }
  if (!n) {
    const ws = wb.addWorksheet("Content");
    const lines = [];
    const walk = (ts) => ts.forEach((t) => {
      if (t.type === "list") t.items.forEach((it) => walk(it.tokens));
      else if (t.type === "code") t.text.split("\n").forEach((l) => lines.push(l));
      else if (["heading", "paragraph", "text"].includes(t.type)) lines.push(plain(inlineOf(t)));
    });
    walk(tokens);
    lines.filter(Boolean).forEach((l) => ws.addRow([l]));
    ws.getColumn(1).width = 100;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toCsv(md) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const t = marked.lexer(md).find((x) => x.type === "table");
  const rows = t
    ? [t.header.map((c) => plain(c.tokens)), ...t.rows.map((r) => r.map((c) => plain(c.tokens)))]
    : md.split("\n").filter((l) => l.trim()).map((l) => [l.replace(/^[#>*\-\s]+/, "")]);
  return Buffer.from("\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n"), "utf8");
}

// ---------- HTML ----------
function toHtml(md) {
  const m = new Marked({ renderer: { html: () => "" } }); // drop raw HTML from the model
  const body = m.parse(md).replace(/href="\s*javascript:[^"]*"/gi, 'href="#"');
  const title = titleOf(md).replace(/[<>&]/g, "");
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1d2b2a}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}th{background:#eee}pre{background:#f3f3f3;padding:12px;overflow:auto}code{font-family:Consolas,monospace}</style>
</head><body>${body}</body></html>`, "utf8");
}

// ---------- entry point ----------
const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

export async function renderFile(format, markdown) {
  const md = markdown.trim();
  if (!md) throw new Error("The model returned no content to put in the file.");
  const buffer =
    format === "docx" ? await toDocx(md) :
    format === "pdf" ? await toPdf(md) :
    format === "xlsx" ? await toXlsx(md) :
    format === "csv" ? toCsv(md) :
    format === "html" ? toHtml(md) :
    Buffer.from(md, "utf8");
  return { name: `${slug(titleOf(md))}.${format}`, mime: MIME[format], buffer };
}

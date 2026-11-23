// Scores retrieval (and optionally answers) against a question set.
//
//   npm run eval                          -> uses eval/questions.json
//   npm run eval -- my-questions.json     -> custom file
//   npm run eval -- --answers             -> also generate answers and check them (slower)
//
// Each question:
//   { "question": "...",
//     "doc": "refund",                      // optional: part of the filename it should come from
//     "contains": ["30 days", "thirty days"],  // a retrieved chunk "hits" if it has ANY of these
//     "answerContains": ["30"] }            // with --answers: the answer must have ALL of these
import { readFile } from "node:fs/promises";
import { retrieve, askStream, listDocuments, TOP_K } from "../src/rag.js";

const args = process.argv.slice(2);
const withAnswers = args.includes("--answers");
const file = args.find((a) => a.endsWith(".json")) || "eval/questions.json";

const questions = JSON.parse(await readFile(file, "utf8"));
const docs = await listDocuments();
const has = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());

console.log(`Eval: ${questions.length} questions from ${file}`);
console.log(`Config: embeddings=${process.env.EMBEDDINGS_PROVIDER || "ollama"} chat=${process.env.CHAT_PROVIDER || "ollama"} ` +
  `chunk=${process.env.CHUNK_SIZE || 1000}/${process.env.CHUNK_OVERLAP || 150} topK=${TOP_K}`);
console.log(`Indexed documents: ${docs.length}\n`);

let hits = 0, mrr = 0, answered = 0, answerOk = 0, skipped = 0;

for (const q of questions) {
  const docIds = q.doc
    ? docs.filter((d) => has(d.filename, q.doc)).map((d) => d.docId)
    : [];
  if (q.doc && !docIds.length) {
    console.log(`-  SKIP  "${q.question}"  (no indexed document matches "${q.doc}")`);
    skipped++;
    continue;
  }

  const top = await retrieve(q.question, docIds);
  const rank = top.findIndex(
    (d) => !q.contains?.length || q.contains.some((c) => has(d.pageContent, c))
  );
  const hit = rank !== -1;
  if (hit) { hits++; mrr += 1 / (rank + 1); }

  let line = `${hit ? "ok" : "MISS"}  ${hit ? `rank ${rank + 1}` : "not in top " + TOP_K}  "${q.question}"`;

  if (withAnswers && q.answerContains?.length) {
    let answer = "";
    for await (const ev of askStream(q.question, [], docIds)) if (ev.type === "token") answer += ev.data;
    const ok = q.answerContains.every((a) => has(answer, a));
    answered++;
    if (ok) answerOk++;
    line += `   answer: ${ok ? "ok" : "WRONG"}`;
    if (!ok) line += `\n      got: ${answer.replace(/\s+/g, " ").slice(0, 200)}`;
  }
  console.log(line);
}

const scored = questions.length - skipped;
console.log("\n--- Summary ---");
console.log(`Retrieval hit rate @${TOP_K}: ${hits}/${scored} (${scored ? Math.round((hits / scored) * 100) : 0}%)`);
console.log(`Mean reciprocal rank:       ${scored ? (mrr / scored).toFixed(3) : "n/a"}`);
if (withAnswers) console.log(`Answer check:               ${answerOk}/${answered}`);
process.exit(0);

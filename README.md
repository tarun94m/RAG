# Document Q&A: React + Node.js + LangChain + Postgres (pgvector) + Docker

Upload PDF/TXT/MD files, chunk and embed them, store vectors in Postgres, and ask questions answered from retrieved passages.

## Run

```bash
cp .env.example .env      # add your OPENAI_API_KEY
docker compose up --build
```

Open http://localhost:3000

## How it works

1. **Ingest** (`POST /api/documents`): multer receives the file, LangChain loads it (PDFLoader for PDFs), `RecursiveCharacterTextSplitter` makes ~1000-char chunks with 150 overlap, `OpenAIEmbeddings` embeds them, and `PGVectorStore` writes them to the `chunks` table (with HNSW and full-text indexes).
2. **Ask** (`POST /api/chat`, streamed over server-sent events):
   - Follow-up questions are rewritten into standalone queries.
   - **Hybrid retrieval:** top 20 from pgvector similarity and top 20 from Postgres full-text search, merged with reciprocal rank fusion.
   - **Reranking:** if `COHERE_API_KEY` is set, Cohere rerank picks the best 4; otherwise the top 4 of the fused list are used.
   - Sources are sent first, then answer tokens as they are generated.
3. **Scope:** tick documents in the sidebar to restrict search to them (`docIds` in the request); no ticks means all documents.
4. **Manage** (`GET/DELETE /api/documents`): list and remove documents.

## Features

- **Build apps:** switch to **Build app**, pick a language (or Auto), and describe what you want. The model writes a complete multi-file project (Python, JavaScript/Node, TypeScript, React, Java, C#, Go, Rust, C++, PHP, Ruby, Kotlin, Swift, or plain web). The project is saved per chat; ask for changes and only the affected files are updated. A side panel shows the files, runs a sandboxed live preview for web apps, flags JavaScript/JSON syntax errors, and downloads everything as a ZIP. Code is never executed by the server.

- **Stop / Regenerate / Edit:** cancel a reply mid-way (the partial answer is kept), regenerate the last answer, or edit your last message and resend.
- **Model picker:** switch between installed Ollama models and hosted models (Gemini, Claude, OpenAI) from a dropdown; hosted models appear when their API key is in `.env`.
- **Attach files in the chat box:** drag, paste or click Attach; the file is indexed and the question is answered from it.
- **PowerPoint (.pptx)** joins Word, PDF, Excel, CSV, HTML and Markdown as a file you can ask for.
- **Chat tools:** search past chats, export a chat to Markdown, PDF or Word.

- **General assistant:** chat, code (with Copy/Download on every code block), web search, and file creation. Turn on **My documents** to answer from your uploads instead.
- **Create files by asking:** "make a Word document about…", "create a PDF report on…", "generate an Excel sheet of…". Supports Word, PDF, Excel, CSV, HTML, Markdown and text. Files are stored in Postgres and downloadable from the chat.

- **Inputs:** PDF, Word (.docx), CSV, TXT, Markdown, or paste a web page URL.
- **Saved chats:** stored in Postgres (`conversations`, `messages`); reopen, rename, delete from the Chats tab.
- **Hybrid retrieval, optional reranking, streaming answers, per-document scope.**
- **Eval:** measure retrieval quality (see below).

## Evaluating answer quality

1. Upload the documents your questions are about.
2. Copy `backend/eval/questions.example.json` to `backend/eval/questions.json` and write your own questions
   (`contains` = a retrieved chunk counts as a hit if it has any of these phrases; `answerContains` = words the answer must include).
3. From `backend/`: `npm run eval` (retrieval only) or `npm run eval -- --answers` (also checks generated answers).
4. To compare settings: change `CHUNK_SIZE`, `CHUNK_OVERLAP` or `TOP_K` in `.env`, delete and re-upload the documents
   (chunking happens at upload), and run the eval again. Compare hit rate and mean reciprocal rank.

## Local dev without Docker

```bash
docker compose up db -d     # add ports: ["5432:5432"] to the db service first
cd backend && npm i && DATABASE_URL=postgresql://rag:rag@localhost:5432/rag OPENAI_API_KEY=... npm run dev
cd frontend && npm i && npm run dev     # http://localhost:5173
```

## Swapping models

Edit `backend/src/rag.js`. For example, use `@langchain/ollama` (`OllamaEmbeddings`, `ChatOllama`) for fully local runs, and update `dimensions` to the embedding model's size (e.g. 768 for nomic-embed-text). Drop the `chunks` table if you change dimensions.

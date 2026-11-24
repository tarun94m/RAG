import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function initChatTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL DEFAULT 'New chat',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id bigserial PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role text NOT NULL,
    content text NOT NULL,
    sources jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS files jsonb`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb`);
  await pool.query(`CREATE TABLE IF NOT EXISTS generated_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    mime text NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, id)`);
}

export async function listConversations(q = "") {
  const term = q.trim();
  if (!term) {
    const { rows } = await pool.query(
      `SELECT id, title, updated_at AS "updatedAt" FROM conversations ORDER BY updated_at DESC LIMIT 200`
    );
    return rows;
  }
  const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.updated_at AS "updatedAt"
     FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.title ILIKE $1 OR m.content ILIKE $1
     GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100`, [like]
  );
  return rows;
}

export async function createConversation(title) {
  const { rows } = await pool.query(
    `INSERT INTO conversations (title) VALUES ($1) RETURNING id, title`, [title]
  );
  return rows[0];
}

export async function getConversation(id) {
  const c = await pool.query(`SELECT id, title FROM conversations WHERE id = $1`, [id]);
  if (!c.rows.length) return null;
  const m = await pool.query(
    `SELECT role, content, sources, files, attachments FROM messages WHERE conversation_id = $1 ORDER BY id`, [id]
  );
  return { ...c.rows[0], messages: m.rows.map((r) => ({ ...r, sources: r.sources || [], files: r.files || [], attachments: r.attachments || [] })) };
}

export async function recentMessages(id, n = 6) {
  const { rows } = await pool.query(
    `SELECT role, content FROM (
       SELECT id, role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
     ) t ORDER BY id`, [id, n]
  );
  return rows;
}

export async function addMessage(id, role, content, sources = null, files = null, attachments = null) {
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content, sources, files, attachments) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, role, content, sources ? JSON.stringify(sources) : null, files?.length ? JSON.stringify(files) : null,
     attachments?.length ? JSON.stringify(attachments) : null]
  );
  await pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [id]);
}

export async function renameConversation(id, title) {
  const { rowCount } = await pool.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [id, title]);
  return rowCount > 0;
}

export async function deleteConversation(id) {
  await pool.query(`DELETE FROM conversations WHERE id = $1`, [id]);
}

export async function saveFile(name, mime, buffer) {
  const { rows } = await pool.query(
    `INSERT INTO generated_files (name, mime, data) VALUES ($1, $2, $3) RETURNING id`, [name, mime, buffer]
  );
  return rows[0].id;
}

export async function getFile(id) {
  const { rows } = await pool.query(`SELECT name, mime, data FROM generated_files WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Remove the last question and its answer (used by "regenerate" and "edit and resend").
export async function popLastExchange(id) {
  const { rows } = await pool.query(
    `SELECT id, role FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 2`, [id]
  );
  const ids = [];
  if (rows[0]?.role === "assistant") {
    ids.push(rows[0].id);
    if (rows[1]?.role === "user") ids.push(rows[1].id);
  } else if (rows[0]?.role === "user") ids.push(rows[0].id);
  if (ids.length) await pool.query(`DELETE FROM messages WHERE id = ANY($1)`, [ids]);
}

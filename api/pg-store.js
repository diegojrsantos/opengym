// Storage abstraction for openGym: backs the JSON "files" (db, per-user state, secret, vapid,
// audit log) with either Postgres (when DATABASE_URL is set) or the local filesystem (fallback).
// The rest of server.js only ever calls kvGet/kvSet/kvDel, so switching backends is transparent.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const DATA = process.env.DATA_DIR || '/tmp/data'
let pool = null
let usingPg = false

export async function kvInit() {
  const url = process.env.DATABASE_URL
  // No DATABASE_URL => explicit local-dev mode: files under DATA_DIR. This is intentional, not a
  // fallback for a broken DB — if a DB URL is configured we REQUIRE it to be reachable.
  if (!url) {
    fs.mkdirSync(DATA, { recursive: true })
    console.log(`store=file (${DATA})`)
    return
  }
  // DATABASE_URL is set: Postgres is the backend. Retry a few times to survive DB cold starts,
  // then fail loudly instead of silently degrading to file storage (which would lose data).
  let lastErr
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })
      await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb)')
      usingPg = true
      let target = url
      try { const u = new URL(url); target = `${u.hostname}:${u.port || 5432}` } catch {}
      console.log(`store=postgres (${target}) [attempt ${attempt}]`)
      return
    } catch (e) {
      lastErr = e
      try { await pool?.end() } catch {}
      pool = null
      if (attempt < 5) {
        console.error(`Postgres connect failed (${e.code || e.message}); retry ${attempt}/5...`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }
  throw new Error(`Postgres unreachable after 5 attempts: ${lastErr?.code || lastErr?.message}`)
}

async function fileGet(k) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, k), 'utf8')) } catch { return null }
}
async function fileSet(k, v) {
  fs.writeFileSync(path.join(DATA, k), JSON.stringify(v))
}

export async function kvGet(k) {
  if (usingPg) {
    const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k])
    return r.rows[0] ? r.rows[0].v : null
  }
  return fileGet(k)
}
export async function kvSet(k, v) {
  if (usingPg) {
    // node-postgres does not reliably serialize a JS object to jsonb on its own — pass explicit
    // JSON text so the column parser always receives valid JSON (otherwise it gets "[object Object]").
    const val = v === undefined ? null : v
    await pool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', [k, JSON.stringify(val)])
    return
  }
  return fileSet(k, v)
}
export async function kvDel(k) {
  if (usingPg) { await pool.query('DELETE FROM kv WHERE k=$1', [k]); return }
  try { fs.unlinkSync(path.join(DATA, k)) } catch {}
}

export { usingPg }

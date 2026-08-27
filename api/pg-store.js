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
  if (url) {
    try {
      pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })
      await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb)')
      usingPg = true
      // Log the target (host:port only — never the credentials) so a bad URL is easy to spot.
      let target = url
      try { const u = new URL(url); target = `${u.hostname}:${u.port || 5432}` } catch {}
      console.log(`store=postgres (${target})`)
      return
    } catch (e) {
      console.error(`Postgres connection failed (${e.code || e.message}); falling back to file storage. Check DATABASE_URL.`)
      pool = null
      usingPg = false
    }
  }
  fs.mkdirSync(DATA, { recursive: true })
  console.log(`store=file (${DATA})`)
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
    await pool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', [k, v])
    return
  }
  return fileSet(k, v)
}
export async function kvDel(k) {
  if (usingPg) { await pool.query('DELETE FROM kv WHERE k=$1', [k]); return }
  try { fs.unlinkSync(path.join(DATA, k)) } catch {}
}

export { usingPg }

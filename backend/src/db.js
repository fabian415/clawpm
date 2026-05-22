import pg from 'pg'

const { Pool } = pg

let pool = null

export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL environment variable is required')
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
    pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err.message)
    })
  }
  return pool
}

export async function query(text, params) {
  return getPool().query(text, params)
}

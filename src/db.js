import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Read configuration from environment variables or defaults
const config = {
  host: process.env.DB_HOST || 'dpg-db4i892d0e5s73cep390-a.oregon-postgres.render.com',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'travel_wiki_db_vector',
  user: process.env.DB_USER || 'travel_wiki_db_vector_user',
  password: process.env.DB_PASSWORD || '8Xp7Mg4DXZqTZFy0W5WOadlvDgHJdWS9',
  max: 10, // maximum pool connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// Handle SSL configuration for DigitalOcean Managed Postgres
if (process.env.DB_SSL === 'false') {
  config.ssl = false;
} else {
  config.ssl = {
    rejectUnauthorized: false,
  };
}

export const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err);
});

/**
 * Test connection to the database
 */
export async function testConnection() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT version(), current_database(), current_user;');
    return {
      connected: true,
      version: res.rows[0].version,
      database: res.rows[0].current_database,
      user: res.rows[0].current_user,
    };
  } finally {
    client.release();
  }
}

/**
 * Execute a parameterized query with timing information
 */
export async function query(text, params = []) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    return {
      rows: res.rows,
      rowCount: res.rowCount,
      command: res.command,
      fields: res.fields ? res.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) : [],
      durationMs: duration,
    };
  } catch (err) {
    console.error('[Query Error]', { text, error: err.message });
    throw err;
  }
}

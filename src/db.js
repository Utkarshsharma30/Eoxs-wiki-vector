import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Filter out any legacy travel wiki database configurations from older deployments
const isLegacyTravelDb = 
  (process.env.DB_NAME && process.env.DB_NAME.includes('travel')) ||
  (process.env.DB_USER && process.env.DB_USER.includes('travel')) ||
  (process.env.DB_HOST && (process.env.DB_HOST.includes('dpg-') || process.env.DB_HOST.includes('render')));

// Read configuration from environment variables or defaults (strictly pointing to eoxs_wiki)
const config = {
  host: (!isLegacyTravelDb && process.env.DB_HOST) ? process.env.DB_HOST : 'eoxs-db-live-cluster-do-user-42137371-0.d.db.ondigitalocean.com',
  port: parseInt((!isLegacyTravelDb && process.env.DB_PORT) ? process.env.DB_PORT : '25060', 10),
  database: (!isLegacyTravelDb && process.env.DB_NAME) ? process.env.DB_NAME : 'eoxs_wiki',
  user: (!isLegacyTravelDb && process.env.DB_USER) ? process.env.DB_USER : 'eoxs_app',
  password: (!isLegacyTravelDb && process.env.DB_PASSWORD) ? process.env.DB_PASSWORD : 'Eoxs6333_kronox_db',
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

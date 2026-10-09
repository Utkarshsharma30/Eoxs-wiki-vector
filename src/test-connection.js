import { testConnection, query, pool } from './db.js';

async function run() {
  console.log('--- Testing Database Connection ---');
  try {
    const info = await testConnection();
    console.log('✓ Successfully connected to PostgreSQL database!');
    console.log(`- Database: ${info.database}`);
    console.log(`- User: ${info.user}`);
    console.log(`- Server Version: ${info.version}`);

    console.log('\n--- Fetching Public Tables ---');
    const tablesRes = await query(`
      SELECT table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    
    if (tablesRes.rows.length === 0) {
      console.log('No tables found in public schema (or schema is empty).');
    } else {
      console.log(`Found ${tablesRes.rows.length} table(s):`);
      tablesRes.rows.forEach(t => console.log(`  - [${t.table_type}] ${t.table_name}`));
    }
  } catch (err) {
    console.error('✗ Connection failed:');
    console.error(err.message);
    if (err.message.includes('timeout')) {
      console.log('\n[Tip] Network connection timed out. If running locally, check if your IP is added to DigitalOcean Database "Trusted Sources" or firewall rules.');
    }
  } finally {
    await pool.end();
  }
}

run();

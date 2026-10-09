import { query } from './db.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'execute_read_query',
    description: 'Execute a read-only SQL query (SELECT, EXPLAIN, WITH, etc.) against the eoxs_wiki PostgreSQL database.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute (e.g. SELECT * FROM users LIMIT 10)',
        },
        params: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional positional query parameters for $1, $2 placeholder substitution.',
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'execute_write_query',
    description: 'Execute a data-modifying or DDL SQL query (INSERT, UPDATE, DELETE, CREATE TABLE, etc.) against the database.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute (e.g. INSERT INTO logs (msg) VALUES ($1))',
        },
        params: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional positional query parameters.',
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'list_tables',
    description: 'List all tables and views in the database schema with estimated row counts.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Schema name (default: "public")',
          default: 'public',
        },
      },
    },
  },
  {
    name: 'describe_table',
    description: 'Retrieve column details, data types, keys, and constraints for a specific table.',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: {
          type: 'string',
          description: 'Name of the table to describe (e.g. "wiki_pages")',
        },
        schema: {
          type: 'string',
          description: 'Schema name (default: "public")',
          default: 'public',
        },
      },
      required: ['tableName'],
    },
  },
  {
    name: 'get_database_schema',
    description: 'Retrieve a complete schema summary of all tables and columns in the database.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Schema name (default: "public")',
          default: 'public',
        },
      },
    },
  },
];

export async function handleToolCall(name, args) {
  switch (name) {
    case 'execute_read_query': {
      const { sql, params = [] } = args;
      const normalizedSql = sql.trim().toLowerCase();
      
      // Basic safety check to prevent accidental heavy writes via read_query tool
      if (/^(insert|update|delete|drop|alter|truncate|create)\b/.test(normalizedSql)) {
        throw new Error('Mutation query detected. Please use `execute_write_query` tool for write operations.');
      }

      const res = await query(sql, params);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                rowCount: res.rowCount,
                durationMs: res.durationMs,
                rows: res.rows,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'execute_write_query': {
      const { sql, params = [] } = args;
      const res = await query(sql, params);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                command: res.command,
                affectedRows: res.rowCount,
                durationMs: res.durationMs,
                rows: res.rows.length > 0 ? res.rows : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'list_tables': {
      const schemaName = args.schema || 'public';
      const sql = `
        SELECT 
          t.table_name,
          t.table_type,
          COALESCE(c.reltuples::bigint, 0) AS estimated_rows
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
        WHERE t.table_schema = $1
        ORDER BY t.table_name;
      `;
      const res = await query(sql, [schemaName]);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res.rows, null, 2),
          },
        ],
      };
    }

    case 'describe_table': {
      const { tableName, schema = 'public' } = args;
      const colSql = `
        SELECT 
          column_name, 
          data_type, 
          is_nullable, 
          column_default,
          character_maximum_length
        FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position;
      `;
      
      const pkSql = `
        SELECT a.attname AS primary_key
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary;
      `;

      const cols = await query(colSql, [schema, tableName]);
      let pks = [];
      try {
        const pkRes = await query(pkSql, [`"${schema}"."${tableName}"`]);
        pks = pkRes.rows.map(r => r.primary_key);
      } catch (e) {
        // Table or regclass lookup fallback
      }

      const columnsWithPk = cols.rows.map(col => ({
        ...col,
        is_primary_key: pks.includes(col.column_name),
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tableName,
                schema,
                columns: columnsWithPk,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'get_database_schema': {
      const schemaName = args.schema || 'public';
      const sql = `
        SELECT 
          table_name,
          column_name,
          data_type,
          is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position;
      `;
      const res = await query(sql, [schemaName]);
      
      // Group by table name
      const schemaOverview = {};
      res.rows.forEach(r => {
        if (!schemaOverview[r.table_name]) {
          schemaOverview[r.table_name] = [];
        }
        schemaOverview[r.table_name].push({
          column: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === 'YES',
        });
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(schemaOverview, null, 2),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

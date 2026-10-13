import { query } from './db.js';
import { pipeline } from '@xenova/transformers';

let extractorPipeline = null;
async function getExtractor() {
  if (!extractorPipeline) {
    extractorPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractorPipeline;
}

function buildTsQueryString(term) {
  if (!term || typeof term !== 'string') return '';
  const clean = term.replace(/[^\w\s]/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return '';
  return words.map(w => `${w}:*`).join(' | ');
}

/**
 * Execute semantic vector similarity search via PostgreSQL pgvector.
 * Automatically generates query vector embedding on the server using @xenova/transformers.
 */
export async function runVectorSearch(queryPrompt, { limit = 5, category = null } = {}) {
  const extractor = await getExtractor();
  const output = await extractor(queryPrompt, { pooling: 'mean', normalize: true });
  const vectorStr = `[${Array.from(output.data).join(',')}]`;

  let sql = `
    SELECT 
      c.id AS chunk_id,
      d.id AS doc_id,
      d.title AS doc_title,
      d.category,
      d.file_path,
      c.header,
      c.content,
      (1 - (c.embedding <=> $1::vector)) AS semantic_score
    FROM wiki_chunks c
    JOIN wiki_documents d ON d.id = c.document_id
    WHERE c.embedding IS NOT NULL
  `;
  const params = [vectorStr];

  if (category) {
    sql += ` AND d.category = $2 `;
    params.push(category);
    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $3;`;
    params.push(limit);
  } else {
    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $2;`;
    params.push(limit);
  }

  const res = await query(sql, params);
  return res.rows.map((row, idx) => ({
    ...row,
    semantic_score: parseFloat(row.semantic_score) || 0,
    semantic_rank: idx + 1,
  }));
}

/**
 * Execute keyword full-text search via PostgreSQL tsvector
 */
export async function runKeywordSearch(searchTerm, { limit = 5, category = null } = {}) {
  const tsQueryStr = buildTsQueryString(searchTerm);

  let sql = `
    SELECT 
      c.id AS chunk_id,
      d.id AS doc_id,
      d.title AS doc_title,
      d.category,
      d.file_path,
      c.header,
      c.content,
      (
        COALESCE(ts_rank_cd(c.tsv, to_tsquery('english', $1)), 0) * 1.5 +
        COALESCE(ts_rank_cd(c.tsv, plainto_tsquery('english', $2)), 0) +
        (CASE WHEN d.title ILIKE '%' || $2 || '%' THEN 0.5 ELSE 0 END) +
        (CASE WHEN c.header ILIKE '%' || $2 || '%' THEN 0.3 ELSE 0 END)
      ) AS keyword_score
    FROM wiki_chunks c
    JOIN wiki_documents d ON d.id = c.document_id
    WHERE (
      ($1 != '' AND c.tsv @@ to_tsquery('english', $1))
      OR c.tsv @@ plainto_tsquery('english', $2)
      OR d.title ILIKE '%' || $2 || '%'
      OR c.content ILIKE '%' || $2 || '%'
    )
  `;

  const params = [tsQueryStr, searchTerm];
  let paramIdx = 3;

  if (category) {
    sql += ` AND d.category = $${paramIdx} `;
    params.push(category);
    paramIdx++;
  }

  sql += ` ORDER BY keyword_score DESC LIMIT $${paramIdx};`;
  params.push(limit);

  const res = await query(sql, params);
  return res.rows.map((row, idx) => ({
    ...row,
    keyword_score: parseFloat(row.keyword_score) || 0,
    keyword_rank: idx + 1,
  }));
}

/**
 * Execute parallel hybrid search combining keyword (tsvector) and pgvector semantic search.
 * Automatically generates query vector embedding on the server using @xenova/transformers.
 */
export async function runHybridSearch(queryPrompt, { limit = 5, category = null, alpha = 0.5 } = {}) {
  const fetchLimit = Math.max(limit * 3, 15);

  // Run keyword search and semantic vector search in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    runVectorSearch(queryPrompt, { limit: fetchLimit, category }),
    runKeywordSearch(queryPrompt, { limit: fetchLimit, category }),
  ]);

  const maxKwScore = keywordResults.reduce((max, r) => Math.max(max, r.keyword_score), 0) || 1.0;

  const map = new Map();

  semanticResults.forEach((item) => {
    map.set(item.chunk_id, {
      chunk_id: item.chunk_id,
      doc_id: item.doc_id,
      doc_title: item.doc_title,
      category: item.category,
      file_path: item.file_path,
      header: item.header,
      content: item.content,
      semantic_score: item.semantic_score,
      semantic_rank: item.semantic_rank,
      keyword_score: 0,
      keyword_rank: null,
      found_in_semantic: true,
      found_in_keyword: false,
    });
  });

  keywordResults.forEach((item) => {
    if (map.has(item.chunk_id)) {
      const existing = map.get(item.chunk_id);
      existing.keyword_score = item.keyword_score;
      existing.keyword_rank = item.keyword_rank;
      existing.found_in_keyword = true;
    } else {
      map.set(item.chunk_id, {
        chunk_id: item.chunk_id,
        doc_id: item.doc_id,
        doc_title: item.doc_title,
        category: item.category,
        file_path: item.file_path,
        header: item.header,
        content: item.content,
        semantic_score: 0,
        semantic_rank: null,
        keyword_score: item.keyword_score,
        keyword_rank: item.keyword_rank,
        found_in_semantic: false,
        found_in_keyword: true,
      });
    }
  });

  const RRF_K = 60;
  const merged = Array.from(map.values()).map((item) => {
    const normSemantic = Math.max(0, item.semantic_score);
    const normKeyword = Math.min(1.0, item.keyword_score / maxKwScore);

    const rrfSemantic = item.semantic_rank ? 1 / (RRF_K + item.semantic_rank) : 0;
    const rrfKeyword = item.keyword_rank ? 1 / (RRF_K + item.keyword_rank) : 0;
    const rrfScore = rrfSemantic + rrfKeyword;

    const maxScore = Math.max(normSemantic, normKeyword);
    const hybridScore = alpha * normSemantic + (1 - alpha) * normKeyword;
    const finalScore = Number((hybridScore * 0.7 + rrfScore * 10 * 0.3).toFixed(4));

    let matchType = 'hybrid';
    if (item.found_in_semantic && !item.found_in_keyword) matchType = 'semantic';
    else if (!item.found_in_semantic && item.found_in_keyword) matchType = 'keyword';

    return {
      chunk_id: item.chunk_id,
      doc_id: item.doc_id,
      doc_title: item.doc_title,
      category: item.category,
      file_path: item.file_path,
      header: item.header,
      content: item.content,
      match_type: matchType,
      final_score: finalScore,
      scores: {
        highest_score: Number(maxScore.toFixed(4)),
        semantic_similarity: Number(normSemantic.toFixed(4)),
        keyword_rank_normalized: Number(normKeyword.toFixed(4)),
        rrf_score: Number(rrfScore.toFixed(6)),
      },
    };
  });

  merged.sort((a, b) => b.final_score - a.final_score);
  return merged.slice(0, limit);
}

export const TOOL_DEFINITIONS = [
  {
    name: 'search_hybrid',
    description: 'PRIMARY & RECOMMENDED SEARCH TOOL. Performs parallel hybrid search (combining keyword text search and pgvector semantic vector search). The MCP server automatically generates vector embeddings on the server using @xenova/transformers (all-MiniLM-L6-v2) for your query text, so you do NOT need to write SQL or compute embeddings yourself. Returns top results ranked by merged hybrid score.',
    inputSchema: {
      type: 'object',
      properties: {
        queryPrompt: {
          type: 'string',
          description: 'Natural language search prompt or query (e.g. "best places to visit in Delhi" or "What are top attractions in Japan?")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
          default: 5,
        },
        category: {
          type: 'string',
          description: 'Optional filter by category ("wiki", "raw", or "root")',
        },
        alpha: {
          type: 'number',
          description: 'Weight between semantic vector search (1.0) and keyword search (0.0). Default is 0.5.',
          default: 0.5,
        },
      },
      required: ['queryPrompt'],
    },
  },
  {
    name: 'search_vector',
    description: 'Performs semantic vector similarity search using PostgreSQL pgvector extension. The MCP server automatically converts your natural language query into a 384-dimensional vector embedding on the server using @xenova/transformers, executing cosine similarity search without requiring manual SQL.',
    inputSchema: {
      type: 'object',
      properties: {
        queryPrompt: {
          type: 'string',
          description: 'Natural language search prompt or question (e.g. "What are the best places to visit in Japan?")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
          default: 5,
        },
        category: {
          type: 'string',
          description: 'Optional filter by category ("wiki", "raw", or "root")',
        },
      },
      required: ['queryPrompt'],
    },
  },
  {
    name: 'search_text',
    description: 'Performs full-text keyword search across wiki documents using PostgreSQL tsvector and ts_rank.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Keywords or search terms (e.g. "Delhi monuments")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
          default: 5,
        },
        category: {
          type: 'string',
          description: 'Optional filter by category ("wiki", "raw", or "root")',
        },
      },
      required: ['searchTerm'],
    },
  },
  {
    name: 'get_document',
    description: 'Retrieve full document content and metadata by ID, title, or file path.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Document ID (number), title, or file path (e.g. "wiki/Delhi.md" or "Delhi")',
        },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'execute_read_query',
    description: 'Execute a read-only custom SQL query against the PostgreSQL database. NOTE: For general search and questions, prefer `search_hybrid` or `search_vector` as they handle server-side embedding generation automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute (e.g. SELECT * FROM wiki_documents LIMIT 10)',
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
          description: 'The SQL query to execute',
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
          description: 'Name of the table to describe (e.g. "wiki_documents")',
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
    case 'search_hybrid': {
      const { queryPrompt, limit = 5, category, alpha = 0.5 } = args;
      const results = await runHybridSearch(queryPrompt, { limit, category, alpha });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query: queryPrompt,
                search_mode: 'parallel_hybrid (keyword + pgvector)',
                resultCount: results.length,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'search_vector': {
      const { queryPrompt, limit = 5, category } = args;
      const results = await runVectorSearch(queryPrompt, { limit, category });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query: queryPrompt,
                search_mode: 'semantic_vector (pgvector)',
                resultCount: results.length,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'search_text': {
      const { searchTerm, limit = 5, category } = args;
      const results = await runKeywordSearch(searchTerm, { limit, category });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                searchTerm,
                search_mode: 'keyword_text (tsvector)',
                resultCount: results.length,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'get_document': {
      const { identifier } = args;
      let sql = `
        SELECT id, title, category, file_path, word_count, metadata, content, created_at
        FROM wiki_documents
      `;
      let params = [];

      if (/^\d+$/.test(identifier)) {
        sql += ` WHERE id = $1;`;
        params = [parseInt(identifier, 10)];
      } else {
        sql += ` WHERE file_path ILIKE $1 OR title ILIKE $1 LIMIT 1;`;
        params = [`%${identifier}%`];
      }

      const res = await query(sql, params);
      if (res.rows.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No document found matching identifier "${identifier}".`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res.rows[0], null, 2),
          },
        ],
      };
    }

    case 'execute_read_query': {
      const { sql, params = [] } = args;
      const normalizedSql = sql.trim().toLowerCase();
      
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

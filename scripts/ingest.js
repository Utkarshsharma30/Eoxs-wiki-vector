import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import { pool, query } from '../src/db.js';

const DATA_DIR = 'C:\\Users\\admin\\OneDrive\\Pictures\\llm-wiki';
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// Helper to chunk document by headings or length (~1000 chars)
function chunkDocument(content, maxChunkLen = 1000) {
  if (!content || !content.trim()) return [];

  // Split by markdown headings (# , ## , ### )
  const sections = content.split(/(?=\n#{1,3}\s+)/);
  const chunks = [];

  for (const sec of sections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;

    let header = null;
    const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)$/m);
    if (headerMatch) {
      header = headerMatch[2].trim();
    }

    if (trimmed.length <= maxChunkLen) {
      chunks.push({ header, content: trimmed });
    } else {
      // Split large section by paragraphs
      const paragraphs = trimmed.split(/\n\s*\n/);
      let currentChunk = '';

      for (const para of paragraphs) {
        if ((currentChunk + '\n\n' + para).length > maxChunkLen) {
          if (currentChunk.trim()) {
            chunks.push({ header, content: currentChunk.trim() });
          }
          currentChunk = para;
        } else {
          currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
        }
      }
      if (currentChunk.trim()) {
        chunks.push({ header, content: currentChunk.trim() });
      }
    }
  }

  return chunks;
}

async function setupSchema() {
  console.log('--- Setting up database schema ---');

  // 1. Ensure pgvector extension is enabled
  await query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  // 2. Recreate clean tables
  await query(`DROP TABLE IF EXISTS wiki_chunks CASCADE;`);
  await query(`DROP TABLE IF EXISTS wiki_documents CASCADE;`);

  await query(`
    CREATE TABLE wiki_documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      file_path TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      word_count INT DEFAULT 0,
      metadata JSONB DEFAULT '{}',
      tsv TSVECTOR,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE wiki_chunks (
      id SERIAL PRIMARY KEY,
      document_id INT REFERENCES wiki_documents(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      header TEXT,
      content TEXT NOT NULL,
      embedding vector(384),
      tsv TSVECTOR,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Indexes for high performance queries
  await query(`CREATE INDEX IF NOT EXISTS idx_documents_category ON wiki_documents(category);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_documents_tsv ON wiki_documents USING gin(tsv);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON wiki_chunks USING gin(tsv);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON wiki_chunks(document_id);`);

  console.log('✓ Database schema initialized.');
}

async function main() {
  const startTime = Date.now();
  try {
    await setupSchema();

    console.log(`\n--- Loading Embedding Pipeline (${EMBEDDING_MODEL}) ---`);
    const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL);
    console.log('✓ Feature extraction model loaded.');

    console.log(`\n--- Scanning Directory: ${DATA_DIR} ---`);
    const allFiles = [];

    function findFiles(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === '.obsidian') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          findFiles(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          allFiles.push(fullPath);
        }
      }
    }

    findFiles(DATA_DIR);
    console.log(`Found ${allFiles.length} markdown documents to process.\n`);

    let docCount = 0;
    let chunkCount = 0;

    for (const filePath of allFiles) {
      const relPath = path.relative(DATA_DIR, filePath).replace(/\\/g, '/');
      const filename = path.basename(filePath, '.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      let category = 'root';
      if (relPath.startsWith('wiki/')) category = 'wiki';
      else if (relPath.startsWith('raw/')) category = 'raw';

      // Title extraction
      let title = filename;
      const titleMatch = content.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1].trim();
      }

      const words = content.trim() ? content.trim().split(/\s+/).length : 0;
      const metadata = {
        filename: path.basename(filePath),
        sizeBytes: fs.statSync(filePath).size,
        relPath,
      };

      // Insert document
      const docRes = await query(
        `INSERT INTO wiki_documents (title, category, file_path, content, word_count, metadata, tsv)
         VALUES ($1, $2, $3, $4, $5, $6, to_tsvector('english', $1::text || ' ' || $4::text))
         RETURNING id;`,
        [title, category, relPath, content, words, JSON.stringify(metadata)]
      );

      const docId = docRes.rows[0].id;
      const chunks = chunkDocument(content);

      if (chunks.length > 0) {
        // Batch compute embeddings in chunks of 16
        const batchSize = 16;
        for (let b = 0; b < chunks.length; b += batchSize) {
          const batch = chunks.slice(b, b + batchSize);
          const texts = batch.map(c => c.content);
          
          const output = await extractor(texts, { pooling: 'mean', normalize: true });
          // output shape: [batch.length, 384]
          
          for (let i = 0; i < batch.length; i++) {
            const chunk = batch[i];
            const idx = b + i;
            // extract slice for batch item i
            const vectorArr = Array.from(output[i].data);
            const vectorStr = `[${vectorArr.join(',')}]`;

            await query(
              `INSERT INTO wiki_chunks (document_id, chunk_index, header, content, embedding, tsv)
               VALUES ($1, $2, $3, $4, $5::vector, to_tsvector('english', COALESCE($3::text, '') || ' ' || $4::text));`,
              [docId, idx, chunk.header, chunk.content, vectorStr]
            );
            chunkCount++;
          }
        }
      }

      docCount++;
      console.log(`[${docCount}/${allFiles.length}] Processed "${title}" (${category}) -> ${chunks.length} chunks`);
    }

    console.log(`\n--- Creating HNSW Vector Index ---`);
    try {
      await query(`CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON wiki_chunks USING hnsw (embedding vector_cosine_ops);`);
      console.log('✓ HNSW vector index created successfully.');
    } catch (e) {
      console.log('HNSW index note:', e.message);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n=================================================`);
    console.log(`🎉 Ingestion Complete in ${duration}s!`);
    console.log(`- Documents Ingested: ${docCount}`);
    console.log(`- Total Vector Chunks Created: ${chunkCount}`);
    console.log(`=================================================`);

  } catch (err) {
    console.error('❌ Ingestion Error:', err);
  } finally {
    await pool.end();
  }
}

main();

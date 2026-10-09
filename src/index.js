import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOL_DEFINITIONS, handleToolCall } from './tools.js';
import { testConnection, pool } from './db.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY;

/**
 * Creates and configures a new MCP Server instance
 */
function createMcpServer() {
  const server = new Server(
    {
      name: 'eoxs-wiki-db-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS,
    };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(name, args || {});
    } catch (error) {
      console.error(`[Tool Execution Error] ${name}:`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool ${name}: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Check if launched in stdio mode (for local CLI integration)
if (process.argv.includes('--stdio')) {
  console.error('[MCP Server] Starting in stdio mode...');
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP Server] Stdio server connected and listening.');
} else {
  // HTTP / SSE Server for Render Deployment
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Optional API Key Middleware
  const authMiddleware = (req, res, next) => {
    if (!API_KEY) return next();
    
    const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (clientKey === API_KEY) {
      return next();
    }
    
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing API key.' });
  };

  // Active SSE transports mapped by session ID
  const transports = new Map();

  // Root Landing Endpoint
  app.get('/', (req, res) => {
    res.type('html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>EOXS Wiki Database MCP Server</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 750px; margin: 40px auto; padding: 0 20px; line-height: 1.6; background: #0f172a; color: #f8fafc; }
            h1 { color: #38bdf8; }
            .card { background: #1e293b; border-radius: 8px; padding: 20px; margin: 20px 0; border: 1px solid #334155; }
            .status { display: inline-block; padding: 4px 12px; border-radius: 9999px; background: #22c55e22; color: #4ade80; border: 1px solid #22c55e44; font-weight: bold; }
            code { background: #0f172a; padding: 2px 8px; border-radius: 4px; color: #38bdf8; font-family: monospace; }
            pre { background: #0f172a; padding: 15px; border-radius: 6px; overflow-x: auto; color: #e2e8f0; }
          </style>
        </head>
        <body>
          <h1>EOXS Wiki DB MCP Server</h1>
          <p><span class="status">● Running</span> Server is live and ready for MCP client connections.</p>
          
          <div class="card">
            <h3>Endpoints</h3>
            <ul>
              <li><code>GET /health</code> - Server and Database health check</li>
              <li><code>GET /sse</code> - Server-Sent Events MCP connection endpoint</li>
              <li><code>POST /messages</code> - MCP JSON-RPC message endpoint</li>
            </ul>
          </div>

          <div class="card">
            <h3>MCP Client Configuration (SSE)</h3>
            <pre>{
  "mcpServers": {
    "eoxs-wiki-db": {
      "url": "https://${req.headers.host}/sse"
    }
  }
}</pre>
          </div>
        </body>
      </html>
    `);
  });

  // Health Check Endpoint
  app.get('/health', async (req, res) => {
    let dbStatus = null;
    let dbConnected = false;
    try {
      dbStatus = await testConnection();
      dbConnected = true;
    } catch (err) {
      dbStatus = { error: err.message };
    }

    res.status(200).json({
      status: 'healthy',
      dbConnected,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: dbStatus,
    });
  });

  // SSE Transport Connection Endpoint
  app.get('/sse', authMiddleware, async (req, res) => {
    console.log('[SSE] New client connection request');
    const server = createMcpServer();
    const transport = new SSEServerTransport('/messages', res);
    
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    
    console.log(`[SSE] Created session: ${sessionId}`);

    transport.onclose = () => {
      console.log(`[SSE] Session closed: ${sessionId}`);
      transports.delete(sessionId);
    };

    await server.connect(transport);
  });

  // Message Handler Endpoint
  app.post('/messages', authMiddleware, async (req, res) => {
    const sessionId = req.query.sessionId;
    console.log(`[Message] Received message for session: ${sessionId}`);
    
    const transport = transports.get(sessionId);
    if (!transport) {
      return res.status(400).json({ error: `No active SSE transport found for session ID: ${sessionId}` });
    }

    await transport.handlePostMessage(req, res);
  });

  const serverInstance = app.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(`🚀 EOXS Wiki DB MCP Server running on port ${PORT}`);
    console.log(`👉 SSE URL: http://localhost:${PORT}/sse`);
    console.log(`👉 Health Check: http://localhost:${PORT}/health`);
    console.log(`=================================================`);
  });

  // Graceful Shutdown
  const shutdown = async () => {
    console.log('\n[Shutdown] Closing server and database connections...');
    serverInstance.close();
    await pool.end();
    console.log('[Shutdown] Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

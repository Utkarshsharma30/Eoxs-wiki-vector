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
      name: 'eoxs-wiki-vector-mcp',
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

  // Allow all CORS origins and preflight requests
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Accept'],
  }));
  
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

  // SSE Transport Connection Handler
  const handleSseConnection = async (req, res) => {
    console.log(`[SSE] New client connection request on ${req.path}`);
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
  };

  // Support /sse and /mcp endpoints for SSE connection
  app.get('/sse', authMiddleware, handleSseConnection);
  app.get('/mcp', authMiddleware, handleSseConnection);

  // Discovery Endpoints for MCP Connectors
  app.get('/.well-known/mcp', (req, res) => {
    res.json({
      name: 'eoxs-wiki-vector',
      description: 'EOXS & Travel Wiki Database MCP Server',
      version: '1.0.0',
      transports: {
        sse: {
          url: '/sse',
          messageUrl: '/messages',
        },
      },
    });
  });

  // Root Landing Endpoint (handles SSE if requested, otherwise returns HTML status)
  app.get('/', authMiddleware, (req, res) => {
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
      return handleSseConnection(req, res);
    }

    res.type('html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>EOXS & Travel Wiki DB MCP Server</title>
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
          <h1>EOXS & Travel Wiki DB MCP Server</h1>
          <p><span class="status">● Running</span> Server is live and ready for MCP client connections.</p>
          
          <div class="card">
            <h3>Endpoints</h3>
            <ul>
              <li><code>GET /health</code> - Health check</li>
              <li><code>GET /sse</code> or <code>GET /mcp</code> - Server-Sent Events MCP connection endpoint</li>
              <li><code>POST /messages</code> - MCP JSON-RPC message endpoint</li>
            </ul>
          </div>

          <div class="card">
            <h3>MCP Client Configuration (SSE)</h3>
            <pre>{
  "mcpServers": {
    "travel-wiki-db": {
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

  // Universal Message Handler for both SSE session messages & direct HTTP JSON-RPC
  const handlePostMessage = async (req, res) => {
    const sessionId = req.query.sessionId;
    console.log(`[Message] Received POST on ${req.path}, sessionId: ${sessionId}, body method: ${req.body?.method}`);
    
    // 1. If sessionId exists and matches active transport, delegate to SSE transport handler
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId);
      return await transport.handlePostMessage(req, res);
    }

    // 2. Direct HTTP JSON-RPC fallback handler (for HTTP connectors & initial validation probes)
    const { jsonrpc, id, method, params } = req.body || {};

    if (method === 'initialize') {
      return res.json({
        jsonrpc: jsonrpc || '2.0',
        id: id ?? 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'eoxs-wiki-vector-mcp',
            version: '1.0.0',
          },
        },
      });
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: jsonrpc || '2.0',
        id: id ?? 1,
        result: {
          tools: TOOL_DEFINITIONS,
        },
      });
    }

    if (method === 'tools/call' && params) {
      try {
        const result = await handleToolCall(params.name, params.arguments || {});
        return res.json({
          jsonrpc: jsonrpc || '2.0',
          id: id ?? 1,
          result,
        });
      } catch (err) {
        return res.json({
          jsonrpc: jsonrpc || '2.0',
          id: id ?? 1,
          error: {
            code: -32603,
            message: err.message,
          },
        });
      }
    }

    if (method === 'ping') {
      return res.json({
        jsonrpc: jsonrpc || '2.0',
        id: id ?? 1,
        result: {},
      });
    }

    if (method === 'notifications/initialized') {
      return res.status(200).send();
    }

    // Default HTTP 200 OK for platform validation probes
    return res.status(200).json({
      status: 'ok',
      server: 'eoxs-wiki-vector-mcp',
      message: 'MCP POST endpoint ready',
    });
  };

  app.post('/messages', authMiddleware, handlePostMessage);
  app.post('/sse', authMiddleware, handlePostMessage);
  app.post('/mcp', authMiddleware, handlePostMessage);
  app.post('/', authMiddleware, handlePostMessage);

  const serverInstance = app.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(`🚀 EOXS & Travel Wiki DB MCP Server running on port ${PORT}`);
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

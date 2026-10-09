# EOXS Wiki Database MCP Server (Render Ready)

A production-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server built with Node.js and TypeScript/ESM. Designed to give AI models (Claude, Cursor, Antigravity, LLM agents) safe, structured query access to your DigitalOcean PostgreSQL database (`eoxs_wiki`).

---

## 🚀 Key Features & Capabilities

This MCP server communicates over **SSE (Server-Sent Events)** for cloud hosting on **Render**, as well as **stdio** for local desktop clients.

### Available MCP Tools

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `execute_read_query` | Read | Execute `SELECT`, `EXPLAIN`, or `WITH` queries with positional parameters (`$1`, `$2`). |
| `execute_write_query` | Write | Execute `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE` queries safely. |
| `list_tables` | Metadata | List all tables/views in schema with estimated row counts. |
| `describe_table` | Schema | Detailed column structure, data types, nullability, defaults & primary keys. |
| `get_database_schema` | Overview | Full structural breakdown of all database tables and column specifications. |

---

## 🛠 Database Configuration

Pre-configured defaults match your DigitalOcean cluster:

- **Host**: `eoxs-db-live-cluster-do-user-42137371-0.d.db.ondigitalocean.com`
- **Port**: `25060`
- **Database**: `eoxs_wiki`
- **Username**: `eoxs_app`
- **SSL**: `enabled` (`sslmode=require` / `rejectUnauthorized: false`)

---

## 📦 How to Deploy on Render

### Method 1: Instant Deployment with Render Blueprint (Recommended)

1. Push this workspace code to a **GitHub** or **GitLab** repository.
2. Log in to [Render Dashboard](https://dashboard.render.com/).
3. Click **New +** -> **Blueprint**.
4. Connect your repository containing `render.yaml`.
5. Click **Apply Blueprint**. Render will build and deploy the web service automatically!

---

### Method 2: Manual Web Service Deployment

1. On Render Dashboard, click **New +** -> **Web Service**.
2. Select your repository.
3. Configure the settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. Add the Environment Variables (from `.env.example`):
   - `DB_HOST`: `eoxs-db-live-cluster-do-user-42137371-0.d.db.ondigitalocean.com`
   - `DB_PORT`: `25060`
   - `DB_NAME`: `eoxs_wiki`
   - `DB_USER`: `eoxs_app`
   - `DB_PASSWORD`: `Eoxs6333_kronox_db`
   - `DB_SSL`: `true`
   - `API_KEY` (Optional): Set a secret key if you want bearer token security.
5. Click **Create Web Service**.

---

## 🔒 Important: DigitalOcean Database Firewall Settings

To allow Render services to connect to your DigitalOcean Managed PostgreSQL Database:

1. Go to your **DigitalOcean Control Panel** -> **Databases** -> `eoxs-db-live-cluster`.
2. Open the **Settings** tab -> **Trusted Sources**.
3. Add `0.0.0.0/0` (Allow all IP addresses) OR add Render's outbound IP addresses.

---

## 🔌 Connecting MCP Clients

Once deployed on Render, your web service URL will be something like:  
`https://eoxs-wiki-db-mcp.onrender.com`

### Claude Desktop / Cursor / Antigravity SSE Configuration

Add this entry to your client's MCP configuration (`mcpServers` section):

```json
{
  "mcpServers": {
    "eoxs-wiki-db": {
      "url": "https://eoxs-wiki-db-mcp.onrender.com/sse"
    }
  }
}
```

*If an `API_KEY` is configured in Render environment variables, include request headers:*

```json
{
  "mcpServers": {
    "eoxs-wiki-db": {
      "url": "https://eoxs-wiki-db-mcp.onrender.com/sse",
      "headers": {
        "x-api-key": "YOUR_SECRET_API_KEY"
      }
    }
  }
}
```

---

## 💻 Local Testing & Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Test Connection to DB
```bash
npm run test-db
```

### 3. Run MCP Server Locally (HTTP/SSE Mode)
```bash
npm start
```
Access points:
- Health check: `http://localhost:3000/health`
- SSE Endpoint: `http://localhost:3000/sse`

### 4. Run MCP Server in Stdio Mode
```bash
node src/index.js --stdio
```

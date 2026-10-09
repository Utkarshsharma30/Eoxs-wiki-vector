# Dockerfile for EOXS Wiki DB MCP Server
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY .env.example ./.env.example

# Expose port (Render automatically sets PORT env)
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start MCP Server
CMD ["node", "src/index.js"]

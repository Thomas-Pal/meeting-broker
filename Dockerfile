# Node 20 LTS is a safe target for google-auth + ESM
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Cloud Run will set $PORT; your app already reads it
ENV PORT=8080
EXPOSE 8080

# Start the server (uses "type": "module" fine)
CMD ["node", "index.js"]

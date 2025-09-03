# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps from lockfile if present
COPY package*.json ./
RUN npm ci

# Copy source and build TS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Only prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/index.js"]

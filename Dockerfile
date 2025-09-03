# Dockerfile
# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# ensure dev deps are installed (tsc available)
ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run -s build

# drop dev deps after building
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

CMD ["node","dist/index.js"]

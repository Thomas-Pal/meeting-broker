# -------- Stage 1: build (TypeScript -> JS) --------
FROM node:20-slim AS build
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy sources and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -------- Stage 2: runtime image --------
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring over compiled JS
COPY --from=build /app/dist ./dist

# Cloud Run will inject PORT
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]

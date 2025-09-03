# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8080
CMD ["node","dist/server.js"]

# Dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
# install dev deps so we can compile TS
RUN npm ci

# copy code and build
COPY . .
RUN npm run -s build

# prune dev deps after build for a slim runtime
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# use the start script: node dist/index.js
CMD ["npm","start"]

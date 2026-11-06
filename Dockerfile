# Container for Google Cloud Run (or any container host).
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app.js server.js ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

USER node
# Cloud Run injects PORT (8080). DATABASE_URL, API_KEY and DB_NAME come from the service config.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]

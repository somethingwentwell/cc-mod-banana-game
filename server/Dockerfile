# Banana server: one Node process, SQLite file in /data, no native deps.
FROM node:24-alpine
WORKDIR /app
COPY src ./src
COPY schema.sql ./schema.sql
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/ || exit 1
CMD ["node", "src/server.js"]

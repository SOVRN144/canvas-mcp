FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
# run as non-root
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node","server.js"]

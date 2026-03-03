FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends cups-client sane-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV CUPS_HOST=10.2.1.103
ENV SANE_HOST=10.2.1.103
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]

FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=3412
ENV PROXY_DATA_DIR=/data

EXPOSE 3412

CMD ["npm", "run", "start"]

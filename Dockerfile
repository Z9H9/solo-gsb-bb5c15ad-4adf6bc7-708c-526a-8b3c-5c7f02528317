FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=8080
EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "src/server.js"]

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/database/migrate.js && exec node dist/server.js"]

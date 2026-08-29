# Multi-stage build. Same image for api / worker / migrate — behavior picked at
# runtime via $ROLE (see docker-compose.yml).

FROM node:20-alpine AS development
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "start:dev"]

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY data ./data
# Empty named volume mounted here inherits this ownership on first init, so the
# api (USER node) can bind its unix socket and nginx can read it.
RUN mkdir -p /sock && chown node:node /sock
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

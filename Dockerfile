FROM node:24-alpine AS builder
WORKDIR /app
 
# Install dependencies deterministically
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
 
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
 
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
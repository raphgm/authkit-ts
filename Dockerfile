# syntax=docker/dockerfile:1
# Build stage: compile TypeScript with dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm test && npm prune --omit=dev

# Runtime stage: distroless, non-root, no shell, no package manager.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist/src ./dist/src
EXPOSE 8080
USER nonroot
CMD ["dist/src/index.js"]

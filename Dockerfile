FROM node:25-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web ./apps/web
COPY tests ./tests
RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine AS production
# Refresh security fixes released after the upstream image was published.
USER root
RUN apk upgrade --no-cache
USER 101
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/nginx-security.conf /etc/nginx/satvey-security.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080

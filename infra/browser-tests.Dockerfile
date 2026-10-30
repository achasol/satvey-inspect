FROM mcr.microsoft.com/playwright:v1.60.0-noble
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web ./apps/web
COPY tests ./tests
ENV PLAYWRIGHT_BASE_URL=http://app:5173
CMD ["node", "tests/run.cjs"]

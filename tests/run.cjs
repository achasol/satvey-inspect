// A loopback proxy lets every browser exercise real secure-context device APIs
// while the frontend still runs in its own Compose service.
const http = require('node:http');
const { spawn } = require('node:child_process');
const server = http.createServer((req, res) => {
  const upstream = http.request(
    { hostname: 'app', port: 5173, method: req.method, path: req.url, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('Frontend not ready');
  });
  req.pipe(upstream);
});
server.listen(5173, '127.0.0.1', () => {
  const child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', '--config', 'apps/web/playwright.config.ts', ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BASE_URL: 'http://localhost:5173' } },
  );
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});

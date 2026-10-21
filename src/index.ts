import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const { server } = buildServer({ config });

server.listen(config.port, () => console.log(JSON.stringify({ msg: 'authkit-ts listening', port: config.port })));

// Finish in-flight requests on SIGTERM so rolling deploys don't drop traffic.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

import './db.js';
import { errMsg, log } from './log.js';
import { runScheduler } from './scheduler.js';
import { startServer } from './server.js';

// Never let a stray rejection take the sync down.
process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${errMsg(e)}`));
process.on('uncaughtException', (e) => log.error(`uncaughtException: ${errMsg(e)}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));

await startServer();
await runScheduler();

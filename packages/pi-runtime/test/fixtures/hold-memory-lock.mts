import { withMemoryLock } from '../../src/hermes-extension.ts';
const [lock, ms] = process.argv.slice(2);
await withMemoryLock(lock, async () => { process.send!('held'); await new Promise(r => setTimeout(r, Number(ms))); });

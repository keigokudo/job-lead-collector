import { parseArgs } from 'node:util';
import { collect } from './collector.js';

const usage = `Usage: npm run scrape -- --url <JobServe search URL> [--max 30] [--out output/jobs.json] [--headed]`;

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, max: { type: 'string', default: '30' }, out: { type: 'string', default: 'output/jobs.json' },
    headed: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(usage); return; }
  if (!values.url) throw new Error(`--url is required.\n${usage}`);
  const max = Number(values.max);
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('--max must be a positive integer');
  if (!values.out?.trim()) throw new Error('--out must be a file path');
  const abort = new AbortController();
  const stop = () => { console.error('Interrupted; saving collected jobs…'); abort.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await collect({ url: values.url, max, out: values.out, headed: values.headed, signal: abort.signal });
    process.exitCode = report.status === 'interrupted' ? 130 : report.status === 'stopped' || report.statistics.failed > 0 ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

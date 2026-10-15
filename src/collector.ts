import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import { JobServeAdapter } from './adapters/jobserve.js';
import { AccessRestrictedError, type JobSiteAdapter } from './adapters/types.js';
import type { CollectionReport } from './types.js';

export interface CollectionOptions {
  url: string;
  max: number;
  out: string;
  headed?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export async function saveReport(path: string, report: CollectionReport) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export function adapterFor(url: string): JobSiteAdapter {
  const parsed = new URL(url);
  const adapter = new JobServeAdapter();
  if (!adapter.supports(parsed)) throw new Error(`Unsupported job site: ${parsed.hostname}`);
  return adapter;
}

// Keeping page processing separate makes failure recovery testable with local fixtures.
export async function collectPage(page: Page, adapter: JobSiteAdapter, options: CollectionOptions, navigate = false): Promise<CollectionReport> {
  const log = options.log ?? console.log;
  const report: CollectionReport = {
    source: adapter.source, searchUrl: options.url, collectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'running', statistics: { available: 0, attempted: 0, collected: 0, failed: 0, skipped: 0, unprocessed: 0 },
    warnings: [], jobs: [], errors: [],
  };
  const save = async () => {
    report.updatedAt = new Date().toISOString();
    report.statistics.collected = report.jobs.length;
    report.statistics.unprocessed = report.statistics.available - report.statistics.attempted - report.statistics.skipped;
    await saveReport(options.out, report);
  };
  const interrupt = () => { void page.close().catch(() => {}); };
  options.signal?.addEventListener('abort', interrupt, { once: true });
  try {
    await save();
    if (options.signal?.aborted) { report.status = 'interrupted'; return report; }
    if (navigate) {
      const response = await page.goto(options.url, { waitUntil: 'domcontentloaded' });
      if (response && [401, 403, 429].includes(response.status())) throw new AccessRestrictedError(`Website returned HTTP ${response.status()}; collection stopped.`);
      if (response && response.status() >= 400) throw new Error(`Website returned HTTP ${response.status()}`);
    }
    await adapter.assertAccessible(page);
    const results = await adapter.findJobs(page);
    report.statistics.available = results.jobs.length;
    report.warnings.push(...results.warnings);
    results.warnings.forEach(warning => log(`Warning: ${warning}`));
    log(`Found ${results.jobs.length} loaded results; processing at most ${options.max}.`);
    await save();
    const seen = new Set<string>();
    for (const job of results.jobs) {
      if (options.signal?.aborted) break;
      const key = `${adapter.source}:${job.id}`;
      if (seen.has(key)) { report.statistics.skipped++; await save(); continue; }
      if (report.statistics.attempted >= options.max) break;
      seen.add(key);
      // A modest pause limits interaction rate; detail readiness uses DOM conditions.
      if (report.statistics.attempted > 0) await delay(1000, undefined, { signal: options.signal });
      if (options.signal?.aborted) break;
      report.statistics.attempted++;
      try {
        await adapter.assertAccessible(page);
        await adapter.selectJob(page, job);
        await adapter.waitForDetails(page, job);
        await adapter.assertAccessible(page);
        const listing = await adapter.extractJob(page, job);
        if (listing.source !== adapter.source || listing.sourceJobId !== job.id) throw new Error('Extracted job identity does not match selected result');
        report.jobs.push(listing);
        log(`[${report.statistics.attempted}/${options.max}] Collected ${job.id}: ${listing.title ?? '(untitled)'}`);
      } catch (error) {
        if (options.signal?.aborted) { report.statistics.attempted--; break; }
        // A newly displayed challenge during a timeout must stop subsequent interactions.
        let failure = error;
        try { await adapter.assertAccessible(page); } catch (accessError) { failure = accessError; }
        const message = failure instanceof Error ? failure.message : String(failure);
        report.errors.push({ jobId: job.id, message });
        report.statistics.failed++;
        log(`Failed ${job.id}: ${message}`);
        if (failure instanceof AccessRestrictedError || page.isClosed()) {
          report.status = 'stopped';
          await save();
          break;
        }
      }
      await save();
    }
    if (report.status === 'running') report.status = options.signal?.aborted ? 'interrupted' : 'completed';
  } catch (error) {
    report.status = options.signal?.aborted ? 'interrupted' : 'stopped';
    if (!options.signal?.aborted) report.errors.push({ jobId: null, message: error instanceof Error ? error.message : String(error) });
  } finally {
    options.signal?.removeEventListener('abort', interrupt);
    await save();
  }
  log(`Saved ${report.jobs.length} jobs to ${options.out}; failed ${report.statistics.failed}, skipped ${report.statistics.skipped}, unprocessed ${report.statistics.unprocessed}. Status: ${report.status}.`);
  return report;
}

export async function collect(options: CollectionOptions) {
  const adapter = adapterFor(options.url);
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    return await collectPage(page, adapter, options, true);
  } finally {
    await browser.close();
  }
}

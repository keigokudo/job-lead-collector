import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { JobServeAdapter, extractDetails, readDetails } from '../src/adapters/jobserve.js';
import { collectPage, adapterFor } from '../src/collector.js';

let browser: Browser;
let html: string;
before(async () => {
  browser = await chromium.launch();
  html = await readFile(new URL('./fixtures/jobserve.html', import.meta.url), 'utf8');
});
after(async () => { await browser?.close(); });
async function fixture(fn: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  page.setDefaultTimeout(500);
  try { await page.setContent(html); await fn(page); } finally { await page.close(); }
}

test('selects only JobServe hosts', () => {
  assert.equal(adapterFor('https://www.jobserve.com/gb/en/JobSearch.aspx').source, 'JobServe');
  assert.throws(() => adapterFor('https://jobserve.com.evil.test/'), /Unsupported/);
});

test('extracts graph JSON-LD, preserves full description and display rate', async () => fixture(async page => {
  const adapter = new JobServeAdapter();
  const { jobs } = await adapter.findJobs(page);
  const job = await adapter.extractJob(page, jobs[0]!);
  assert.equal(job.sourceJobId, 'A1');
  assert.equal(job.company, 'Example Employer');
  assert.equal(job.description, 'First & complete paragraph.\nFinal paragraph: END OF ORIGINAL DESCRIPTION.');
  assert.equal(job.rate, '£500/day');
  assert.equal(job.postedAt, '2026-10-01');
  assert.equal(job.location, 'London, GB');
}));

test('uses DOM when JSON-LD is malformed and null for missing fields', async () => fixture(async page => {
  await page.locator('#sp1 script').evaluate(el => { el.textContent = '{broken json'; });
  await page.locator('#md_rate, #md_duration, #md_start_date, #md_recruiter, #md_posted_date, #md_permalink').evaluateAll(els => els.forEach(el => el.remove()));
  const snapshot = await page.evaluate(readDetails);
  const job = extractDetails(snapshot, { id: 'A1', elementId: 'job_A1', title: 'Engineer A' });
  assert.equal(job.company, null);
  assert.equal(job.rate, null);
  assert.equal(job.duration, null);
  assert.equal(job.url, null);
  assert.equal(job.description, 'DOM fallback description.');
}));

test('accepts complete structured description without a DOM description', async () => fixture(async page => {
  await page.locator('#md_skills').evaluate(el => el.remove());
  const adapter = new JobServeAdapter();
  const ref = (await adapter.findJobs(page)).jobs[0]!;
  await adapter.waitForDetails(page, ref);
  assert.match((await adapter.extractJob(page, ref)).description, /END OF ORIGINAL DESCRIPTION/);
}));

test('warns when advertised results exceed loaded rows', async () => fixture(async page => {
  await page.locator('body').evaluate(el => el.append('100 jobs found'));
  const { warnings } = await new JobServeAdapter().findJobs(page);
  assert.ok(warnings.some(warning => /100 jobs but only 3/.test(warning)));
}));

test('rejects mismatched selected ID, stale JSON-LD and marked truncation', async () => fixture(async page => {
  const snapshot = await page.evaluate(readDetails);
  const ref = { id: 'B2', elementId: 'job_B2', title: null };
  assert.throws(() => extractDetails(snapshot, ref), /does not match/);
  assert.throws(() => extractDetails({ ...snapshot, id: 'B2' }, ref), /different or ambiguous/);
  assert.throws(() => extractDetails({ ...snapshot, truncated: true }, { ...ref, id: 'A1' }), /truncated/);
}));

test('waits for matching detail content after ID changes early', async () => fixture(async page => {
  const adapter = new JobServeAdapter();
  const ref = (await adapter.findJobs(page)).jobs[2]!;
  await adapter.selectJob(page, ref);
  await adapter.waitForDetails(page, ref);
  const job = await adapter.extractJob(page, ref);
  assert.equal(job.sourceJobId, 'C3');
  assert.equal(job.description, 'Complete description for C3');
}));

test('matches real JobServe canonical URL when schema uses a different internal ID', async () => fixture(async page => {
  await page.locator('#sp1 script').evaluate(el => {
    const posting = JSON.parse(el.textContent!)['@graph'][0];
    posting.identifier.value = '489062710-1';
    posting.url = 'https://www.jobserve.com/gb/en/search-jobs/ENGINEER-A-A1/';
    el.textContent = JSON.stringify([posting]);
  });
  const adapter = new JobServeAdapter();
  const ref = (await adapter.findJobs(page)).jobs[0]!;
  await adapter.waitForDetails(page, ref);
  const job = await adapter.extractJob(page, ref);
  assert.equal(job.sourceJobId, 'A1');
  assert.match(job.description, /END OF ORIGINAL DESCRIPTION/);
}));

test('saves valid JSON, continues after failed job and deduplicates', async () => fixture(async page => {
  const adapter = new JobServeAdapter();
  const find = adapter.findJobs.bind(adapter);
  adapter.findJobs = async p => { const result = await find(p); result.jobs.splice(1, 0, result.jobs[0]!); return result; };
  const out = join(await mkdtemp(join(tmpdir(), 'jobs-test-')), 'jobs.json');
  const report = await collectPage(page, adapter, { url: 'https://www.jobserve.com/search', max: 3, out, log: () => {} });
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.jobs.map(job => job.sourceJobId), ['A1', 'C3']);
  assert.equal(report.errors[0]?.jobId, 'B2');
  assert.deepEqual(report.statistics, { available: 4, attempted: 3, collected: 2, failed: 1, skipped: 1, unprocessed: 0 });
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), report);
}));

test('persists partial progress on interruption', async () => fixture(async page => {
  const adapter = new JobServeAdapter();
  const abort = new AbortController();
  const out = join(await mkdtemp(join(tmpdir(), 'jobs-interrupt-')), 'jobs.json');
  const report = await collectPage(page, adapter, {
    url: 'https://www.jobserve.com/search', max: 3, out, signal: abort.signal,
    log: message => { if (message.includes('Collected A1')) abort.abort(); },
  });
  assert.equal(report.status, 'interrupted');
  assert.equal(JSON.parse(await readFile(out, 'utf8')).jobs[0].sourceJobId, 'A1');
}));

test('stops on access restrictions and saves the reason', async () => fixture(async page => {
  await page.setContent('<h1>Access denied</h1>');
  const out = join(await mkdtemp(join(tmpdir(), 'jobs-access-')), 'jobs.json');
  const report = await collectPage(page, new JobServeAdapter(), { url: 'https://www.jobserve.com/search', max: 3, out, log: () => {} });
  assert.equal(report.status, 'stopped');
  assert.match(report.errors[0]!.message, /verification/);
  assert.equal(report.statistics.attempted, 0);
}));

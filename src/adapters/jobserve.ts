import type { Page } from 'playwright';
import type { JobListing } from '../types.js';
import { AccessRestrictedError, type JobReference, type JobSiteAdapter } from './types.js';

export function normalizeJobId(value: string): string {
  return value.trim().replace(/^(?:job(?:item)?|jid)[_-]?/i, '').toUpperCase();
}

// Runs in the page, so keep it self-contained and free of Node dependencies.
export function readDetails() {
  // Object methods avoid tsx's injected function-name helpers inside serialized callbacks.
  const helpers = {
    text(selector: string) { return document.querySelector(selector)?.textContent?.trim() || null; },
    htmlText(html: string) {
      const div = document.createElement('div');
      div.innerHTML = html;
      div.querySelectorAll('script,style').forEach(el => el.remove());
      div.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
      div.querySelectorAll('p,div,li,h1,h2,h3,h4,tr,section').forEach(el => el.append('\n'));
      return (div.textContent || '').replace(/\u00a0/g, ' ').trim();
    },
  };
  const postings: Record<string, any>[] = [];
  const pending: any[] = [];
  for (const script of document.querySelectorAll('#sp1 script[type="application/ld+json"]')) {
    try { pending.push(JSON.parse(script.textContent || '')); } catch { /* DOM fallback handles invalid JSON-LD. */ }
  }
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if ([value['@type']].flat().some(type => type === 'JobPosting')) {
      postings.push({ ...value, description: typeof value.description === 'string' ? helpers.htmlText(value.description) : null });
    }
    if (value['@graph']) pending.push(value['@graph']);
  }
  const idElement = document.querySelector<HTMLInputElement>('#jidval');
  const permalink = document.querySelector<HTMLAnchorElement>('#md_permalink');
  const panel = document.querySelector('#JobDetailPanel');
  return {
    id: idElement?.value || idElement?.textContent?.trim() || '',
    postings,
    title: helpers.text('#JobDetailPanel h1') || helpers.text('#JobDetailPanel h2') || helpers.text('#md_title'),
    description: document.querySelector('#md_skills')?.innerHTML ? helpers.htmlText(document.querySelector('#md_skills')!.innerHTML) || null : null,
    duration: helpers.text('#md_duration'), startDate: helpers.text('#md_start_date'), rate: helpers.text('#md_rate'),
    company: helpers.text('#md_recruiter'), postedAt: helpers.text('#md_posted_date'),
    location: helpers.text('#md_location'), employmentType: helpers.text('#md_type'),
    url: permalink?.getAttribute('href') ? permalink.href : null,
    // Hidden collapsed overflow does not truncate textContent; explicitly flagged previews are rejected.
    truncated: !!panel?.querySelector('[data-truncated="true"], .description-truncated'),
  };
}

export type DetailSnapshot = ReturnType<typeof readDetails>;
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
function postingId(posting: Record<string, any>): string | null {
  const identifier = posting.identifier;
  return string(typeof identifier === 'object' && identifier ? identifier.value : identifier);
}
function postingMatches(posting: Record<string, any>, id: string): boolean {
  if (postingId(posting) && normalizeJobId(postingId(posting)!) === id) return true;
  // JobServe's schema identifier is an internal numeric reference, distinct from
  // the hexadecimal result ID. Its canonical URL carries the result ID.
  return typeof posting.url === 'string' && posting.url.toUpperCase().includes(`-${id}/`);
}

export function extractDetails(snapshot: DetailSnapshot, job: JobReference, collectedAt = new Date().toISOString()): JobListing {
  if (normalizeJobId(snapshot.id) !== job.id) throw new Error(`Detail ID ${snapshot.id} does not match ${job.id}`);
  const matching = snapshot.postings.filter(p => postingMatches(p, job.id));
  const unlabelled = snapshot.postings.filter(p => !postingId(p));
  const posting = matching[0] ?? (snapshot.postings.length === 1 && unlabelled.length === 1 ? unlabelled[0] : undefined);
  if (snapshot.postings.length && !posting) throw new Error('JSON-LD belongs to a different or ambiguous job');
  if (posting && !postingId(posting) && job.title && string(posting.title) !== job.title) throw new Error('JSON-LD title does not match selected job');
  if (snapshot.truncated) throw new Error('Job description is marked as truncated');
  const description = string(posting?.description) || snapshot.description;
  if (!description) throw new Error('Full job description is missing');
  const address = (Array.isArray(posting?.jobLocation) ? posting.jobLocation[0] : posting?.jobLocation)?.address;
  const location = typeof address === 'string' ? address : address &&
    [address.addressLocality, address.addressRegion, address.addressCountry?.name ?? address.addressCountry].filter(v => typeof v === 'string').join(', ');
  return {
    source: 'JobServe', sourceJobId: job.id,
    title: string(posting?.title) || snapshot.title || job.title,
    company: string(posting?.hiringOrganization?.name) || snapshot.company,
    location: string(location) || snapshot.location,
    // Preserve display text; numeric schema salary values are not interpreted or normalized.
    rate: snapshot.rate || string(posting?.baseSalary),
    employmentType: string(Array.isArray(posting?.employmentType) ? posting.employmentType.join(', ') : posting?.employmentType) || snapshot.employmentType,
    duration: snapshot.duration, startDate: snapshot.startDate,
    postedAt: string(posting?.datePosted) || snapshot.postedAt,
    url: string(posting?.url) || snapshot.url,
    description, collectedAt,
  };
}

export class JobServeAdapter implements JobSiteAdapter {
  readonly source = 'JobServe';
  supports(url: URL) { return ['http:', 'https:'].includes(url.protocol) && /(^|\.)jobserve\.com$/i.test(url.hostname); }

  async assertAccessible(page: Page) {
    const body = await page.locator('body').innerText();
    const title = await page.title();
    const challenge = await page.locator('iframe[src*="captcha"], iframe[src*="challenge"], .g-recaptcha, .h-captcha, #challenge-running, input[type="password"]').count();
    if (challenge || /\/(?:login|sign-?in)(?:[./?]|$)/i.test(page.url()) || /access denied|verify (?:that )?you are human|unusual traffic|complete the captcha|security check|just a moment|sign in to (?:view|continue)|log in to (?:view|continue)/i.test(`${title}\n${body}`)) {
      throw new AccessRestrictedError('JobServe requires login, CAPTCHA, or access verification; collection stopped.');
    }
  }

  async findJobs(page: Page) {
    await page.locator('#jsJobResContent').waitFor({ state: 'visible' });
    await this.assertAccessible(page);
    const jobs = await page.locator('#jsJobResContent .jobItem').evaluateAll(elements => elements.map(el => ({
      elementId: el.id,
      id: el.getAttribute('data-jobid') || el.getAttribute('data-job-id') || el.id,
      title: el.querySelector('.jobResultsTitle')?.textContent?.trim() || null,
    })));
    if (jobs.some(job => !job.id || !job.elementId)) throw new Error('A result has no stable ID; JobServe markup may have changed');
    const body = await page.locator('body').innerText();
    const advertised = body.match(/([\d,]+)\s+(?:matching\s+)?jobs?\s+(?:found|matched)|(?:results?|jobs?)\s+\d+\s*[-–]\s*\d+\s+of\s+([\d,]+)/i);
    const total = advertised ? Number((advertised[1] || advertised[2])?.replace(/,/g, '')) : null;
    const warnings = ['Only results currently loaded in the DOM are collected. Further pages or unloaded results may exist.'];
    if (total && total > jobs.length) warnings.push(`Results appear incomplete: page advertises ${total} jobs but only ${jobs.length} are loaded.`);
    if (!jobs.length) warnings.push('No loaded job rows were found. The search may be empty or expired, or markup may have changed.');
    return {
      jobs: jobs.map(job => ({ ...job, id: normalizeJobId(job.id) })),
      warnings,
    };
  }

  async selectJob(page: Page, job: JobReference) {
    await page.locator(`[id=${JSON.stringify(job.elementId)}]`).click();
  }

  async waitForDetails(page: Page, job: JobReference) {
    await page.waitForFunction(({ id, title }) => {
      const el = document.querySelector<HTMLInputElement>('#jidval');
      const current = (el?.value || el?.textContent || '').trim().replace(/^(?:job(?:item)?|jid)[_-]?/i, '').toUpperCase();
      if (current !== id) return false;
      let structuredReady = false;
      let hasPosting = false;
      const pending: any[] = [];
      document.querySelectorAll('#sp1 script[type="application/ld+json"]').forEach(s => { try { pending.push(JSON.parse(s.textContent || '')); } catch {} });
      while (pending.length) {
        const p = pending.shift();
        if (!p || typeof p !== 'object') continue;
        if (Array.isArray(p)) { pending.push(...p); continue; }
        if ([p['@type']].flat().includes('JobPosting') && typeof p.description === 'string' && p.description.trim()) {
          hasPosting = true;
          const value = typeof p.identifier === 'object' ? p.identifier?.value : p.identifier;
          const matches = typeof value === 'string' && value.trim().replace(/^(?:job(?:item)?|jid)[_-]?/i, '').toUpperCase() === id;
          const urlMatches = typeof p.url === 'string' && p.url.toUpperCase().includes(`-${id}/`);
          if (matches || urlMatches || (!value && title && p.title === title)) structuredReady = true;
        }
        if (p['@graph']) pending.push(p['@graph']);
      }
      if (hasPosting && !structuredReady) return false;
      if (!structuredReady && !document.querySelector('#md_skills')?.textContent?.trim()) return false;
      const panelTitle = document.querySelector('#JobDetailPanel h1, #JobDetailPanel h2, #md_title')?.textContent?.trim();
      return !title || !panelTitle || panelTitle === title;
    }, { id: job.id, title: job.title });
  }

  async extractJob(page: Page, job: JobReference) {
    const snapshot = await page.evaluate(readDetails);
    const result = extractDetails(snapshot, job);
    const row = await page.locator(`[id=${JSON.stringify(job.elementId)}]`).evaluate(el => ({
      location: el.querySelector('.jobResultsLoc')?.textContent?.trim() || null,
      rate: el.querySelector('.jobResultsSalary')?.textContent?.trim() || null,
      employmentType: el.querySelector('.jobResultsType')?.textContent?.trim() || null,
    }));
    result.location ??= row.location;
    result.rate ??= row.rate;
    result.employmentType ??= row.employmentType;
    return result;
  }
}

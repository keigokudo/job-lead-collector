import type { Page } from 'playwright';
import type { JobListing } from '../types.js';

export interface JobReference { id: string; elementId: string; title: string | null }
export interface SearchResults { jobs: JobReference[]; warnings: string[] }

export interface JobSiteAdapter {
  readonly source: string;
  supports(url: URL): boolean;
  assertAccessible(page: Page): Promise<void>;
  findJobs(page: Page): Promise<SearchResults>;
  selectJob(page: Page, job: JobReference): Promise<void>;
  waitForDetails(page: Page, job: JobReference): Promise<void>;
  extractJob(page: Page, job: JobReference): Promise<JobListing>;
}

export class AccessRestrictedError extends Error {}

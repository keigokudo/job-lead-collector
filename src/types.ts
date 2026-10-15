export interface JobListing {
  source: string;
  sourceJobId: string;
  title: string | null;
  company: string | null;
  location: string | null;
  rate: string | null;
  employmentType: string | null;
  duration: string | null;
  startDate: string | null;
  postedAt: string | null;
  url: string | null;
  description: string;
  collectedAt: string;
}

export interface CollectionReport {
  source: string;
  searchUrl: string;
  collectedAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'interrupted' | 'stopped';
  statistics: {
    available: number;
    attempted: number;
    collected: number;
    failed: number;
    skipped: number;
    unprocessed: number;
  };
  warnings: string[];
  jobs: JobListing[];
  errors: { jobId: string | null; message: string }[];
}

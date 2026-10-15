# Job listing collector

A small Node.js/TypeScript CLI that collects the loaded JobServe search results into one JSON document for personal job-search analysis. No accounts, databases, matching service, or API keys are needed.

## Setup

Use Node.js 22 or newer:

```sh
npm ci
npm run browser:install
```

On Linux, if Chromium reports missing system libraries, install Playwright's documented browser dependencies (`npx playwright install-deps chromium`, which may require administrator privileges).

## Usage

Start with five jobs:

```sh
npm run scrape -- --url "https://www.jobserve.com/gb/en/JobSearch.aspx?shid=26C5A2805B66588CC7D1" --max 5
```

Choose an output path or show the browser:

```sh
npm run scrape -- --url "https://www.jobserve.com/gb/en/JobSearch.aspx?shid=26C5A2805B66588CC7D1" --max 5 --out output/jobserve.json --headed
npm run scrape -- --help
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `--url` | Required | JobServe search results URL |
| `--max` | `30` | Maximum unique jobs attempted, including failures |
| `--out` | `output/jobs.json` | JSON file path |
| `--headed` | Off | Show Chromium; requires a graphical desktop |

The URL chooses the adapter automatically. Unsupported sites are rejected. Each run replaces the chosen output file; use distinct filenames to keep earlier collections. Upload the resulting JSON to ChatGPT manually alongside your CV and criteria.

Press Ctrl+C once to save partial progress and close the browser. SIGTERM also saves progress. Exit codes: `0` for a completed collection without failures, `1` for setup errors, stopped collections or individual failures, and `130` for interruption.

## Source layout

```text
src/
  cli.ts                 Argument parsing and process signals
  collector.ts           Browser lifecycle, sequential processing, deduplication and saving
  types.ts               Shared job and report schemas
  adapters/
    types.ts             JobSiteAdapter interface and access restriction error
    jobserve.ts          JobServe selection, readiness and extraction
tests/
  fixtures/jobserve.html Synthetic HTML with delayed detail updates
  jobserve.test.ts        Browser-backed extraction and recovery tests
```

To support another board, implement `JobSiteAdapter` and register it in `adapterFor`. All selectors and site-specific navigation belong in the adapter. There are no placeholder adapters or pagination framework.

## Collection and data

The collector snapshots loaded result IDs, processes them sequentially, and allows at least one second between jobs. It waits for the selected `#jidval`, detail title where available, and matching structured data rather than using fixed sleeps for readiness. JobServe's JSON-LD `identifier.value` can be a different internal numeric reference: the canonical URL's result ID also establishes identity. The exported `sourceJobId` is the result ID matching `#jidval`.

JSON-LD supports individual JobPosting objects, arrays and `@graph` wrappers. Structured values take precedence, with DOM fallbacks. Rate uses original displayed text rather than interpreting numeric structured salary objects. Missing optional fields are `null`. Descriptions contain full extracted text, with HTML entities decoded and paragraph/line breaks preserved; there is no length cap or summary. Empty descriptions, identity mismatches and explicitly marked truncated previews fail extraction.

The output contains `source`, `searchUrl`, `collectedAt`, `updatedAt`, `status`, `statistics`, `warnings`, `jobs` and `errors`. Each job follows `src/types.ts`. Errors include the affected result ID, or `null` for a collection-level error. Timestamps are ISO 8601; `postedAt` preserves the structured posting date or displayed text.

Statistics:

- `available`: loaded result rows, including duplicates.
- `attempted`: unique jobs processed, up to `--max`.
- `collected` / `failed`: successful or failed attempts.
- `skipped`: duplicate rows encountered before the limit is reached.
- `unprocessed`: loaded rows not reached, including rows beyond the limit.

State is saved initially and after each result using a temporary file beside the destination and an atomic rename. A failed job does not discard earlier successes. Access restrictions, login requirements and CAPTCHA stop the collection; no stealth, proxy rotation, login automation or bypass is implemented. Navigation failures also produce a report. Browser launch or filesystem failures can prevent saving and exit with an error.

## Verification

```sh
npm run typecheck
npm test
```

Tests run against local synthetic HTML using Chromium and make no network requests. They cover structured parsing, complete description text, missing fields, malformed JSON fallback, stale details, JobServe's distinct internal identifier, deduplication, valid saved JSON, failure recovery, interruption and access restrictions.

Live validation on 15 October 2026 using the supplied search URL and `--max 5` collected five jobs with zero failures from 25 loaded rows. The run is saved locally at `output/live-check.json` (ignored by Git). Earlier validation exposed and corrected a `tsx` browser-callback serialization issue and JobServe's internal-ID/canonical-URL distinction. A successful small run does not guarantee future search links or markup remain compatible.

## Limitations and responsible use

- Only JobServe and results already loaded in the DOM are supported. No pagination, infinite scrolling or saved-search refresh is implemented. Warnings flag this scope and recognizable counts larger than the loaded rows.
- Deduplication is per run by source and result ID. There is no resume or merge of previous files.
- Markup and search links can change or expire. A matching ID and available text cannot establish whether the publisher itself shortened a description. The collector rejects detectable truncation but cannot recover content the server never supplies.
- HTML is converted to readable text, not preserved as original HTML. Rate strings and posting date fallbacks remain unnormalized. Company may represent the recruiting agency.
- SIGKILL or power loss cannot trigger a final save; the most recent completed save remains. Atomic rename is not a guarantee against disk or hardware failure. Do not run multiple collectors against the same output path.
- Review [JobServe's current terms](https://www.jobserve.com/gb/en/PolicyView.aspx?t=wt) and access rules before use. Keep downloaded material for personal use, avoid redistribution and aggressive repeated runs, and stop if access is restricted.

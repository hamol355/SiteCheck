# SiteCheck

SiteCheck is a command-line tool that checks a website for availability, security, SEO and HTML quality and reports a score from 0 to 100, with advice on how to fix each problem.

## Installation

Requires Node.js 22 or later.

```bash
npm install
npm run build
node dist/cli/index.js https://example.com
```

During development, run from source with `npm run dev -- https://example.com`.

## Usage

```text
sitecheck <url> [--format text|json] [--min-score <0-100>] [--help] [--version]
```

- If the URL has no scheme, `https://` is assumed.
- `--format text` (default) prints a human-readable report; `--format json` prints the JSON report described below.
- `--min-score <n>` makes the command exit with code 1 when the score is below `n` (useful in CI). The report is still printed.
- Colors are used only when stdout is a TTY and `NO_COLOR` is not set.
- Set `DEBUG=sitecheck` to print stack traces for internal errors.

The report goes to **stdout**; errors and diagnostics go to **stderr**, so `--format json` can always be piped, e.g. `sitecheck example.com --format json | jq .score`.

### Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | OK                                                          |
| 1    | Score is below `--min-score`                                |
| 2    | Invalid input (bad URL, unknown option, bad option value)   |
| 3    | The site could not be reached (including timeouts and redirect loops) or an internal error occurred |

## Checks

| Category     | Checks                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Availability | `http-status`, `response-time`, `https-redirect`                                                                 |
| Security     | `https`, `strict-transport-security`, `content-security-policy`, `x-content-type-options`, `referrer-policy`, `permissions-policy` |
| SEO          | `title`, `meta-description`, `h1`, `canonical-url`, `robots-txt`, `sitemap-xml`                                  |
| HTML         | `html-lang`, `viewport-meta`, `image-alt`, `heading-structure`                                                   |

Each check ends as `pass`, `warn`, `fail`, `error` (the check itself crashed; other checks are unaffected) or `skip` (the check did not apply). If the page does not respond with 2xx, the checks that read the page content (`title`, `meta-description`, `h1`, `canonical-url` and all HTML checks) are skipped, since an error or block page says nothing about the real page. `warn` and `fail` come with a `remediation` hint.

## Score model

Each check has a maximum number of points. `pass` earns all of them, `warn` half (rounded down), and `fail` none. `error` and `skip` checks are left out of the score entirely; for `error` the CLI also prints a warning on stderr. A category where every check was skipped scores 0 (shown as "not checked"), and the other categories are not scaled up to compensate, so a site whose page could not be checked cannot get a high score.

- **Category score** = earned points / possible points of the scored checks × category weight, rounded to an integer. Weights: Availability 20, Security 40, SEO 20, HTML 20 (preliminary).
- **Total score** = the sum of the _unrounded_ category scores, rounded once. The rounded category scores therefore do not always add up to the total.
- **Grade:** 90–100 Excellent, 75–89 Good, 50–74 Needs improvement, 0–49 Poor.

The weights, grade boundaries and check thresholds are constants in `src/scoring/score.ts` and `src/checks/`.

### Response time

Response time is the time from sending the final request until the response headers are received. It excludes earlier redirects, reading the body and parsing. It can include DNS and TLS setup; when a redirect stays on the same host, the connection is reused and these are not included.

## JSON output

The JSON output is a public interface (`schemaVersion` is `1`):

```json
{
  "schemaVersion": 1,
  "url": "https://example.com/",
  "finalUrl": "https://example.com/",
  "score": 73,
  "grade": "Needs improvement",
  "categories": {
    "availability": { "score": 20, "max": 20 },
    "security": { "score": 20, "max": 40 },
    "seo": { "score": 14, "max": 20 },
    "html": { "score": 20, "max": 20 }
  },
  "checks": [
    {
      "id": "robots-txt",
      "category": "seo",
      "status": "fail",
      "message": "robots.txt returned HTTP 404",
      "remediation": "Add a robots.txt at the site root, ...",
      "points": 0,
      "maxPoints": 3
    }
  ],
  "meta": {
    "sitecheckVersion": "0.1.0",
    "analyzedAt": "2026-01-01T12:00:00.000Z",
    "responseTimeMs": 123,
    "truncated": false
  }
}
```

`status` is one of `pass`, `warn`, `fail`, `error`, `skip`. `remediation` is present only when there is something to fix.

## Limitations

- The page is fetched once and analysed as served. JavaScript is not executed, so content rendered client-side (SPAs) is not seen by the HTML and SEO checks.
- Some sites block unknown clients. SiteCheck sends `User-Agent: SiteCheck/<version>`; a 403 is reported as a failed `http-status`, and the page content checks are skipped. A site that answers 200 with a reduced page for bots is analysed as served, so the score reflects what SiteCheck received rather than what a browser would see.
- Requests time out after 10 s (5 s for `robots.txt`, `sitemap.xml` and the HTTP→HTTPS probe), follow at most 5 redirects, and read at most 2 MB of the page (1 MB for `robots.txt` and the sitemap). Larger pages are analysed truncated; the report then has `meta.truncated: true` and the text output says so.
- The sitemap check verifies that a sitemap exists and looks like XML; it does not validate its contents.
- Performance, Core Web Vitals and in-depth accessibility checks are out of scope for v1.

## Development

```bash
npm test        # Vitest (unit, module and CLI integration tests; localhost only)
npm run lint    # ESLint
npm run format  # Prettier
npm run build   # tsc → dist/
```

The CLI integration tests build the project and run `dist/cli/index.js` against a local test server.

## License

MIT

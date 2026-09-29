# Error reports

The endpoint the app sends its error reports to: a Cloudflare Worker that
files each new problem as a GitHub issue (label `error report`) and counts
repeats on it in a comment, at most once a day.

- `src/report.ts`: the report format, the checks and the scrubbing. A field
  outside the format is refused, not dropped. Coordinates, URLs and emails are
  taken out of the message and the stack before anything is filed.
- `src/worker.ts`: `POST /report`, from the site and the Android app only
  (`ALLOWED_ORIGINS`), rate-limited per sender, with a daily cap across everyone.
- `src/github.ts`: the issues.
- The app side is `web/src/report.ts`. It is off in a build without
  `REPORT_URL`, and under test automation (`navigator.webdriver`).

`npm ci && npm run check && npm test` checks it. `.github/workflows/reports.yml`
deploys it from main.

## Setting it up (once)

1. **Cloudflare**: make a free account. Under *My Profile → API Tokens*,
   create a token from the *Edit Cloudflare Workers* template. Note the account
   ID on the Workers overview page.
2. **GitHub token for the issues**: a fine-grained personal access token for
   this repository only, with *Issues: Read and write* and nothing else.
   And the label the issues go under:
   `gh label create "error report" --color B60205 --description "Filed by the app's error reporting"`.
3. **Repository secrets** (*Settings → Secrets and variables → Actions*):
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `REPORTS_GITHUB_TOKEN`.
4. Run the workflow: `gh workflow run reports.yml --ref main`. The first
   deploy creates the KV namespace and prints the Worker's address,
   `https://safe-bikes-reports.<your-subdomain>.workers.dev`.
5. **Repository variable** `REPORT_URL` = that address plus `/report`. The next
   site deploy and APK build then send reports. Until it is set they send none.

Watch it live with `npx wrangler tail` (from `reports/`, after
`npx wrangler login`).

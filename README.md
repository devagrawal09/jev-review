# Jev Review

A small code-review workflow built with [TypeSafe Jev](https://typesafe.ai). It can review a Git diff or scan a complete codebase, follows the strongest structured signals through focused model calls, and presents the result in a quiet local dashboard.

![Jev Review dashboard](docs/dashboard.png)

## How It Works

The reviewer keeps orchestration in code and uses Jev for bounded judgments:

```text
Noul risk matrix
  -> Choice + Score file profiles
  -> Choice evidence selection
  -> Choice mechanism classification
  -> Score severity
  -> conditional Choice reviewer routing
```

- Exposes separate change-review and complete-codebase entry points.
- Uses changed or related tests as context when judging test gaps.
- Screens correctness, security, reliability, compatibility, and test coverage.
- Selects concrete diff hunks or source regions before scoring impact.
- Uses structured hints, counterexamples, and explicit decision boundaries.
- Applies thresholds and workflow policy in code.
- Shows large reports in collapsible dashboard sections.
- Binds the dashboard to `127.0.0.1` and never serves environment files.

## Quick Start

Requires Node.js 24+, Git, and either a [TypeSafe API key](https://console.typesafe.ai/settings/keys)
or a [Vercel AI Gateway key](https://vercel.com/dashboard).

```bash
npm install
cp .env.example .env
# Add TYPESAFE_API_KEY, or AI_GATEWAY_API_KEY with JUDGE_BACKEND=ai-gateway

# Review the current Git diff
npm run review:changes:save -- /path/to/git/repository

# Or scan every non-ignored source file under a scope
npm run review:codebase:save -- /path/to/git/repository-or-package
npm run dashboard
```

Judgments run through the TypeSafe SDK when `TYPESAFE_API_KEY` is set. Set
`JUDGE_BACKEND=ai-gateway` to run the same questions through the Vercel AI SDK and AI
Gateway instead. Both reach the same Jev evaluation engine, and every saved report
records which backend answered it.

AI Gateway requests automatically pause together on HTTP 429 or 503, honor `Retry-After`
(seconds or HTTP date) and `retry-after-ms`, and otherwise use exponential backoff
of two seconds, then four seconds, then eight seconds for every subsequent retry.
Rate limits and temporary model outages retry until the service recovers or you
press Ctrl+C; completed judgments stay in memory while waiting. A persistent outage
can keep the review waiting indefinitely. Authentication, billing, and invalid-request
errors still fail normally. Retries are logged to stderr. A failed review
leaves the previous saved report unchanged. Cooldowns apply within one process.
Vercel publishes no fixed numeric free-tier limit: limits vary by model; paid-tier
requests have no Gateway limit but remain subject to provider limits. See
[Vercel's rate-limit documentation](https://vercel.com/docs/ai-gateway/rate-limits).

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

## Commands

| Command                                  | Purpose                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `npm run review:changes -- <path>`       | Print a current-diff review as JSON                                             |
| `npm run review:changes:save -- <path>`  | Save a current-diff review for the dashboard                                    |
| `npm run review:codebase -- <path>`      | Print a complete codebase scan as JSON                                          |
| `npm run review:codebase:save -- <path>` | Save a complete codebase scan for the dashboard                                 |
| `npm run dashboard`                      | Start the local dashboard                                                       |
| `npm run check`                          | Typecheck, verify dependency flow, and syntax-check the dashboard client        |
| `npm test`                               | Check the judgment backends: question shapes, backend selection, answer mapping |

## Architecture

Everything lives under `src/`, arranged in layers that only depend downward:

```text
src/
  domain/      config.ts, types.ts, patch.ts   shared policy, report shapes, diff parsing
  adapters/    git.ts, repository-files.ts     change and complete-source discovery
               report-store.ts                 atomic report save/load
               judgment.ts                     TypeSafe SDK and AI SDK judgment backends
  review/      changes.ts, codebase.ts          mode-specific workflows
               *-judgments.ts, workflow.ts     Jev calls and shared staged orchestration
  cli/         review-*.ts, save-*.ts           explicit mode entry points
  dashboard/   server.ts, public/              local-only HTTP server and the plain client
```

Imports point toward lower layers only:

```text
{ cli, dashboard } -> review -> adapters -> domain
```

`scripts/check-dependencies.ts` fails `npm run check` on any upward import, any
import between `cli` and `dashboard`, or any cycle.

## Current Scope

This is an experiment in composing fast typed judgments into a review workflow. It does not yet integrate compiler diagnostics, static analyzers, repository indexing, or generated explanations. Findings are review prompts, not proof of a defect.

## License

[MIT](LICENSE)

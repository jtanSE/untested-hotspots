# Untested Hotspots

A GitHub Action that finds high-risk untested functions in your codebase using [Supermodel](https://supermodeltools.com) — no instrumentation, no test mapping config, no runtime coverage tools needed.

## Installation

### 1. Get an API key

Sign up at [dashboard.supermodeltools.com](https://dashboard.supermodeltools.com) and create an API key.

### 2. Add the secret to your repository

Go to your repo → Settings → Secrets and variables → Actions → New repository secret

- Name: `SUPERMODEL_API_KEY`
- Value: Your API key from step 1

### 3. Create a workflow file

Create `.github/workflows/untested-hotspots.yml` in your repository:

```yaml
name: Untested Hotspots

on:
  pull_request:

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: supermodeltools/untested-hotspots@v1
        with:
          supermodel-api-key: ${{ secrets.SUPERMODEL_API_KEY }}
```

That's it! The action will now analyze your code on every PR and comment with the highest-risk untested functions.

## Configuration

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `supermodel-api-key` | Your Supermodel API key | Yes | - |
| `comment-on-pr` | Post findings as PR comment | No | `true` |
| `fail-on-untested` | Fail the action if untested hotspots found | No | `false` |
| `top-n` | Number of top hotspots to show | No | `20` |
| `min-risk-score` | Minimum risk score (0-100) to include | No | `0` |
| `ignore-patterns` | JSON array of glob patterns to ignore | No | `[]` |

### Example with options

```yaml
- uses: supermodeltools/untested-hotspots@v1
  with:
    supermodel-api-key: ${{ secrets.SUPERMODEL_API_KEY }}
    fail-on-untested: true
    top-n: '10'
    min-risk-score: '40'
    ignore-patterns: '["**/generated/**", "**/migrations/**"]'
```

## What it does

1. Creates a zip of your repository
2. Sends it to Supermodel for static test coverage analysis
3. Identifies functions with zero test coverage
4. Scores each by risk (production reachability, caller count, exports)
5. Posts a ranked report as a PR comment

## Risk scoring

Each untested function gets a risk score (0-100):

| Signal | Points | Why |
|--------|--------|-----|
| Production-reachable | 40 | Reachable from entry points = highest blast radius |
| 10+ callers | 25 | Many dependents = breakage affects more code |
| 4-9 callers | 18 | |
| 1-3 callers | 10 | |
| Exported / public API | 20 | Part of module interface = more external consumers |

## Example output

> ## Untested Hotspots
>
> Found **47** untested functions. Showing top **3** by risk score.
>
> **Coverage summary:** 312 / 359 functions tested (86.9%)
>
> | Risk | Function | File | Callers | Factors |
> |------|----------|------|---------|---------|
> | 🔴 85 | `processPayment` | src/billing/charge.ts#L42 | 12 | production-reachable, 12 callers, exported |
> | 🔴 75 | `validateOrder` | src/orders/validate.ts#L18 | 8 | production-reachable, 8 callers |
> | 🟡 55 | `formatInvoice` | src/billing/format.ts#L91 | 3 | production-reachable, exported |
>
> ---
> _Powered by [Supermodel](https://supermodeltools.com) test coverage analysis_

## Local testing

You can test against any local git repository without GitHub Actions:

```bash
# Set your API key
export SUPERMODEL_API_KEY=smsk_your_key_here

# Run against current directory
npm run test-local

# Run against a specific repo
npm run test-local -- /path/to/your/repo
```

## Outputs

| Output | Description |
|--------|-------------|
| `untested-count` | Total number of untested functions |
| `untested-hotspots-json` | Full JSON array of all findings with risk scores |
| `top-hotspots-json` | JSON array of top-N hotspots only |

### Using outputs in subsequent steps

```yaml
- uses: supermodeltools/untested-hotspots@v1
  id: hotspots
  with:
    supermodel-api-key: ${{ secrets.SUPERMODEL_API_KEY }}

- run: echo "Found ${{ steps.hotspots.outputs.untested-count }} untested functions"
```

## Supported languages

- TypeScript / JavaScript
- Python
- Java
- Go
- Rust
- And more...

## License

MIT

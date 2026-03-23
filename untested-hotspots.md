# Untested Hotspots - Implementation Plan

## Overview

**Untested Hotspots** is a GitHub Action that surfaces functions with zero test coverage — without requiring instrumentation, test mapping config, or runtime coverage tools. It leverages the **Supermodel** graph API to statically analyze which functions are reachable from production entry points but have no associated test coverage.

**Target users:** Engineering leads and QA leads who need to understand testing gaps at PR review time.

**Required Supermodel API endpoint:** `POST /v1/analysis/test-coverage-map`

---

## Architecture

Follows the same proven pattern as Dead Code Hunter and Circular Dependency Hunter:

```
src/
├── index.ts                    # GitHub Action entry point (zip, call API, post comment)
├── untested-hotspots.ts        # Core analysis: risk scoring, ranking, filtering
└── __tests__/
    ├── untested-hotspots.test.ts   # Unit tests
    └── integration.test.ts         # Integration tests against Supermodel API
action.yml                      # GitHub Action manifest
package.json
tsconfig.json
vitest.config.ts
README.md
```

---

## Flow

```
1. Validate Inputs
   - supermodel-api-key (required, must start with "smsk_")
   - top-n (number, default: 20)
   - comment-on-pr (boolean, default: true)
   - fail-on-untested (boolean, default: false)
   - min-risk-score (number, default: 0 — show all)
   - ignore-patterns (JSON array of globs)

2. Create Repository Zip
   - git archive -o .untested-hotspots-repo.zip HEAD

3. Generate Idempotency Key
   - Format: "${repoName}:supermodel:${commitHash}"

4. Call Supermodel API
   - POST /v1/analysis/test-coverage-map
   - Request: { idempotencyKey, file: <zip blob> }
   - Response: { coverageByFile, untestedFunctions, stats }

5. Analyze & Rank
   - Parse untestedFunctions from API response
   - Compute risk score per function (see Risk Scoring below)
   - Filter out ignored patterns
   - Sort by risk score descending
   - Take top-N results

6. Set Action Outputs
   - untested-count: total number of untested functions
   - untested-hotspots-json: full JSON array of results
   - top-hotspots-json: top-N results only

7. Post PR Comment (if enabled & in PR context)
   - Formatted markdown table ranked by risk

8. Cleanup
   - Delete zip file
   - Fail action if fail-on-untested=true and untested count > 0
```

---

## Supermodel API Contract

### Request

```
POST /v1/analysis/test-coverage-map
Content-Type: multipart/form-data

Fields:
  - idempotencyKey: string       # "${repoName}:supermodel:${commitHash}"
  - file: Blob (application/zip) # Repository archive
```

### Expected Response

```typescript
interface TestCoverageMapResponse {
  coverageByFile: CoverageByFile[];
  untestedFunctions: UntestedFunction[];
  stats: {
    totalFiles: number;
    totalFunctions: number;
    testedFunctions: number;
    untestedFunctions: number;
    coveragePercent: number;
  };
}

interface CoverageByFile {
  filePath: string;
  totalFunctions: number;
  testedFunctions: number;
  untestedFunctions: number;
  coveragePercent: number;
}

interface UntestedFunction {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  exported?: boolean;
  callerCount?: number;       // How many other functions call this
  productionReachable?: boolean; // Reachable from production entry points
}
```

> **Note:** The exact response shape will be confirmed against the SDK once the endpoint is available. The implementation must be flexible enough to adapt to the actual schema.

---

## Risk Scoring

Each untested function is assigned a **risk score** (0–100) based on static graph signals:

| Signal                        | Weight | Rationale                                            |
|-------------------------------|--------|------------------------------------------------------|
| Production-reachable          | 40     | Reachable from entry points = highest blast radius   |
| High caller count (inbound)   | 25     | Many dependents = breakage affects more code paths   |
| Exported / public API         | 20     | Part of module interface = more external consumers   |
| File change frequency (bonus) | 15     | Frequently changed files are more likely to regress  |

```typescript
function computeRiskScore(fn: UntestedFunction, fileChangeFrequency?: number): number {
  let score = 0;

  if (fn.productionReachable) score += 40;

  // callerCount: 0 = 0pts, 1-3 = 10pts, 4-9 = 18pts, 10+ = 25pts
  if (fn.callerCount >= 10) score += 25;
  else if (fn.callerCount >= 4) score += 18;
  else if (fn.callerCount >= 1) score += 10;

  if (fn.exported) score += 20;

  // fileChangeFrequency: normalized 0-1 from git log, scaled to 15pts
  if (fileChangeFrequency) score += Math.round(fileChangeFrequency * 15);

  return Math.min(score, 100);
}
```

> File change frequency is optional — derived from `git log --format='' --name-only` if available, otherwise omitted.

---

## Core Module: `untested-hotspots.ts`

### Exported Functions

```typescript
// Filter and rank untested functions by risk
findUntestedHotspots(
  coverageByFile: CoverageByFile[],
  untestedFunctions: UntestedFunction[],
  ignorePatterns: string[],
  topN: number,
  minRiskScore: number,
): UntestedHotspot[];

// Compute risk score for a single function
computeRiskScore(
  fn: UntestedFunction,
  fileChangeFrequency?: number,
): number;

// Format the PR comment markdown
formatPrComment(
  hotspots: UntestedHotspot[],
  totalUntested: number,
  stats: CoverageStats,
): string;

// Check if a file should be ignored
shouldIgnoreFile(filePath: string, ignorePatterns: string[]): boolean;
```

### Types

```typescript
interface UntestedHotspot {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  riskScore: number;
  riskFactors: string[];    // Human-readable reasons, e.g. ["production-reachable", "8 callers"]
  callerCount: number;
  exported: boolean;
  productionReachable: boolean;
}
```

---

## Default Exclude Patterns

Same as sibling tools, matching established convention:

```typescript
const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/vendor/**',
  '**/target/**',
  '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
  '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
  '**/__tests__/**',
  '**/__mocks__/**',
];
```

---

## GitHub Action Definition (`action.yml`)

```yaml
name: 'Untested Hotspots'
description: 'Find high-risk untested functions in your codebase using Supermodel test coverage mapping'
author: 'Supermodel Tools'

branding:
  icon: 'alert-triangle'
  color: 'yellow'

inputs:
  supermodel-api-key:
    description: 'Supermodel API key from https://supermodeltools.com'
    required: true
  github-token:
    description: 'GitHub token for posting PR comments'
    required: false
    default: ${{ github.token }}
  comment-on-pr:
    description: 'Post findings as a PR comment'
    required: false
    default: 'true'
  fail-on-untested:
    description: 'Fail the action if untested hotspots are found above the minimum risk score'
    required: false
    default: 'false'
  top-n:
    description: 'Number of top hotspots to display in PR comment'
    required: false
    default: '20'
  min-risk-score:
    description: 'Minimum risk score (0-100) to include in results'
    required: false
    default: '0'
  ignore-patterns:
    description: 'JSON array of glob patterns to ignore (e.g. ["**/generated/**"])'
    required: false
    default: '[]'

outputs:
  untested-count:
    description: 'Total number of untested functions found'
  untested-hotspots-json:
    description: 'JSON array of all untested hotspot findings with risk scores'
  top-hotspots-json:
    description: 'JSON array of top-N hotspots only'

runs:
  using: 'node20'
  main: 'dist/index.js'
```

---

## PR Comment Format

### When hotspots are found:

```markdown
## Untested Hotspots

Found **47** untested functions. Showing top **20** by risk score.

**Coverage summary:** 312 / 359 functions tested (86.9%)

| Risk | Function | File | Callers | Factors |
|------|----------|------|---------|---------|
| 🔴 85 | `processPayment` | src/billing/charge.ts#L42 | 12 | production-reachable, 12 callers, exported |
| 🔴 75 | `validateOrder` | src/orders/validate.ts#L18 | 8 | production-reachable, 8 callers |
| 🟡 55 | `formatInvoice` | src/billing/format.ts#L91 | 3 | production-reachable, exported |
| 🟢 20 | `helperUtil` | src/utils/misc.ts#L5 | 1 | 1 caller |

_...and 27 more. See `untested-hotspots-json` output for full list._

### Files with lowest coverage

| File | Coverage | Untested |
|------|----------|----------|
| src/billing/charge.ts | 40.0% (2/5) | 3 functions |
| src/orders/validate.ts | 50.0% (3/6) | 3 functions |

---
_Powered by [Supermodel](https://supermodeltools.com) test coverage analysis_
```

### Risk indicators:
- 🔴 70-100: Critical — high-risk untested functions
- 🟡 40-69: Warning — moderate risk
- 🟢 0-39: Low — minor risk

### When no hotspots are found:

```markdown
## Untested Hotspots

All functions have test coverage! Your codebase is well-tested.

**Coverage summary:** 359 / 359 functions tested (100.0%)

---
_Powered by [Supermodel](https://supermodeltools.com) test coverage analysis_
```

### Limits:
- Top-N functions in the main table (default 20, configurable)
- Top 5 lowest-coverage files shown
- Full results available in `untested-hotspots-json` output

---

## Test Plan

### Unit Tests (`untested-hotspots.test.ts`)

| Test Case | Description |
|-----------|-------------|
| `shouldIgnoreFile` | Matches default patterns (node_modules, dist, test files) |
| `shouldIgnoreFile` | Matches custom user patterns |
| `shouldIgnoreFile` | Does not ignore normal source files |
| `computeRiskScore` | Production-reachable function scores 40+ |
| `computeRiskScore` | High caller count increases score |
| `computeRiskScore` | Exported function adds 20 points |
| `computeRiskScore` | Score caps at 100 |
| `computeRiskScore` | Zero-signal function scores 0 |
| `findUntestedHotspots` | Returns top-N sorted by risk descending |
| `findUntestedHotspots` | Filters out ignored file patterns |
| `findUntestedHotspots` | Respects minRiskScore threshold |
| `findUntestedHotspots` | Returns empty array when all functions tested |
| `findUntestedHotspots` | Handles empty untestedFunctions input |
| `formatPrComment` | Shows table with risk indicators |
| `formatPrComment` | Shows coverage summary stats |
| `formatPrComment` | Truncates at top-N with overflow message |
| `formatPrComment` | Shows clean message when no hotspots |
| `formatPrComment` | Includes lowest-coverage files section |
| `formatPrComment` | Contains Supermodel attribution |

### Integration Tests (`integration.test.ts`)

| Test Case | Description |
|-----------|-------------|
| API connectivity | Validates API key and successful response |
| Response shape | Confirms `coverageByFile` and `untestedFunctions` in response |
| End-to-end | Zips repo, calls API, verifies structured output |

---

## Acceptance Criteria

1. **Top-N untested-by-risk report per PR** — PR comment shows functions ranked by composite risk score, limited to configurable top-N (default 20)
2. **Aligns with `coverageByFile` output** — Coverage summary section and lowest-coverage-files table are derived directly from the API's `coverageByFile` response
3. **Aligns with `untestedFunctions` output** — Every hotspot in the report maps 1:1 to entries in the API's `untestedFunctions` response, with added risk scoring
4. **No instrumentation required** — Works purely from static graph analysis via Supermodel; no runtime coverage tools, no test mapping config
5. **Production call reachability** — Risk scoring weights production-reachable functions highest (40 points)
6. **Configurable thresholds** — `top-n`, `min-risk-score`, `ignore-patterns`, `fail-on-untested` are all configurable via action inputs
7. **Consistent with sibling tools** — Same project structure, build pipeline, SDK usage, PR comment format, and error handling patterns as Dead Code Hunter and Circular Dependency Hunter

---

## Dependencies

```json
{
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/exec": "^1.1.1",
    "@actions/github": "^6.0.0",
    "@supermodeltools/sdk": "^0.4.1",
    "minimatch": "^9.0.0"
  },
  "devDependencies": {
    "@types/minimatch": "^5.1.2",
    "@types/node": "^20.0.0",
    "@vercel/ncc": "^0.38.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0",
    "tsx": "^4.0.0"
  }
}
```

---

## Implementation Steps

1. **Scaffold project** — Copy structure from dead-code-hunter, rename files and references
2. **Define types** — `UntestedHotspot`, `CoverageByFile`, `UntestedFunction`, `CoverageStats` in `untested-hotspots.ts`
3. **Implement core logic** — `computeRiskScore`, `findUntestedHotspots`, `shouldIgnoreFile`, `formatPrComment`
4. **Implement entry point** — `index.ts` with zip creation, API call to `/v1/analysis/test-coverage-map`, result processing, PR comment posting
5. **Write unit tests** — All cases from test plan above
6. **Write integration test** — Validate against live API
7. **Configure action.yml** — Inputs, outputs, branding
8. **Build & verify** — `ncc build`, confirm `dist/index.js` works
9. **Write README.md** — Usage examples, input/output docs, risk scoring explanation
10. **Create example workflow** — `.github/workflows/untested-hotspots.yml`

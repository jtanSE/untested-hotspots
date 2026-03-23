import { minimatch } from 'minimatch';

// ── API response types ──────────────────────────────────────────────────────

export interface TestCoverageMapResponse {
  coverageByFile: CoverageByFile[];
  untestedFunctions: UntestedFunction[];
  stats: CoverageStats;
}

export interface CoverageByFile {
  filePath: string;
  totalFunctions: number;
  testedFunctions: number;
  untestedFunctions: number;
  coveragePercent: number;
}

export interface UntestedFunction {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  exported?: boolean;
  callerCount?: number;
  productionReachable?: boolean;
}

export interface CoverageStats {
  totalFiles: number;
  totalFunctions: number;
  testedFunctions: number;
  untestedFunctions: number;
  coveragePercent: number;
}

// ── Output types ────────────────────────────────────────────────────────────

export interface UntestedHotspot {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  riskScore: number;
  riskFactors: string[];
  callerCount: number;
  exported: boolean;
  productionReachable: boolean;
}

// ── Default exclude patterns (shared with sibling tools) ────────────────────

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/vendor/**',
  '**/target/**',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/__tests__/**',
  '**/__mocks__/**',
];

// ── Filtering ───────────────────────────────────────────────────────────────

/**
 * Checks if a file should be ignored based on exclude patterns.
 */
export function shouldIgnoreFile(filePath: string, ignorePatterns: string[] = []): boolean {
  const allPatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...ignorePatterns];
  return allPatterns.some(pattern => minimatch(filePath, pattern));
}

// ── Risk scoring ────────────────────────────────────────────────────────────

/**
 * Computes a risk score (0-100) for an untested function based on static signals.
 *
 * Weights:
 *   Production-reachable:  40 pts
 *   High caller count:     up to 25 pts
 *   Exported / public API: 20 pts
 *   File change frequency: up to 15 pts (optional)
 */
export function computeRiskScore(
  fn: UntestedFunction,
  fileChangeFrequency?: number
): number {
  let score = 0;

  if (fn.productionReachable) score += 40;

  const callers = fn.callerCount ?? 0;
  if (callers >= 10) score += 25;
  else if (callers >= 4) score += 18;
  else if (callers >= 1) score += 10;

  if (fn.exported) score += 20;

  if (fileChangeFrequency !== undefined) {
    score += Math.round(fileChangeFrequency * 15);
  }

  return Math.min(score, 100);
}

/**
 * Returns the risk indicator emoji for a given score.
 */
export function riskIndicator(score: number): string {
  if (score >= 70) return '🔴';
  if (score >= 40) return '🟡';
  return '🟢';
}

// ── Core analysis ───────────────────────────────────────────────────────────

/**
 * Filters, scores, and ranks untested functions into a top-N hotspot list.
 */
export function findUntestedHotspots(
  untestedFunctions: UntestedFunction[],
  ignorePatterns: string[] = [],
  topN: number = 20,
  minRiskScore: number = 0,
): UntestedHotspot[] {
  const hotspots: UntestedHotspot[] = [];

  for (const fn of untestedFunctions) {
    const filePath = fn.filePath || '';

    if (shouldIgnoreFile(filePath, ignorePatterns)) {
      continue;
    }

    const riskScore = computeRiskScore(fn);

    if (riskScore < minRiskScore) {
      continue;
    }

    const riskFactors: string[] = [];
    if (fn.productionReachable) riskFactors.push('production-reachable');
    if ((fn.callerCount ?? 0) > 0) riskFactors.push(`${fn.callerCount} caller${fn.callerCount === 1 ? '' : 's'}`);
    if (fn.exported) riskFactors.push('exported');

    hotspots.push({
      id: fn.id,
      name: fn.name || 'anonymous',
      filePath,
      startLine: fn.startLine,
      riskScore,
      riskFactors,
      callerCount: fn.callerCount ?? 0,
      exported: fn.exported ?? false,
      productionReachable: fn.productionReachable ?? false,
    });
  }

  hotspots.sort((a, b) => b.riskScore - a.riskScore);

  return hotspots.slice(0, topN);
}

// ── PR comment formatting ───────────────────────────────────────────────────

/**
 * Formats the untested hotspots results as a GitHub PR comment.
 */
export function formatPrComment(
  hotspots: UntestedHotspot[],
  totalUntested: number,
  stats: CoverageStats,
  topN: number = 20,
  coverageByFile: CoverageByFile[] = [],
): string {
  if (totalUntested === 0) {
    return `## Untested Hotspots

All functions have test coverage! Your codebase is well-tested.

**Coverage summary:** ${stats.testedFunctions} / ${stats.totalFunctions} functions tested (${stats.coveragePercent.toFixed(1)}%)

---
_Powered by [Supermodel](https://supermodeltools.com) test coverage analysis_`;
  }

  const displayCount = Math.min(hotspots.length, topN);

  const rows = hotspots
    .slice(0, displayCount)
    .map(h => {
      const indicator = riskIndicator(h.riskScore);
      const fileLink = h.startLine ? `${h.filePath}#L${h.startLine}` : h.filePath;
      const factors = h.riskFactors.join(', ');
      return `| ${indicator} ${h.riskScore} | \`${h.name}\` | ${fileLink} | ${h.callerCount} | ${factors} |`;
    })
    .join('\n');

  let comment = `## Untested Hotspots

Found **${totalUntested}** untested function${totalUntested === 1 ? '' : 's'}. Showing top **${displayCount}** by risk score.

**Coverage summary:** ${stats.testedFunctions} / ${stats.totalFunctions} functions tested (${stats.coveragePercent.toFixed(1)}%)

| Risk | Function | File | Callers | Factors |
|------|----------|------|---------|---------|
${rows}`;

  if (totalUntested > displayCount) {
    comment += `\n\n_...and ${totalUntested - displayCount} more. See \`untested-hotspots-json\` output for full list._`;
  }

  // Add lowest-coverage files section
  if (coverageByFile.length > 0) {
    const lowestCoverage = [...coverageByFile]
      .filter(f => f.untestedFunctions > 0)
      .sort((a, b) => a.coveragePercent - b.coveragePercent)
      .slice(0, 5);

    if (lowestCoverage.length > 0) {
      comment += '\n\n### Files with lowest coverage\n\n';
      comment += '| File | Coverage | Untested |\n';
      comment += '|------|----------|----------|\n';

      for (const file of lowestCoverage) {
        comment += `| ${file.filePath} | ${file.coveragePercent.toFixed(1)}% (${file.testedFunctions}/${file.totalFunctions}) | ${file.untestedFunctions} function${file.untestedFunctions === 1 ? '' : 's'} |\n`;
      }
    }
  }

  comment += `\n---\n_Powered by [Supermodel](https://supermodeltools.com) test coverage analysis_`;

  return comment;
}

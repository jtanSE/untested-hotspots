import { describe, it, expect } from 'vitest';
import {
  shouldIgnoreFile,
  computeRiskScore,
  riskIndicator,
  findUntestedHotspots,
  formatPrComment,
  UntestedFunction,
  UntestedHotspot,
  CoverageStats,
  CoverageByFile,
} from '../untested-hotspots';

// ── shouldIgnoreFile ────────────────────────────────────────────────────────

describe('shouldIgnoreFile', () => {
  it('should ignore node_modules', () => {
    expect(shouldIgnoreFile('node_modules/lodash/index.js')).toBe(true);
  });

  it('should ignore dist folder', () => {
    expect(shouldIgnoreFile('dist/index.js')).toBe(true);
  });

  it('should ignore build folder', () => {
    expect(shouldIgnoreFile('build/main.js')).toBe(true);
  });

  it('should ignore test files', () => {
    expect(shouldIgnoreFile('src/utils.test.ts')).toBe(true);
    expect(shouldIgnoreFile('src/utils.spec.js')).toBe(true);
    expect(shouldIgnoreFile('src/__tests__/helpers.ts')).toBe(true);
  });

  it('should not ignore regular source files', () => {
    expect(shouldIgnoreFile('src/utils.ts')).toBe(false);
    expect(shouldIgnoreFile('lib/helpers.js')).toBe(false);
  });

  it('should respect custom ignore patterns', () => {
    expect(shouldIgnoreFile('src/generated/api.ts', ['**/generated/**'])).toBe(true);
    expect(shouldIgnoreFile('src/utils.ts', ['**/generated/**'])).toBe(false);
  });
});

// ── computeRiskScore ────────────────────────────────────────────────────────

describe('computeRiskScore', () => {
  it('should score 0 for a function with no signals', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'helper', filePath: 'src/utils.ts',
    };
    expect(computeRiskScore(fn)).toBe(0);
  });

  it('should add 40 for production-reachable', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'handler', filePath: 'src/api.ts',
      productionReachable: true,
    };
    expect(computeRiskScore(fn)).toBe(40);
  });

  it('should add 10 for 1-3 callers', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'fn', filePath: 'src/a.ts',
      callerCount: 2,
    };
    expect(computeRiskScore(fn)).toBe(10);
  });

  it('should add 18 for 4-9 callers', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'fn', filePath: 'src/a.ts',
      callerCount: 7,
    };
    expect(computeRiskScore(fn)).toBe(18);
  });

  it('should add 25 for 10+ callers', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'fn', filePath: 'src/a.ts',
      callerCount: 15,
    };
    expect(computeRiskScore(fn)).toBe(25);
  });

  it('should add 20 for exported functions', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'fn', filePath: 'src/a.ts',
      exported: true,
    };
    expect(computeRiskScore(fn)).toBe(20);
  });

  it('should include file change frequency bonus', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'fn', filePath: 'src/a.ts',
    };
    expect(computeRiskScore(fn, 1.0)).toBe(15);
    expect(computeRiskScore(fn, 0.5)).toBe(8); // round(0.5 * 15) = 8
  });

  it('should cap at 100', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'fn', filePath: 'src/a.ts',
      productionReachable: true,
      callerCount: 20,
      exported: true,
    };
    // 40 + 25 + 20 = 85, plus file frequency 15 = 100
    expect(computeRiskScore(fn, 1.0)).toBe(100);
  });

  it('should combine multiple signals', () => {
    const fn: UntestedFunction = {
      id: '1', name: 'processPayment', filePath: 'src/billing.ts',
      productionReachable: true,
      callerCount: 12,
      exported: true,
    };
    // 40 + 25 + 20 = 85
    expect(computeRiskScore(fn)).toBe(85);
  });
});

// ── riskIndicator ───────────────────────────────────────────────────────────

describe('riskIndicator', () => {
  it('should return red for 70+', () => {
    expect(riskIndicator(70)).toBe('🔴');
    expect(riskIndicator(100)).toBe('🔴');
  });

  it('should return yellow for 40-69', () => {
    expect(riskIndicator(40)).toBe('🟡');
    expect(riskIndicator(69)).toBe('🟡');
  });

  it('should return green for 0-39', () => {
    expect(riskIndicator(0)).toBe('🟢');
    expect(riskIndicator(39)).toBe('🟢');
  });
});

// ── findUntestedHotspots ────────────────────────────────────────────────────

describe('findUntestedHotspots', () => {
  const makeFn = (overrides: Partial<UntestedFunction> = {}): UntestedFunction => ({
    id: '1',
    name: 'fn',
    filePath: 'src/a.ts',
    ...overrides,
  });

  it('should return empty array when no untested functions', () => {
    expect(findUntestedHotspots([])).toEqual([]);
  });

  it('should filter out ignored files', () => {
    const fns = [
      makeFn({ id: '1', filePath: 'node_modules/lib/index.js' }),
      makeFn({ id: '2', filePath: 'src/utils.ts', name: 'realFn' }),
    ];
    const result = findUntestedHotspots(fns);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('realFn');
  });

  it('should filter by custom ignore patterns', () => {
    const fns = [
      makeFn({ id: '1', filePath: 'src/generated/api.ts', name: 'genFn' }),
      makeFn({ id: '2', filePath: 'src/utils.ts', name: 'realFn' }),
    ];
    const result = findUntestedHotspots(fns, ['**/generated/**']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('realFn');
  });

  it('should sort by risk score descending', () => {
    const fns = [
      makeFn({ id: '1', name: 'low', callerCount: 0 }),
      makeFn({ id: '2', name: 'high', productionReachable: true, callerCount: 10, exported: true }),
      makeFn({ id: '3', name: 'mid', callerCount: 5 }),
    ];
    const result = findUntestedHotspots(fns);
    expect(result[0].name).toBe('high');
    expect(result[1].name).toBe('mid');
    expect(result[2].name).toBe('low');
  });

  it('should limit to top-N', () => {
    const fns = Array.from({ length: 10 }, (_, i) =>
      makeFn({ id: `${i}`, name: `fn${i}`, callerCount: i })
    );
    const result = findUntestedHotspots(fns, [], 3);
    expect(result).toHaveLength(3);
  });

  it('should respect minRiskScore', () => {
    const fns = [
      makeFn({ id: '1', name: 'low', callerCount: 0 }),                      // score 0
      makeFn({ id: '2', name: 'high', productionReachable: true }),           // score 40
    ];
    const result = findUntestedHotspots(fns, [], 20, 30);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('high');
  });

  it('should populate riskFactors correctly', () => {
    const fns = [
      makeFn({ id: '1', name: 'fn', productionReachable: true, callerCount: 3, exported: true }),
    ];
    const result = findUntestedHotspots(fns);
    expect(result[0].riskFactors).toContain('production-reachable');
    expect(result[0].riskFactors).toContain('3 callers');
    expect(result[0].riskFactors).toContain('exported');
  });

  it('should use singular "caller" for callerCount 1', () => {
    const fns = [makeFn({ id: '1', callerCount: 1 })];
    const result = findUntestedHotspots(fns);
    expect(result[0].riskFactors).toContain('1 caller');
  });
});

// ── formatPrComment ─────────────────────────────────────────────────────────

describe('formatPrComment', () => {
  const defaultStats: CoverageStats = {
    totalFiles: 10,
    totalFunctions: 100,
    testedFunctions: 80,
    untestedFunctions: 20,
    coveragePercent: 80.0,
  };

  it('should show clean message when no untested functions', () => {
    const stats: CoverageStats = { ...defaultStats, untestedFunctions: 0, testedFunctions: 100, coveragePercent: 100.0 };
    const comment = formatPrComment([], 0, stats);
    expect(comment).toContain('All functions have test coverage');
    expect(comment).toContain('100 / 100 functions tested');
    expect(comment).toContain('100.0%');
  });

  it('should show risk table with indicators', () => {
    const hotspots: UntestedHotspot[] = [
      {
        id: '1', name: 'processPayment', filePath: 'src/billing.ts', startLine: 42,
        riskScore: 85, riskFactors: ['production-reachable', '12 callers', 'exported'],
        callerCount: 12, exported: true, productionReachable: true,
      },
    ];
    const comment = formatPrComment(hotspots, 1, defaultStats);
    expect(comment).toContain('🔴 85');
    expect(comment).toContain('`processPayment`');
    expect(comment).toContain('src/billing.ts#L42');
    expect(comment).toContain('production-reachable');
  });

  it('should show coverage summary', () => {
    const comment = formatPrComment([], 5, defaultStats);
    expect(comment).toContain('80 / 100 functions tested (80.0%)');
  });

  it('should show overflow message when more results exist', () => {
    const hotspots: UntestedHotspot[] = Array.from({ length: 5 }, (_, i) => ({
      id: `${i}`, name: `fn${i}`, filePath: `src/f${i}.ts`,
      riskScore: 50, riskFactors: [], callerCount: 0, exported: false, productionReachable: false,
    }));
    const comment = formatPrComment(hotspots, 30, defaultStats, 5);
    expect(comment).toContain('and 25 more');
  });

  it('should include lowest-coverage files section', () => {
    const hotspots: UntestedHotspot[] = [{
      id: '1', name: 'fn', filePath: 'src/a.ts',
      riskScore: 50, riskFactors: [], callerCount: 0, exported: false, productionReachable: false,
    }];
    const coverageByFile: CoverageByFile[] = [
      { filePath: 'src/billing.ts', totalFunctions: 5, testedFunctions: 2, untestedFunctions: 3, coveragePercent: 40.0 },
      { filePath: 'src/utils.ts', totalFunctions: 10, testedFunctions: 10, untestedFunctions: 0, coveragePercent: 100.0 },
    ];
    const comment = formatPrComment(hotspots, 1, defaultStats, 20, coverageByFile);
    expect(comment).toContain('Files with lowest coverage');
    expect(comment).toContain('src/billing.ts');
    expect(comment).toContain('40.0%');
    // Should not include 100% coverage file
    expect(comment).not.toContain('src/utils.ts');
  });

  it('should include Supermodel attribution', () => {
    const comment = formatPrComment([], 0, { ...defaultStats, coveragePercent: 100 });
    expect(comment).toContain('Powered by [Supermodel]');
  });

  it('should handle singular "function" for count of 1', () => {
    const hotspots: UntestedHotspot[] = [{
      id: '1', name: 'fn', filePath: 'src/a.ts',
      riskScore: 50, riskFactors: [], callerCount: 0, exported: false, productionReachable: false,
    }];
    const comment = formatPrComment(hotspots, 1, defaultStats);
    expect(comment).toContain('1** untested function.');
  });

  it('should handle plural "functions" for count > 1', () => {
    const hotspots: UntestedHotspot[] = [{
      id: '1', name: 'fn', filePath: 'src/a.ts',
      riskScore: 50, riskFactors: [], callerCount: 0, exported: false, productionReachable: false,
    }];
    const comment = formatPrComment(hotspots, 5, defaultStats);
    expect(comment).toContain('5** untested functions.');
  });
});

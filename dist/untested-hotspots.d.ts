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
export declare const DEFAULT_EXCLUDE_PATTERNS: string[];
/**
 * Checks if a file should be ignored based on exclude patterns.
 */
export declare function shouldIgnoreFile(filePath: string, ignorePatterns?: string[]): boolean;
/**
 * Computes a risk score (0-100) for an untested function based on static signals.
 *
 * Weights:
 *   Production-reachable:  40 pts
 *   High caller count:     up to 25 pts
 *   Exported / public API: 20 pts
 *   File change frequency: up to 15 pts (optional)
 */
export declare function computeRiskScore(fn: UntestedFunction, fileChangeFrequency?: number): number;
/**
 * Returns the risk indicator emoji for a given score.
 */
export declare function riskIndicator(score: number): string;
/**
 * Filters, scores, and ranks untested functions into a top-N hotspot list.
 */
export declare function findUntestedHotspots(untestedFunctions: UntestedFunction[], ignorePatterns?: string[], topN?: number, minRiskScore?: number): UntestedHotspot[];
/**
 * Formats the untested hotspots results as a GitHub PR comment.
 */
export declare function formatPrComment(hotspots: UntestedHotspot[], totalUntested: number, stats: CoverageStats, topN?: number, coverageByFile?: CoverageByFile[]): string;

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { findUntestedHotspots, TestCoverageMapResponse } from '../untested-hotspots';

const API_KEY = process.env.SUPERMODEL_API_KEY;
const SKIP_INTEGRATION = !API_KEY;

describe.skipIf(SKIP_INTEGRATION)('Integration Tests', () => {
  let zipPath: string;
  let idempotencyKey: string;
  let basePath: string;

  beforeAll(async () => {
    basePath = process.env.SUPERMODEL_BASE_URL || 'https://api.supermodeltools.com';

    // Create zip of this repo
    const repoRoot = path.resolve(__dirname, '../..');
    zipPath = '/tmp/untested-hotspots-test.zip';

    execSync(`git archive -o ${zipPath} HEAD`, { cwd: repoRoot });

    const commitHash = execSync('git rev-parse --short HEAD', { cwd: repoRoot })
      .toString()
      .trim();
    idempotencyKey = `untested-hotspots:test-coverage:${commitHash}`;
  });

  it('should call the test-coverage-map API and get a response', async () => {
    const zipBuffer = await fs.readFile(zipPath);
    const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });

    const formData = new FormData();
    formData.append('idempotencyKey', idempotencyKey);
    formData.append('file', zipBlob, 'repo.zip');

    const response = await fetch(`${basePath}/v1/analysis/test-coverage-map`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY! },
      body: formData,
    });

    expect(response.ok).toBe(true);

    const data = await response.json() as TestCoverageMapResponse;

    expect(data).toBeDefined();
    expect(data.coverageByFile).toBeDefined();
    expect(data.untestedFunctions).toBeDefined();
    expect(data.stats).toBeDefined();

    console.log('API Stats:', data.stats);
    console.log('Files with coverage data:', data.coverageByFile?.length);
    console.log('Untested functions:', data.untestedFunctions?.length);
  }, 60000);

  it('should find untested hotspots in the repo itself', async () => {
    const zipBuffer = await fs.readFile(zipPath);
    const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });

    const formData = new FormData();
    formData.append('idempotencyKey', idempotencyKey);
    formData.append('file', zipBlob, 'repo.zip');

    const response = await fetch(`${basePath}/v1/analysis/test-coverage-map`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY! },
      body: formData,
    });

    const data = await response.json() as TestCoverageMapResponse;
    const hotspots = findUntestedHotspots(data.untestedFunctions || []);

    console.log('\n=== Untested Hotspots Self-Analysis ===');
    console.log(`Total untested: ${data.untestedFunctions?.length || 0}`);
    console.log(`Top hotspots: ${hotspots.length}`);

    if (hotspots.length > 0) {
      console.log('\nTop untested functions by risk:');
      for (const h of hotspots.slice(0, 10)) {
        console.log(`  [${h.riskScore}] ${h.name} (${h.filePath}:${h.startLine || '?'}) - ${h.riskFactors.join(', ')}`);
      }
    }

    expect(Array.isArray(hotspots)).toBe(true);
  }, 60000);
});

describe('Integration Test Prerequisites', () => {
  it('should have SUPERMODEL_API_KEY to run integration tests', () => {
    if (SKIP_INTEGRATION) {
      console.log('⚠️  SUPERMODEL_API_KEY not set - skipping integration tests');
      console.log('   Set the environment variable to run integration tests');
    } else {
      console.log('✓ SUPERMODEL_API_KEY is set');
    }
    expect(true).toBe(true);
  });
});

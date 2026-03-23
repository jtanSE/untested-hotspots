import * as fs from 'fs/promises';
import * as path from 'path';
import * as child_process from 'child_process';
import { promisify } from 'util';
import {
  findUntestedHotspots,
  formatPrComment,
  TestCoverageMapResponse,
} from './src/untested-hotspots';

const exec = promisify(child_process.exec);

async function testLocalRepo(repoPath: string) {
  console.log(`\n🔍 Analyzing: ${repoPath}\n`);

  const apiKey = process.env.SUPERMODEL_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: SUPERMODEL_API_KEY environment variable not set');
    console.log('   Get your key at: https://dashboard.supermodeltools.com');
    process.exit(1);
  }

  try {
    // Step 1: Create zip archive
    const zipPath = path.join(repoPath, '.untested-hotspots-test.zip');
    console.log('📦 Creating zip archive...');

    await exec(`git archive -o "${zipPath}" HEAD`, { cwd: repoPath });

    const stats = await fs.stat(zipPath);
    console.log(`   Archive size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Step 2: Generate idempotency key
    const { stdout: commitHash } = await exec('git rev-parse --short HEAD', { cwd: repoPath });
    const repoName = path.basename(repoPath);
    const idempotencyKey = `${repoName}:supermodel:${commitHash.trim()}`;

    // Step 3: Call Supermodel API
    console.log('🔎 Analyzing test coverage with Supermodel...');

    const basePath = process.env.SUPERMODEL_BASE_URL || 'https://api.supermodeltools.com';

    const zipBuffer = await fs.readFile(zipPath);
    const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });

    const formData = new FormData();
    formData.append('idempotencyKey', idempotencyKey);
    formData.append('file', zipBlob, 'repo.zip');

    const response = await fetch(`${basePath}/v1/analysis/test-coverage-map`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      const error: any = new Error(`API error (${response.status})`);
      error.response = { status: response.status, data: text };
      throw error;
    }

    const data = await response.json() as TestCoverageMapResponse;

    // Step 4: Analyze
    const { coverageByFile, untestedFunctions, stats: coverageStats } = data;

    console.log(`   Total functions: ${coverageStats.totalFunctions}`);
    console.log(`   Tested: ${coverageStats.testedFunctions}`);
    console.log(`   Untested: ${coverageStats.untestedFunctions}`);
    console.log(`   Coverage: ${coverageStats.coveragePercent.toFixed(1)}%`);

    const hotspots = findUntestedHotspots(untestedFunctions);

    console.log(`\n✨ Analysis complete!\n`);

    // Step 5: Display results
    if (hotspots.length === 0) {
      console.log('✅ No untested hotspots found! Your codebase is well-tested.');
    } else {
      console.log(`⚠️  Found ${untestedFunctions.length} untested functions. Top ${hotspots.length} by risk:\n`);

      hotspots.slice(0, 10).forEach((h, idx) => {
        const indicator = h.riskScore >= 70 ? '🔴' : h.riskScore >= 40 ? '🟡' : '🟢';
        console.log(`${idx + 1}. ${indicator} [${h.riskScore}] ${h.name} (${h.filePath}:${h.startLine || '?'})`);
        if (h.riskFactors.length > 0) {
          console.log(`   Factors: ${h.riskFactors.join(', ')}`);
        }
      });

      if (hotspots.length > 10) {
        console.log(`\n...and ${hotspots.length - 10} more`);
      }

      console.log('\n📝 PR Comment Preview:');
      console.log('─'.repeat(80));
      console.log(formatPrComment(hotspots, untestedFunctions.length, coverageStats, 20, coverageByFile));
      console.log('─'.repeat(80));
    }

    // Step 6: Clean up
    await fs.unlink(zipPath);

  } catch (error: any) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      if (status === 401) {
        console.error('❌ Invalid API key. Get your key at https://dashboard.supermodeltools.com');
      } else if (status === 402) {
        console.error('❌ Payment Required (402):');
        console.error('   This usually means:');
        console.error('   - Your account needs to be set up with billing');
        console.error('   - Or you need to add credits to your account');
        console.error('   - Or the API key doesn\'t have access to this feature');
        console.error('\n   Please check your account at: https://dashboard.supermodeltools.com');
        if (data) {
          console.error(`\n   API Response: ${data}`);
        }
      } else {
        console.error(`❌ API error (${status}): ${error.message}`);
        if (data) {
          console.error(`   Response: ${data}`);
        }
      }
    } else {
      console.error(`❌ Error: ${error.message}`);
    }
    process.exit(1);
  }
}

const repoPath = process.argv[2] || process.cwd();

testLocalRepo(repoPath).catch(console.error);

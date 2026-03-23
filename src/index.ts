import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  findUntestedHotspots,
  formatPrComment,
  TestCoverageMapResponse,
} from './untested-hotspots';

async function createZipArchive(workspacePath: string): Promise<string> {
  const zipPath = path.join(workspacePath, '.untested-hotspots-repo.zip');

  core.info('Creating zip archive...');

  await exec.exec('git', ['archive', '-o', zipPath, 'HEAD'], {
    cwd: workspacePath,
  });

  const stats = await fs.stat(zipPath);
  core.info(`Archive size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  return zipPath;
}

async function generateIdempotencyKey(workspacePath: string): Promise<string> {
  let output = '';
  await exec.exec('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: workspacePath,
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString();
      },
    },
    silent: true,
  });

  const commitHash = output.trim();
  const repoName = path.basename(workspacePath);

  return `${repoName}:supermodel:${commitHash}`;
}

/**
 * Calls POST /v1/analysis/test-coverage-map directly.
 * The SDK doesn't have this method yet, so we use fetch with the same
 * auth pattern (x-api-key header) as the SDK's generated client.
 */
async function callTestCoverageMap(
  basePath: string,
  apiKey: string,
  idempotencyKey: string,
  zipBlob: Blob,
): Promise<TestCoverageMapResponse> {
  const formData = new FormData();
  formData.append('idempotencyKey', idempotencyKey);
  formData.append('file', zipBlob, 'repo.zip');

  const response = await fetch(`${basePath}/v1/analysis/test-coverage-map`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const error: any = new Error(`API error (${response.status})`);
    error.response = { status: response.status, data: await response.text() };
    throw error;
  }

  return response.json() as Promise<TestCoverageMapResponse>;
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('supermodel-api-key', { required: true }).trim();

    if (!apiKey.startsWith('smsk_')) {
      core.warning('API key format looks incorrect. Get your key at https://dashboard.supermodeltools.com');
    }

    const commentOnPr = core.getBooleanInput('comment-on-pr');
    const failOnUntested = core.getBooleanInput('fail-on-untested');
    const topN = parseInt(core.getInput('top-n') || '20', 10);
    const minRiskScore = parseInt(core.getInput('min-risk-score') || '0', 10);
    const ignorePatterns = JSON.parse(core.getInput('ignore-patterns') || '[]');

    const workspacePath = process.env.GITHUB_WORKSPACE || process.cwd();

    core.info('Untested Hotspots starting...');

    // Step 1: Create zip archive
    const zipPath = await createZipArchive(workspacePath);

    // Step 2: Generate idempotency key
    const idempotencyKey = await generateIdempotencyKey(workspacePath);

    // Step 3: Call Supermodel API
    core.info('Analyzing test coverage with Supermodel...');

    const basePath = process.env.SUPERMODEL_BASE_URL || 'https://api.supermodeltools.com';

    const zipBuffer = await fs.readFile(zipPath);
    const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });

    const response = await callTestCoverageMap(basePath, apiKey, idempotencyKey, zipBlob);

    // Step 4: Analyze and rank
    const { coverageByFile, untestedFunctions, stats } = response;

    const hotspots = findUntestedHotspots(
      untestedFunctions,
      ignorePatterns,
      topN,
      minRiskScore,
    );

    const totalUntested = untestedFunctions.length;

    core.info(`Found ${totalUntested} untested functions, showing top ${hotspots.length} by risk`);

    // Step 5: Set outputs
    core.setOutput('untested-count', totalUntested);
    core.setOutput('untested-hotspots-json', JSON.stringify(
      findUntestedHotspots(untestedFunctions, ignorePatterns, untestedFunctions.length, 0)
    ));
    core.setOutput('top-hotspots-json', JSON.stringify(hotspots));

    // Step 6: Post PR comment if enabled
    if (commentOnPr && github.context.payload.pull_request) {
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        const octokit = github.getOctokit(token);
        const comment = formatPrComment(hotspots, totalUntested, stats, topN, coverageByFile);

        await octokit.rest.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: github.context.payload.pull_request.number,
          body: comment,
        });

        core.info('Posted findings to PR');
      } else {
        core.warning('GITHUB_TOKEN not available, skipping PR comment');
      }
    }

    // Step 7: Clean up
    await fs.unlink(zipPath);

    // Step 8: Fail if configured and untested hotspots found
    if (totalUntested > 0 && failOnUntested) {
      core.setFailed(`Found ${totalUntested} untested functions (${hotspots.length} above risk threshold)`);
    }

  } catch (error: any) {
    if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        core.error('Invalid API key. Get your key at https://dashboard.supermodeltools.com');
      } else if (status === 402) {
        core.error('Payment required. Check your account at https://dashboard.supermodeltools.com');
      } else {
        core.error(`API error (${status})`);
      }
    }

    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

run();

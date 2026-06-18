#!/usr/bin/env node

/**
 * korea-integration run entry point.
 *
 * Usage:
 *   node run.mjs scan jobkorea
 *   node run.mjs scan saramin
 *   node run.mjs apply --report 42
 *   node run.mjs apply --dry-run --report 5
 *   node run.mjs status
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function usage() {
  console.log(`
Korea Job Portal Integration — Run Script
==========================================

  node run.mjs scan <provider>   → Scan job portal (jobkorea | saramin)
  node run.mjs apply <...args>   → Auto-apply (JobKorea only)
  node run.mjs status            → Show config status

Examples:
  node run.mjs scan jobkorea
  node run.mjs scan saramin
  node run.mjs apply --report 42 --dry-run
  node run.mjs apply --url "https://www.jobkorea.co.kr/Recruit/GI_Read/..." --headless=false
  node run.mjs status
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help') { usage(); return; }

  if (cmd === 'status') {
    const files = [
      'config/jobkorea-profile.yml',
      'config/profile.yml',
      'cv.md',
      'portals.yml',
      'data/pipeline.md',
      'data/applications.md',
    ];
    console.log('\nConfig Status:');
    for (const f of files) {
      const exists = existsSync(resolve(PROJECT_ROOT, f));
      console.log(`  ${exists ? '✓' : '✗'} ${f}`);
    }
    return;
  }

  if (cmd === 'scan') {
    const provider = args[1];
    if (!provider) { console.log('Usage: node run.mjs scan <jobkorea|saramin>'); return; }

    // Import scan.mjs dynamically and filter by company name
    const { default: child_process } = await import('child_process');
    const { execFileSync } = child_process;

    const companyMap = { jobkorea: 'JobKorea', saramin: 'Saramin' };
    const company = companyMap[provider.toLowerCase()];
    if (!company) { console.log(`Unknown provider: ${provider}. Use jobkorea or saramin.`); return; }

    console.log(`\n→ Scanning ${company}...\n`);
    try {
      execFileSync('node', ['scan.mjs', '--company', company], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
        timeout: 180_000,
      });
    } catch (err) {
      console.error(`Scan failed: ${err.message}`);
    }
    return;
  }

  if (cmd === 'apply') {
    // Pass through remaining args to jobkorea-apply.mjs
    const { spawn } = await import('child_process');
    console.log('\n→ JobKorea Auto-Apply\n');
    const applyPath = resolve(__dirname, 'scripts', 'jobkorea-apply.mjs');
    const child = spawn('node', [applyPath, ...args.slice(1)], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    await new Promise((resolve, reject) => {
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
      child.on('error', reject);
    });
    return;
  }

  usage();
}

function isMain() {
  try {
    if (!process.argv[1]) return false;
    const resolved = resolve(process.argv[1]).replace(/\\/g, '/');
    const expected = import.meta.url.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    return resolved === expected;
  } catch { return false; }
}

if (isMain()) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

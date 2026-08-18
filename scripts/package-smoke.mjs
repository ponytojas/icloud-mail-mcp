#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'icloud-mail-mcp-smoke-')
);
let tarball;

try {
  const { stdout } = await exec('pnpm', ['pack', '--json'], {
    cwd: projectRoot,
  });
  const packed = JSON.parse(stdout);
  const packageInfo = Array.isArray(packed) ? packed[0] : packed;
  if (!packageInfo?.filename) throw new Error('pnpm pack returned no filename');
  tarball = path.join(projectRoot, packageInfo.filename);
  await exec('npm', ['init', '-y'], { cwd: temporaryDirectory });
  await exec('npm', ['install', '--ignore-scripts', tarball], {
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      npm_config_cache: path.join(temporaryDirectory, '.npm-cache'),
    },
  });
  const packageJson = JSON.parse(
    await readFile(
      path.join(
        temporaryDirectory,
        'node_modules/icloud-mail-mcp/package.json'
      ),
      'utf8'
    )
  );
  if (packageJson.bin?.['icloud-mail-mcp'] !== 'dist/index.js') {
    throw new Error(
      'Packed package does not expose icloud-mail-mcp executable'
    );
  }
  const { stdout: helpOutput } = await exec(
    path.join(temporaryDirectory, 'node_modules/.bin/icloud-mail-mcp'),
    ['--help'],
    { cwd: temporaryDirectory }
  );
  if (!helpOutput.includes('iCloud Mail MCP Server')) {
    throw new Error('Executable help output was not recognized');
  }
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
}

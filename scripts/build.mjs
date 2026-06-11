import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSjrIndex } from './generate_sjr_index.mjs';

const root = process.cwd();
const srcDir = path.join(root, 'GSVR');
const distDir = path.join(root, 'dist');

// A tiny build step: copy the extension folder to ./dist so it can be loaded
// directly via chrome://extensions (Load unpacked).

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  'tests', // tests are useful in-source, but not needed in the packed extension
  'sjr' // raw SCImago CSVs (~230 MB) feed the index generator; only the compact index ships
]);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const ent of entries) {
    if (ent.isDirectory() && IGNORE_DIRS.has(ent.name)) continue;

    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);

    if (ent.isDirectory()) {
      await copyDir(from, to);
    } else if (ent.isFile()) {
      await fs.copyFile(from, to);
    }
    // (No symlinks expected in this repo.)
  }
}

if (!(await exists(srcDir))) {
  throw new Error(`Expected extension sources at: ${srcDir}`);
}

const manifestPath = path.join(srcDir, 'manifest.json');
if (!(await exists(manifestPath))) {
  throw new Error(`manifest.json not found at: ${manifestPath}`);
}

const sjrResult = await generateSjrIndex({ root });
await fs.rm(distDir, { recursive: true, force: true });
await copyDir(srcDir, distDir);

console.log('Build complete.');
console.log(`  Source: ${srcDir}`);
console.log(`  Output: ${distDir}`);
console.log(`  SJR index: ${sjrResult.outPath} (${sjrResult.count} entries)`);
console.log('Load the extension from ./dist via chrome://extensions → Load unpacked.');

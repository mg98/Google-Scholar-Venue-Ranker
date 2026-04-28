import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');

await fs.rm(distDir, { recursive: true, force: true });
console.log(`Cleaned: ${distDir}`);

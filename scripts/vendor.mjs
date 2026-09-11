#!/usr/bin/env node
// Copies the browser build of openpgp.js out of node_modules into public/vendor.
// Run after changing the openpgp devDependency version: npm run vendor
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'node_modules', 'openpgp', 'dist', 'openpgp.min.js');
const destDir = path.join(ROOT, 'public', 'vendor');
const dest = path.join(destDir, 'openpgp.min.js');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'node_modules', 'openpgp', 'package.json'), 'utf8'));
await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
const banner = (await readFile(dest, 'utf8')).slice(0, 120).split('\n')[0];
console.log(`vendored openpgp ${pkg.version} -> public/vendor/openpgp.min.js`);
console.log(`banner: ${banner}`);

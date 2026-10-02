// Repairs files that were re-saved by Windows PowerShell 5.1 (UTF-8 BOM, UTF-8 text decoded as cp1252 = "mojibake").
// Usage: node scripts/fix-encoding.mjs        (processes the whole repository except node_modules/dist/.next/generated)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const skipDirs = new Set(['node_modules', 'dist', '.next', 'generated', '.local', '.git', 'bin', 'obj']);
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.prisma', '.sql', '.md', '.cs', '.csproj', '.css', '.yml', '.yaml', '.example', '.sh', '.txt']);

const cp1252 = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}));

function repairLine(line) {
  if (!/[âÂÃ]/.test(line)) return line;
  const bytes = [];
  for (const ch of line) {
    const code = ch.codePointAt(0);
    if (code < 0x100) bytes.push(code);
    else if (cp1252.has(ch)) bytes.push(cp1252.get(ch));
    else return line; // contains genuine non-cp1252 characters: leave untouched
  }
  const fixed = Buffer.from(bytes).toString('utf8');
  return fixed.includes('�') ? line : fixed;
}

let changed = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!skipDirs.has(name)) walk(path);
      continue;
    }
    if (!exts.has(extname(name)) && name !== '.env.example' && name !== '.gitignore') continue;
    const original = readFileSync(path, 'utf8');
    let text = original.replace(/^﻿/, '');
    text = text.split('\n').map(repairLine).join('\n');
    if (text !== original) {
      writeFileSync(path, text, 'utf8');
      changed++;
      console.log('fixed', path.replace(root, ''));
    }
  }
}
walk(root);
console.log(`${changed} file(s) repaired`);

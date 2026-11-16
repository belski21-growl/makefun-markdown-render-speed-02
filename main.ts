// main.ts — the program the harness runs: `node /bot/main.ts` (Node 22,
// TypeScript types stripped natively; erasable syntax only).
//
// It reads MAKEFUN_INPUT_DIR/cases.json (default /input), renders every
// case on its own with parse() from parse.js, and writes the HTML strings,
// in order, as a JSON array to MAKEFUN_OUTPUT_DIR/html.json (default
// /output). All rendering lives in parse.js; this file only moves data.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function loadCases(dir: string): Case[] {
  const raw = readFileSync(join(dir, 'cases.json'), 'utf8');
  return JSON.parse(raw) as Case[];
}

function renderCases(cases: Case[]): string[] {
  const html: string[] = [];
  for (const c of cases) html.push(parse(c.markdown));
  return html;
}

function run(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = loadCases(inputDir);
  const html = renderCases(cases);
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

run();

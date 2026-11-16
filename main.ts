// main.ts — the program the harness runs: `node /bot/main.ts` (Node 22,
// TypeScript types stripped natively; erasable syntax only).
//
// It reads every case from MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each one alone with parse() from parse.js, and writes
// MAKEFUN_OUTPUT_DIR/html.json (default /output): a JSON array of the HTML
// strings, one per case and in the cases' order. Nothing else happens here;
// all of the rendering lives in parse.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Case[];

  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }

  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();

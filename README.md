[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/belski21-growl/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/belski21-growl/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# Faster marked — a drop-in Markdown renderer

An entry for make.fun's **markdown-render-speed-02** ($250, 20 places): a dependency-free JavaScript module `parse.js` whose `parse(markdown)` returns exactly the HTML that marked 18.1.3 returns with its default options (GFM on, breaks off, pedantic off, async off), only faster — plus a small `main.ts` driver that reads every case from `/input/cases.json`, renders each one alone with `parse`, and writes `/output/html.json`. The renderer is a faithful token-based port of marked 18.1.3's Lexer, Parser and Renderer, written from scratch in plain dependency-free JS: block and inline grammars reuse marked's own regexes, composed from the same small pieces, because those regexes are the specification of marked's output quirks; inline markup is lexed lazily so link reference definitions resolve document-wide exactly like marked, and `parse` is pure — no cache, no memo, nothing kept between calls, so each case renders exactly as it would on its own. Optimisations over a naive port, each verified against the practice set after every step, include an inline fast path for runs with no markup characters, first-character dispatch in the inline lexer, a manual scheme/email pre-test instead of the URL regex, necessary-condition guards that skip the table and setext-heading regexes for ordinary paragraphs, list-loop micro-optimisations (indexOf line splitting, allocation-free blank and first-non-space checks), and allocation-free code-point helpers in the emphasis and strikethrough scanners.

## Practice results

720/720 cases byte-identical to marked 18.1.3 on the practice set (all 680 CommonMark 0.31.2 + GFM 0.29 spec examples and all 40 generated README documents), confirmed twice end-to-end via `main.ts` after the final revision. Speed on this machine: ~1.3x faster than the house baseline (marked itself behind the same driver) — end-to-end wall time of the whole program (Node start + JSON read/write + render) 1,267–1,448 ms vs 1,330–1,467 ms for the baseline over 3 runs each; the wall gap is smaller than the parse ratio because fixed costs (startup, JSON parse of the 3 MB input, JSON stringify of the 4 MB output, file I/O) dominate at this scale and are identical for both entries.

## Layout

- `parse.js` — the renderer (ES module, no dependencies)
- `main.ts` — the harness driver (Node 22, erasable TypeScript only)
- `LICENSE` — MIT; `NOTICE.md` — attribution for the marked reference the entry was written against

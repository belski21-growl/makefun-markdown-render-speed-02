[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/belski21-growl/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/belski21-growl/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# Faster marked — a drop-in Markdown renderer

An entry for make.fun's **markdown-render-speed-02** ($250, 20 places): a dependency-free JavaScript module `parse.js` whose `parse(markdown)` returns exactly the HTML that marked 18.1.3 returns with default options (GFM on), only faster — plus a small `main.ts` driver. Practice: 720/720 byte-identical, ~1.3x faster than marked. Node 22, stdlib only, deterministic, no network at runtime.

// parse.js — a fast, dependency-free Markdown renderer that matches marked 18.1.3.
//
// What this module promises: parse(md) returns exactly the HTML that
// marked.parse(md) returns under marked's defaults (GFM on, breaks off,
// pedantic off, async off), only sooner. Nothing here reaches the network,
// keeps state between calls, or reads the clock: every call starts from a
// clean slate, so a case renders the same alone as it does in a batch.
//
// How it works, in two passes. First the block pass walks the document and
// cuts it into block tokens (headings, fences, lists, quotes, tables and
// the rest). Inline runs are not lexed yet: each block only queues its raw
// text, and the queue is drained after the whole document has been scanned,
// which is what lets a link reference defined anywhere in the document
// resolve everywhere, exactly like marked. Then the render pass walks the
// token tree and concatenates HTML strings.
//
// The regular expressions below are the grammar of marked 18.1.3, assembled
// from the same small fragments marked assembles them from. They are the
// specification of marked's output quirks — where marked disagrees with the
// CommonMark or GFM spec, marked's HTML is what this module reproduces, so
// the patterns are reproduced faithfully, only written in a different shape
// (built through mkRx from their source text) and filed under new names.
//
// Speed notes: plain runs with no markup character at all shortcut to a
// single text token; the inline scanner dispatches on the first character
// instead of trying every tokenizer; bare-URL detection is a hand-rolled
// prefix/word scan rather than the URL regex; the table and setext checks
// are guarded by cheap necessary conditions; list loops split lines with
// indexOf and scan indents without allocating; emphasis and strike scanners
// measure code points without building arrays. Each of those was checked
// against the practice set right after it landed.

// --- per-call state (freshly reset by parse(); recursion shares it) --------

let refDefs;          // reference definitions of the document being parsed
let pendingInline;    // queued {src, tokens} inline runs, lexed after blocks
let atTop;            // block lexer "top" flag: paragraphs only at top level
let insideLink;       // an <a> tag is currently open in the inline pass
let insideRaw;        // a <pre>/<code>/<kbd>/<script> tag is currently open
let linkDone;         // the current inline run already emitted a link
let parenMayFollow;   // a '(' may still follow a ']' (link paren possible)
let hintFrames;       // emphasis/strike closer-hint frames of active passes

// --- regex assembly ---------------------------------------------------------

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Build a RegExp from a source string plus flags.
const mkRx = (src, flags) => new RegExp(src, flags);

// Weave fragments into a pattern: each placeholder word is replaced, once,
// by the fragment's source with a leading ^ stripped (an anchor nested
// inside another pattern would be meaningless). Only the first occurrence
// of each placeholder is replaced, so text an earlier fragment inserted
// is never re-replaced by a later one.
function weave(pattern, pieces) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  for (const [name, piece] of Object.entries(pieces)) {
    const raw = typeof piece === 'string' ? piece : piece.source;
    const cleaned = raw.replace(/(^|[^\[])\^/g, '$1');
    const at = src.indexOf(name);
    if (at >= 0) src = src.slice(0, at) + cleaned + src.slice(at + name.length);
  }
  return src;
}

// Same as weave, but every occurrence of each placeholder is replaced
// (the setext pattern repeats its placeholders; its fragments hold no
// other placeholder names, so a global replace is safe there).
function weaveAll(pattern, pieces) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  for (const [name, piece] of Object.entries(pieces)) {
    const raw = typeof piece === 'string' ? piece : piece.source;
    const cleaned = raw.replace(/(^|[^\[])\^/g, '$1');
    src = src.split(name).join(cleaned);
  }
  return src;
}

// --- shared pattern atoms ---------------------------------------------------

const P = {
  stripCodeIndent: mkRx(/^(?: {0,3}\t| {1,4})/gm.source, 'gm'),
  linkBracketUnesc: mkRx(/\\([\[\]])/g.source, 'g'),
  fenceIndentFix: mkRx(/^(\s+)(?:```)/.source, ''),
  leadWs: mkRx(/^\s+/.source, ''),
  trailHash: mkRx(/#$/.source, ''),
  leadSpace: mkRx(/^ /.source, ''),
  trailSpace: mkRx(/ $/.source, ''),
  trailWsChar: mkRx(/[ \t]$/.source, ''),
  nonSpace: mkRx(/[^ ]/.source, ''),
  nlGlobal: mkRx(/\n/g.source, 'g'),
  tabGlobal: mkRx(/\t/g.source, 'g'),
  leadWsTab: mkRx(/^[ \t]+/.source, ''),
  wsRunGlobal: mkRx(/\s+/g.source, 'g'),
  blankLn: mkRx(/^[ \t]*$/.source, ''),
  dblBlankTail: mkRx(/\n[ \t]*\n[ \t]*$/.source, ''),
  bqOpen: mkRx(/^ {0,3}>/.source, ''),
  bqSetextFix: mkRx(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g.source, 'g'),
  bqMarkerStrip: mkRx(/^ {0,3}>[ \t]?/gm.source, 'gm'),
  bqMarkerWs: mkRx(/^( {0,3}>)([ \t]+)/gm.source, 'gm'),
  listNestFix: mkRx(/^ {1,4}(?=( {4})*[^ ])/g.source, 'g'),
  listTaskTest: mkRx(/^\[[ xX]\][ \t]+\S/.source, ''),
  listTaskStrip: mkRx(/^\[[ xX]\][ \t]+/.source, ''),
  taskBox: mkRx(/\[[ xX]\]/.source, ''),
  anyLn: mkRx(/\n.*\n/.source, ''),
  hrefAngle: mkRx(/^<(.*)>$/.source, ''),
  tblDelim: mkRx(/[:|]/.source, ''),
  tblAlignEdge: mkRx(/^\||\| *$/g.source, 'g'),
  tblRowBlankTail: mkRx(/\n[ \t]*$/.source, ''),
  tblAlignR: mkRx(/^ *-+: *$/.source, ''),
  tblAlignC: mkRx(/^ *:-+: *$/.source, ''),
  tblAlignL: mkRx(/^ *:-+ *$/.source, ''),
  aOpen: mkRx(/^<a /i.source, 'i'),
  aClose: mkRx(/^<\/a>/i.source, 'i'),
  preOpen: mkRx(/^<(pre|code|kbd|script)(\s|>)/i.source, 'i'),
  preClose: mkRx(/^<\/(pre|code|kbd|script)(\s|>)/i.source, 'i'),
  angleOpen: mkRx(/^</.source, ''),
  angleClose: mkRx(/>$/.source, ''),
  uniAlnum: mkRx(/[\p{L}\p{N}]/u.source, 'u'),
  numRef: mkRx(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/.source, ''),
  numRefOrAmp: mkRx(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g.source, 'g'),
  escTest: mkRx(/[&<>"']/.source, ''),
  escRepl: mkRx(/[&<>"']/g.source, 'g'),
  escTestRaw: mkRx(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.source, ''),
  escReplRaw: mkRx(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g.source, 'g'),
  pctDecode: mkRx(/%25/g.source, 'g'),
  pipeFind: mkRx(/\|/g.source, 'g'),
  pipeSplit: mkRx(/ \|/.source, ''),
  pipeEsc: mkRx(/\\\|/g.source, 'g'),
  crLf: mkRx(/\r\n|\r/g.source, 'g'),
  wordStart: mkRx(/^\S*/.source, ''),
  trailNl: mkRx(/\n$/.source, ''),
  itemRx(bull) { return new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`); },
  // marked clamps the indent to 0..3 and caches the built patterns; same here.
  _cache: {},
  _build(n, key, mk) {
    const ci = Math.max(0, Math.min(3, n - 1));
    const k = key + ci;
    return this._cache[k] || (this._cache[k] = mk(ci));
  },
  bulletRx(n) { return this._build(n, 'b', (i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)); },
  hrRx(n) { return this._build(n, 'h', (i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)); },
  fenceRx(n) { return this._build(n, 'f', (i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)); },
  headRx(n) { return this._build(n, 'a', (i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)); },
  htmlRx(n) { return this._build(n, 'm', (i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')); },
  bqRx(n) { return this._build(n, 'q', (i) => new RegExp(`^ {0,${i}}>`)); },
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML: with encode, every & < > " ' is encoded; without it, an &
// that already begins a valid entity or numeric reference is left alone.
function escapeHtml(s, encode) {
  if (encode) {
    if (P.escTest.test(s)) return s.replace(P.escRepl, (c) => ESCAPES[c]);
  } else if (P.escTestRaw.test(s)) {
    return s.replace(P.escReplRaw, (c) => ESCAPES[c]);
  }
  return s;
}

// Decode numeric character references (&#65; &#x41;). A bare &, an invalid
// reference, or an out-of-range / surrogate code point becomes &amp; or
// U+FFFD, exactly as marked does.
function decodeRefs(s) {
  if (!P.numRef.test(s)) return s;
  return s.replace(P.numRefOrAmp, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// encodeURI, except %25 is decoded back to % (marked's cleanUrl).
function safeUrl(href) {
  try { return encodeURI(href).replace(P.pctDecode, '%'); } catch { return null; }
}

// Normalise a link label for reference lookup: trim, collapse whitespace,
// then fold case (lower, upper, lower again, as marked does).
function foldLabel(s) {
  return s.trim().replace(P.wsRunGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row into cells, honouring escaped pipes and edge pipes.
function splitRowCells(row, count) {
  const t = row.replace(P.pipeFind, (m, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(P.pipeSplit);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(P.pipeEsc, '|');
  return cells;
}

// Strip trailing characters: normally trailing `ch`; with invert, trailing
// characters that are NOT `ch` (marked's L()).
function trimTail(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let i = 0;
  while (i < n) {
    const c = s.charAt(n - i - 1);
    if (c === ch && !invert) i++;
    else if (c !== ch && invert) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Drop trailing blank lines, keeping at most the shape marked keeps.
function dropBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && P.blankLn.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Index of the closing paren matching the open depth of `a`
// (backslash-aware). -2 means an opener is left unbalanced, -1 none found.
function matchParen(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === pair[0]) depth++;
    else if (a[n] === pair[1] && (depth--, depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the visual column (marked's expandTabs).
// Iterates by code point, so astral characters count as one column each.
function expandTabStops(s, col = 0) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (c % 4);
      out += ' '.repeat(r);
      c += r;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Code-point length of s (what [...s].length counts), without allocating.
// Only a delimiter run plus one following character is ever measured here.
function cpCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++, n++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) i++;
    }
  }
  return n;
}

// UTF-16 width of the first code point of s: 2 for an astral character.
function firstCpWidth(s) {
  return s.charCodeAt(0) >= 0xD800 && s.charCodeAt(0) <= 0xDBFF && s.charCodeAt(1) >= 0xDC00 && s.charCodeAt(1) <= 0xDFFF ? 2 : 1;
}

// Last code point of s as a string ('' when s is empty).
function lastCodePoint(s) {
  if (!s) return '';
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xDC00 && last <= 0xDFFF && s.length >= 2) {
    const prev = s.charCodeAt(s.length - 2);
    if (prev >= 0xD800 && prev <= 0xDBFF) return s.slice(-2);
  }
  return s[s.length - 1];
}

// --- block grammar (GFM defaults) -------------------------------------------
// The big patterns are woven from the same small fragments marked weaves
// them from, so the woven sources match marked's exactly.

const HR_CORE = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const HR_ROW = ' {0,3}(?:' + HR_CORE + ')(?:\\n+|$)';
const ATX_ROW = ' {0,3}#{1,6}(?:\\s|$)';
const BQ_ROW = ' {0,3}>';
const FENCE_ROW = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_OPEN = ' {0,3}(?:<\\/?(?:' + TAG + ')(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const LIST_PARA_ROW = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const LIST_BQ_ROW = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';

const BLOCK = {
  blank: mkRx(/^(?:[ \t]*(?:\n|$))+/.source, ''),
  indented: mkRx(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/.source, ''),
  fenced: mkRx(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/.source, ''),
  atx: mkRx(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/.source, ''),
  rule: null, // woven below
  rawHtml: null, // woven below
  refDef: null, // woven below
  listOpen: mkRx(/^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/.source, ''),
  plain: mkRx(/^[^\n]+/.source, ''),
};
BLOCK.rule = mkRx('^ {0,3}(' + HR_CORE + ')(?:\n+|$)', '');
BLOCK.rawHtml = mkRx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(' + TAG + ')(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i');

// Link-reference label atom, shared by refDef / fullRef / shortRef.
const REF_LABEL = '(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const LINK_TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
BLOCK.refDef = mkRx('^ {0,3}\\[((?!\\s*\\])' + REF_LABEL + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + LINK_TITLE + '))? *(?:\\n+|$)', '');

// GFM table: a header line, a delimiter line, then body rows (each row must
// not start a block construct of its own).
BLOCK.table = mkRx(weave('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', {
  hr: mkRx('^ {0,3}(' + HR_CORE + ')(?:\n+|$)', ''),
  heading: ATX_ROW,
  blockquote: BQ_ROW,
  code: '(?: {4}| {0,3}\t)[^\\n]',
  fences: FENCE_ROW,
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  html: HTML_OPEN,
}), '');

// GFM paragraph: runs until a line that starts another block construct
// (including a table header + delimiter pair).
const PARA_PATTERN = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
BLOCK.para = mkRx(weave(PARA_PATTERN, {
  hr: mkRx('^ {0,3}(' + HR_CORE + ')(?:\n+|$)', ''),
  heading: ATX_ROW,
  '|lheading': '',
  table: BLOCK.table,
  blockquote: BQ_ROW,
  fences: FENCE_ROW,
  list: LIST_PARA_ROW,
  html: HTML_OPEN,
  tag: TAG,
}), '');

// GFM setext heading.
const SETEXT_PATTERN = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
BLOCK.setext = mkRx(weaveAll(SETEXT_PATTERN, {
  bull: ' {0,3}(?:[*+-]|\\d{1,9}[.)])',
  blockCode: '(?: {4}| {0,3}\\t)',
  fences: ' {0,3}(?:`{3,}|~{3,})',
  blockquote: BQ_ROW,
  heading: ATX_ROW,
  hr: HR_ROW,
  html: ' {0,3}<[^\\n>]+>\\n',
  table: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
}), '');

// The block-quote inner paragraph is the NON-GFM paragraph (no setext, no
// table, bullet list only): marked builds it that way, so its woven
// pattern differs from BLOCK.para.
const BQ_PARA_PATTERN = '^([^\\n]+(?:\\n(?!hr|heading|blockquote|fences|list|html|[ \\t]+\\n)[^\\n]+)*)';
const BQ_PARA_RX = mkRx(weave(BQ_PARA_PATTERN, {
  hr: mkRx('^ {0,3}(' + HR_CORE + ')(?:\n+|$)', ''),
  heading: ATX_ROW,
  blockquote: BQ_ROW,
  fences: FENCE_ROW,
  list: ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)',
  html: HTML_OPEN,
}), '');
BLOCK.quote = mkRx(weave('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+', {
  paragraph: BQ_PARA_RX,
}), '');

// --- inline grammar (GFM) — sources identical to marked 18.1.3 --------------
const INLINE = {
  backpedal: mkRx("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+"),
  punctEsc: mkRx("\\\\([\\p{P}\\p{S}])", "gu"),
  punctOutsideCode: mkRx("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", "gu"),
  auto: mkRx("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>"),
  skipBlock: mkRx("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g"),
  hardBr: mkRx("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*"),
  codeSpan: mkRx("^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)"),
  strike: mkRx("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)"),
  strikeOpen: mkRx("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u"),
  strikeClose: mkRx("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu"),
  emOpen: mkRx("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u"),
  emCloseAst: mkRx("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu"),
  emCloseUnd: mkRx("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu"),
  backslash: mkRx("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])"),
  inlineLink: mkRx("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)"),
  shortRef: mkRx("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?"),
  punct: mkRx("^((?![*_])[\\s\\p{P}\\p{S}])", "u"),
  fullRef: mkRx("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]"),
  refSearch: mkRx("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g"),
  htmlTag: mkRx("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>"),
  plainText: mkRx("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))"),
  bareUrl: mkRx("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])"),
};

// --- emphasis / strike closer hints -----------------------------------------
// A single scan of the masked source records, per delimiter, the last index
// a closer may start at; the emphasis and strike tokenizers narrow their
// closer search to that window instead of scanning the whole run.

function queueInline(src) {
  const tokens = [];
  pendingInline.push({ src, tokens });
  return tokens;
}

function scanHints(src) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i; else em[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, em, del };
}
function pushHintFrame(maskedSrc) { hintFrames.push(scanHints(maskedSrc)); }
function popHintFrame() { hintFrames.pop(); }
function hintEmClose(maskedSrc, delim) {
  const f = hintFrames[hintFrames.length - 1];
  if (f && f.maskedSrc === maskedSrc) return f.em[delim];
  return scanHints(maskedSrc).em[delim];
}
function hintDelClose(maskedSrc) {
  const f = hintFrames[hintFrames.length - 1];
  if (f && f.maskedSrc === maskedSrc) return f.del;
  return scanHints(maskedSrc).del;
}

// --- block tokenizers -------------------------------------------------------

function lexBlank(src) {
  const cap = BLOCK.blank.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}
function lexIndented(src) {
  const cap = BLOCK.indented.exec(src);
  if (cap) {
    const raw = dropBlankTail(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(P.stripCodeIndent, '') };
  }
}
function fixFenceIndent(raw, text) {
  const m = raw.match(P.fenceIndentFix);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(P.leadWs);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}
function lexFenced(src) {
  const cap = BLOCK.fenced.exec(src);
  if (cap) {
    return {
      type: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(INLINE.punctEsc, '$1') : cap[2],
      text: fixFenceIndent(cap[0], cap[3] || ''),
    };
  }
}
function lexAtx(src) {
  const cap = BLOCK.atx.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (P.trailHash.test(text)) {
      const trimmed = trimTail(text, '#');
      if (!trimmed || P.trailWsChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: trimTail(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(text) };
  }
}
function lexRule(src) {
  const cap = BLOCK.rule.exec(src);
  if (cap) return { type: 'hr', raw: trimTail(cap[0], '\n') };
}
function lexRawHtml(src) {
  const cap = BLOCK.rawHtml.exec(src);
  if (cap) {
    const raw = dropBlankTail(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}
function lexRefDef(src) {
  const cap = BLOCK.refDef.exec(src);
  if (cap) {
    if (!P.angleOpen.test(cap[2]) && matchParen(cap[2], '()') !== -1) return;
    const tag = foldLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(P.hrefAngle, '$1').replace(INLINE.punctEsc, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.punctEsc, '$1') : cap[3];
    return { type: 'def', tag, raw: trimTail(cap[0], '\n'), href, title };
  }
}
function lexTable(src) {
  const cap = BLOCK.table.exec(src);
  if (!cap) return;
  if (!P.tblDelim.test(cap[2])) return;
  const headers = splitRowCells(cap[1]);
  const aligns = cap[2].replace(P.tblAlignEdge, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(P.tblRowBlankTail, '').split('\n') : [];
  const item = { type: 'table', raw: trimTail(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (P.tblAlignR.test(align)) item.align.push('right');
    else if (P.tblAlignC.test(align)) item.align.push('center');
    else if (P.tblAlignL.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: queueInline(headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitRowCells(row, item.header.length).map((cell, i) => ({ text: cell, tokens: queueInline(cell), header: false, align: item.align[i] })));
  }
  return item;
}
function lexSetext(src) {
  const cap = BLOCK.setext.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: trimTail(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(text) };
  }
}
function lexPara(src) {
  const cap = BLOCK.para.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(text) };
  }
}
function lexPlain(src) {
  const cap = BLOCK.plain.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(cap[0]) };
}

function lexQuote(src) {
  const cap = BLOCK.quote.exec(src);
  if (cap) {
    let lines = trimTail(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (P.bqOpen.test(lines[i])) {
          currentLines.push(lines[i]);
          inQuote = true;
        } else if (!inQuote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(P.bqMarkerWs, (_, marker, whitespace) => marker + expandTabStops(whitespace, marker.length))
        .replace(P.bqSetextFix, '\n    $1')
        .replace(P.bqMarkerStrip, '');
      raw = raw ? raw + '\n' + currentRaw : currentRaw;
      text = text ? text + '\n' + currentText : currentText;
      // The quote's lines parse as top-level tokens; a paragraph that runs
      // on is merged with the previous one by the lexer below.
      const savedTop = atTop;
      atTop = true;
      lexBlocks(currentText, tokens, true);
      atTop = savedTop;
      if (lines.length === 0) break;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr' || lastToken.type === 'html' || lastToken.type === 'table')) {
        break;
      } else if (lastToken && lastToken.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(P.bqMarkerStrip, '');
        const newToken = lexQuote(newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && P.bqOpen.test(lines[0])) continue;
        break;
      } else if (lastToken && lastToken.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = lexList(newText);
        tokens[tokens.length - 1] = newToken;
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = raw + '\n' + consumed;
          text = text + '\n' + consumed;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
}

// First line of s, without allocating a split array.
function headLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}
// /\n[ \t]*\n[ \t]*$/ on a raw list item, without a regex.
function hasDoubleBlankTail(raw) {
  let i = raw.length - 1;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  if (i < 0 || raw[i] !== '\n') return false;
  i--;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  return i >= 0 && raw[i] === '\n';
}
// Do any of the list-item "begin" patterns match this line? All six begin
// patterns are ^ {0,ci} + one marker, so only the first non-space character
// (within the allowed indent) can start a match; dispatch on it.
// mask bits: 1 fences, 2 heading, 4 html, 8 blockquote, 16 bullet, 32 hr.
// The full loop tests all six; the lazy-continuation branch tests only
// fences/heading/html/hr (marked does not test blockquote or bullet there).
function lineOpensBlock(line, ci, f, mask) {
  let j = 0;
  while (j < line.length && line[j] === ' ') j++;
  if (j > ci) return false;
  const ch = line[j];
  if (ch === '`' || ch === '~') return !!(mask & 1) && f.fences.test(line);
  if (ch === '#') return !!(mask & 2) && f.heading.test(line);
  if (ch === '<') return !!(mask & 4) && f.html.test(line);
  if (ch === '>') return !!(mask & 8) && f.blockquote.test(line);
  if (ch === '*' || ch === '-') return ((!!(mask & 16) && f.bullet.test(line)) || (!!(mask & 32) && f.hr.test(line)));
  if (ch === '+') return !!(mask & 16) && f.bullet.test(line);
  if (ch === '_') return !!(mask & 32) && f.hr.test(line);
  if (ch >= '0' && ch <= '9') return !!(mask & 16) && f.bullet.test(line);
  return false;
}

// Scan one list-item line for its first non-space character (a tab counts
// as one) and whether the line is blank (spaces/tabs only). One manual pass,
// no regex — the list tokenizer runs this on every line of every list item,
// so the scan stays allocation-light and reads in a single sweep.
function scanIndent(line) {
  let k = 0;
  let blank = true;
  while (k < line.length) {
    const ch = line[k];
    if (ch !== ' ' && ch !== '\t') { blank = false; break; }
    k++;
  }
  return { firstNonSpace: k, blank };
}

// Decide the lazy-continuation fate of a line indented less than the item
// indent: null ends the item here, otherwise the text to append — the line
// itself, or indented by four spaces when it is a setext underline of the
// previous line (so the underline stays part of the item instead of closing
// it). Mirrors marked's lazy-continuation rules for list items.
function lazyLine(line, nextLine, nextLineWithoutTabs, ci, beginFns) {
  if ((line.includes('\t') ? line.replace(P.tabGlobal, '    ') : line).search(P.nonSpace) >= 4) return null;
  if (lineOpensBlock(line, ci, beginFns, 39)) return null;
  const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && BLOCK.setext.test(line + '\n' + nextLine);
  return setextContinuation
    ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
    : nextLine;
}

function lexList(src) {
  let cap = BLOCK.listOpen.exec(src);
  if (cap) {
    const doc = src;
    const consumed = () => doc.length - src.length;
    let marker = cap[1].trim();
    const ordered = marker.length > 1;
    const out = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    marker = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRx = P.itemRx(marker);
    let trailingBlank = false;
    while (src) {
      let stopEarly = false;
      let body = '';
      if (!(cap = itemRx.exec(src))) break;
      if (BLOCK.rule.test(src)) break;
      const startAt = consumed();
      src = src.substring(cap[0].length);
      const first = headLine(cap[2]);
      const markerIndent = cap[1].length;
      let cur = first.replace(P.leadWsTab, (whitespace) => expandTabStops(whitespace, markerIndent));
      let following = headLine(src);
      let isBlank = !cur.trim();
      let depth = 0;
      if (isBlank) {
        depth = markerIndent + 1;
      } else {
        depth = cur.search(P.nonSpace);
        depth = depth > 4 ? 1 : depth;
        body = cur.slice(depth);
        depth += markerIndent;
      }
      if (isBlank && P.blankLn.test(following)) {
        src = src.substring(following.length + 1);
        stopEarly = true;
      }
      if (!stopEarly) {
        const ci = Math.max(0, Math.min(3, depth - 1));
        const beginRxs = {
          fences: P.fenceRx(depth),
          heading: P.headRx(depth),
          html: P.htmlRx(depth),
          blockquote: P.bqRx(depth),
          bullet: P.bulletRx(depth),
          hr: P.hrRx(depth),
        };
        while (src) {
          const rawLn = headLine(src);
          following = rawLn;
          // leadingSpaceTab only matches at position 0, so skip the replace
          // (and its callback) when the line starts with neither.
          const plainLn = (following[0] === ' ' || following[0] === '\t')
            ? following.replace(P.leadWsTab, (whitespace) => expandTabStops(whitespace))
            : following;
          if (lineOpensBlock(following, ci, beginRxs, 63)) break;
          // Indented enough (or blank): the line belongs to this item.
          const { firstNonSpace, blank } = scanIndent(plainLn);
          if (firstNonSpace >= depth || blank) {
            body += '\n' + plainLn.slice(depth);
          } else {
            // Under-indented: only a lazy continuation keeps the item open.
            if (isBlank) break;
            const lazy = lazyLine(cur, following, plainLn, ci, beginRxs);
            if (lazy === null) break;
            body += '\n' + lazy;
          }
          isBlank = !following.trim();
          src = src.substring(rawLn.length + 1);
          cur = plainLn.slice(depth);
        }
      }
      const itemRaw = doc.slice(startAt, consumed());
      if (!out.loose) {
        if (trailingBlank) {
          out.loose = true;
        } else if (hasDoubleBlankTail(itemRaw)) {
          trailingBlank = true;
        }
      }
      out.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: P.listTaskTest.test(body),
        loose: false,
        text: body,
        tokens: [],
      });
    }
    const tail = out.items[out.items.length - 1];
    if (tail) {
      tail.raw = tail.raw.trimEnd();
      tail.text = tail.text.trimEnd();
    } else {
      return;
    }
    out.raw = doc.slice(0, consumed()).trimEnd();
    // First pass: tokenize items and finalize list.loose from spacers
    for (let n = 0; n < out.items.length; n++) {
      const item = out.items[n];
      atTop = false;
      item.tokens = lexBlocks(item.text, []);
      if (!out.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const multiBreak = spacers.length > 0 && spacers.some((t) => P.anyLn.test(t.raw));
        out.loose = multiBreak;
      }
    }
    // Second pass: place task checkboxes using the final list.loose
    for (let n = 0; n < out.items.length; n++) {
      const item = out.items[n];
      const head = item.tokens[0];
      if (item.task && (head && (head.type === 'text' || head.type === 'paragraph'))) {
        item.text = item.text.replace(P.listTaskStrip, '');
        head.raw = head.raw.replace(P.listTaskStrip, '');
        head.text = head.text.replace(P.listTaskStrip, '');
        for (let i = pendingInline.length - 1; i >= 0; i--) {
          if (P.listTaskTest.test(pendingInline[i].src)) {
            pendingInline[i].src = pendingInline[i].src.replace(P.listTaskStrip, '');
            break;
          }
        }
        const boxMatch = P.taskBox.exec(item.raw);
        if (boxMatch) {
          const box = {
            type: 'checkbox',
            raw: boxMatch[0] + ' ',
            checked: boxMatch[0] !== '[ ]',
          };
          item.checked = box.checked;
          if (out.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: box.raw,
                text: box.raw,
                tokens: [box],
              });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (out.loose) {
      for (const item of out.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }
    return out;
  }
}

// A setext underline is always preceded by a newline and starts with at
// most three spaces and = or -; a table's delimiter row is always the second
// line and holds a '-' plus a '|' or ':'. Both are necessary conditions, so
// they let the block loop skip two expensive patterns for ordinary paragraphs.
const SETEXT_GUARD = mkRx(/\n {0,3}[=-]/.source, '');
function looksLikeTable(src) {
  const i1 = src.indexOf('\n');
  if (i1 === -1) return false;
  let i2 = src.indexOf('\n', i1 + 1);
  if (i2 === -1) i2 = src.length;
  const row = src.slice(i1 + 1, i2);
  return row.includes('-') && (row.includes('|') || row.includes(':'));
}

// --- block lexer ------------------------------------------------------------
// Steps are tried in marked's order; the first whose pattern matches wins,
// and its place() decides whether the token stands alone or is absorbed into
// the previous paragraph/text token (blank lines, indented code and link
// definitions merge; a clipped paragraph merges too).

const BLOCK_STEPS = [
  {
    lex: lexBlank,
    place(tokens, tok) {
      const last = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
    },
  },
  {
    lex: lexIndented,
    place(tokens, tok) {
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        pendingInline[pendingInline.length - 1].src = last.text;
      } else {
        tokens.push(tok);
      }
    },
  },
  { lex: lexFenced, place(tokens, tok) { tokens.push(tok); } },
  { lex: lexAtx, place(tokens, tok) { tokens.push(tok); } },
  { lex: lexRule, place(tokens, tok) { tokens.push(tok); } },
  { lex: lexQuote, place(tokens, tok) { tokens.push(tok); } },
  { lex: lexList, place(tokens, tok) { tokens.push(tok); } },
  { lex: lexRawHtml, place(tokens, tok) { tokens.push(tok); } },
  {
    lex: lexRefDef,
    place(tokens, tok) {
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        pendingInline[pendingInline.length - 1].src = last.text;
      } else {
        if (!refDefs[tok.tag]) refDefs[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
    },
  },
  {
    gate: looksLikeTable,
    lex: lexTable,
    place(tokens, tok) { tokens.push(tok); },
  },
  {
    gate: (src) => SETEXT_GUARD.test(src),
    lex: lexSetext,
    place(tokens, tok) { tokens.push(tok); },
  },
  {
    gate: () => atTop,
    lex: lexPara,
    place(tokens, tok, clip) {
      const last = tokens[tokens.length - 1];
      if (clip.value && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        pendingInline.pop();
        pendingInline[pendingInline.length - 1].src = last.text;
      } else {
        tokens.push(tok);
      }
      clip.value = false;
    },
  },
  {
    lex: lexPlain,
    place(tokens, tok) {
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        pendingInline.pop();
        pendingInline[pendingInline.length - 1].src = last.text;
      } else {
        tokens.push(tok);
      }
    },
  },
];

function lexBlocks(src, tokens, lastParagraphClipped) {
  tokens = tokens || [];
  const clip = { value: lastParagraphClipped || false };
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let placed = false;
    for (let s = 0; s < BLOCK_STEPS.length; s++) {
      const step = BLOCK_STEPS[s];
      if (step.gate && !step.gate(src)) continue;
      const tok = step.lex(src);
      if (!tok) continue;
      src = src.slice(tok.raw.length);
      step.place(tokens, tok, clip);
      placed = true;
      break;
    }
    if (!placed) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  atTop = true;
  return tokens;
}

// --- inline tokenizers ------------------------------------------------------

// Does a '<' inside this link label open a tag/autolink that swallows the
// label's closing bracket? Then the label is not a label at all.
function labelSwallowsToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE.codeSpan.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.htmlTag.exec(tokenSrc) || INLINE.auto.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function makeLink(cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(P.linkBracketUnesc, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = insideLink;
  const outerLinkEmitted = linkDone;
  const outerInRawBlock = insideRaw;
  insideLink = true;
  linkDone = false;
  const tokens = lexInline(text);
  const textHasLink = linkDone;
  linkDone = outerLinkEmitted;
  insideLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      insideRaw = outerInRawBlock;
      return undefined;
    }
    linkDone = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function lexBackslash(src) {
  const cap = INLINE.backslash.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}
function lexHtmlTag(src) {
  const cap = INLINE.htmlTag.exec(src);
  if (cap) {
    if (!insideLink && P.aOpen.test(cap[0])) insideLink = true;
    else if (insideLink && P.aClose.test(cap[0])) insideLink = false;
    if (!insideRaw && P.preOpen.test(cap[0])) insideRaw = true;
    else if (insideRaw && P.preClose.test(cap[0])) insideRaw = false;
    return { type: 'html', raw: cap[0], inLink: insideLink, inRawBlock: insideRaw, block: false, text: cap[0] };
  }
}
function lexInlineLink(src) {
  if (parenMayFollow === false) return undefined;
  const cap = INLINE.inlineLink.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelSwallowsToken(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (P.angleOpen.test(trimmedUrl)) {
      if (!P.angleClose.test(trimmedUrl)) return;
      const rtrimSlash = trimTail(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParenIndex = matchParen(cap[2], '()');
      if (lastParenIndex === -2) return;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    const unescaped = trimTail(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (P.angleOpen.test(href)) href = href.slice(1, -1);
    return makeLink(cap, {
      href: href ? href.replace(INLINE.punctEsc, '$1') : href,
      title: title ? title.replace(INLINE.punctEsc, '$1') : title,
    }, cap[0]);
  }
}
function lexRefLink(src) {
  let cap;
  if ((cap = INLINE.fullRef.exec(src)) || (cap = INLINE.shortRef.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelSwallowsToken(src, cap[1], labelStart)) return;
    const link = refDefs[foldLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return makeLink(cap, link, cap[0]);
  }
}

// Narrow a delimiter scan to the window that can still hold a closer: the
// closer must lie at or after the opener (windowStart), and the search runs
// over the masked source from the opener's end. Returns null when no closer
// can lie in the window, otherwise the sliced window plus the last index in
// it a closer may start at. Shared by lexEmphasis and lexStrike, which differ
// only in how they pick the closer and what they do with it.
function closerSlice(maskedSrc, src, lLength, lastPossible) {
  const windowStart = maskedSrc.length - src.length + lLength;
  if (lastPossible < windowStart) return null;
  return {
    window: maskedSrc.slice(-src.length + lLength),
    limit: lastPossible - windowStart,
  };
}

function lexEmphasis(src, maskedSrc, prevChar) {
  let match = INLINE.emOpen.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = lastCodePoint(maskedSrc.slice(Math.max(0, runStart - 2), runStart));
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punct.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punct.exec(prevChar);
  if (match[4] && prevChar.match(P.uniAlnum)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = cpCount(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? INLINE.emCloseAst : INLINE.emCloseUnd;
    const win = closerSlice(maskedSrc, src, lLength, hintEmClose(maskedSrc, delimChar));
    if (!win) return;
    maskedSrc = win.window;
    const lastPossibleIndexInWindow = win.limit;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length; // rDelim is always a run of * or _
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCpWidth(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: lexInline(text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: lexInline(text) };
    }
  }
}
function lexCodeSpan(src) {
  const cap = INLINE.codeSpan.exec(src);
  if (cap) {
    let text = cap[2].replace(P.nlGlobal, ' ');
    const hasNonSpaceChars = P.nonSpace.test(text);
    const hasSpaceCharsOnBothEnds = P.leadSpace.test(text) && P.trailSpace.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}
function lexHardBreak(src) {
  const cap = INLINE.hardBr.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}
function lexStrike(src, maskedSrc, prevChar) {
  let match = INLINE.strikeOpen.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE.punct.exec(prevChar)) {
    const lLength = cpCount(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = INLINE.strikeClose;
    const win = closerSlice(maskedSrc, src, lLength, hintDelClose(maskedSrc));
    if (!win) return;
    maskedSrc = win.window;
    const lastPossibleIndexInWindow = win.limit;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length; // rDelim is always a run of ~
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCpWidth(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: lexInline(text) };
    }
  }
}
function lexAutoLink(src) {
  const cap = INLINE.auto.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}
function lexBareUrl(src) {
  let cap;
  if ((cap = INLINE.bareUrl.exec(src))) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = INLINE.backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}
function lexPlainText(src) {
  const cap = INLINE.plainText.exec(src);
  if (cap) {
    const escaped = insideRaw;
    return { type: 'text', raw: cap[0], text: escaped ? cap[0] : decodeRefs(cap[0]), escaped };
  }
}

// --- inline lexer -----------------------------------------------------------

function hasLinkInside(text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(INLINE.skipBlock)) {
    if (INLINE.inlineLink.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INLINE.refSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(refDefs, foldLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && hasLinkInside(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskEmphasisSrc(src) {
  let maskedSrc = src;
  if (src.includes('[') && Object.keys(refDefs).length > 0) {
    const refSearch = INLINE.refSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(refDefs, foldLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (hasLinkInside(text)) {
          return '[' + text.replace(refSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    if (maskedSrc.includes(']')) maskedSrc = maskedSrc.replace(refSearch, maskReflink);
  }
  // punctOutsideCode can only match a backslash escape or a code span
  // (backticks); skipBlock only a link, code span or <...>.
  if (maskedSrc.includes('\\') || maskedSrc.includes('`')) maskedSrc = maskedSrc.replace(INLINE.punctOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) maskedSrc = maskedSrc.replace(INLINE.skipBlock, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return maskedSrc;
}

// A run with no inline trigger at all is one text token: no escape, tag, link,
// emphasis, code span, break, strikethrough, autolink or bare URL can start
// anywhere in it (a break needs two spaces before a newline; a bare URL needs
// ://, www., @, mailto: or xmpp:). The text pattern would match the whole run
// as a single text token, so do that directly and skip the tokenizer loop.
const PLAIN_RUN = mkRx(/[\\<[*_`~]|:\/\/|www\.|@|mailto:|xmpp:| {2,}\n/.source, '');
function lexInline(src, tokens) {
  tokens = tokens || [];
  if (src && !PLAIN_RUN.test(src)) {
    tokens.push({ type: 'text', raw: src, text: insideRaw ? src : decodeRefs(src), escaped: insideRaw });
    return tokens;
  }
  const savedParen = parenMayFollow;
  parenMayFollow = savedParen && src.includes(')');
  try {
    return lexInlineMasked(src, tokens);
  } finally {
    parenMayFollow = savedParen;
  }
}

function lexInlineMasked(src, tokens) {
  const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskEmphasisSrc(src) : src;
  pushHintFrame(maskedSrc);
  try {
    return scanInline(src, maskedSrc, tokens);
  } finally {
    popHintFrame();
  }
}

// Could a bare URL or email start here? A regex pre-test cost 9% of total
// time (its email alternative rescans the first word of every text chunk),
// so check by hand: scheme prefixes by first character, an email by scanning
// the first word for '@'. Returning true only means "try the url tokenizer";
// it still fails on an invalid destination and the text tokenizer takes over.
function looksLikeUrl(src) {
  const c = src[0];
  if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
    const s = src.slice(0, 8).toLowerCase();
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) return true;
  } else if (c === 'w' || c === 'W') {
    if (src.slice(0, 4).toLowerCase() === 'www.') return true;
  } else if (c === 'm' || c === 'M') {
    if (src.slice(0, 7).toLowerCase() === 'mailto:') return true;
  } else if (c === 'x' || c === 'X') {
    if (src.slice(0, 5).toLowerCase() === 'xmpp:') return true;
  }
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-') {
    for (let i = 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === '@') return true;
      if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '+' || ch === '-')) break;
    }
  }
  return false;
}

function scanInline(src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    // Dispatch on the first character: only the tokenizers that can start
    // with it are tried, in marked's order. A failed tokenizer falls through
    // to the text tokenizer below.
    const c0 = src[0];
    let token;
    switch (c0) {
      case '\\':
        if ((token = lexBackslash(src)) || (token = lexHardBreak(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
      case '<':
        if ((token = lexHtmlTag(src)) || (token = lexAutoLink(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
      case '[':
      case '!':
        if (c0 === '!' && src[1] !== '[') break;
        if ((token = lexInlineLink(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if ((token = lexRefLink(src))) {
          src = src.substring(token.raw.length);
          const lastToken = tokens[tokens.length - 1];
          if (token.type === 'text' && lastToken && lastToken.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
        break;
      case '*':
      case '_':
        if ((token = lexEmphasis(src, maskedSrc, prevChar))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
      case '`':
        if ((token = lexCodeSpan(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
      case '~':
        if ((token = lexStrike(src, maskedSrc, prevChar))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
      case ' ':
        if ((token = lexHardBreak(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
      default:
        if (!insideLink && looksLikeUrl(src) && (token = lexBareUrl(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        break;
    }
    if ((token = lexPlainText(src))) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && lastToken.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// --- renderer ---------------------------------------------------------------

function htmlCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function htmlCode(token) {
  const langString = (token.lang || '').match(P.wordStart)?.[0];
  const code = token.text ? token.text.replace(P.trailNl, '') + '\n' : '';
  if (!langString) return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + escapeHtml(code, true) + '</code></pre>\n';
}
function htmlCell(token) {
  const content = htmlInline(token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? '<' + type + ' align="' + token.align + '">' : '<' + type + '>';
  return tag + content + '</' + type + '>\n';
}
function htmlTable(token) {
  let cell = '';
  for (const h of token.header) cell += htmlCell(h);
  const header = '<tr>\n' + cell + '</tr>\n';
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += htmlCell(c);
    body += '<tr>\n' + cell + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}
function htmlList(token) {
  let body = '';
  for (const item of token.items) body += '<li>' + htmlBlocks(item.tokens) + '</li>\n';
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? ' start="' + token.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}
function htmlLink(token) {
  const parsedText = token.autolink ? escapeHtml(token.text, true) : htmlInline(token.tokens);
  const cleanHref = safeUrl(token.href);
  if (cleanHref === null) return parsedText;
  const href = escapeHtml(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}
function htmlImage(token) {
  let text = token.text;
  if (token.tokens) text = htmlInline(token.tokens, true);
  const cleanHref = safeUrl(token.href);
  if (cleanHref === null) return escapeHtml(text);
  let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(text) + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  out += '>';
  return out;
}
function htmlTextToken(token) {
  if (token.tokens) return htmlInline(token.tokens);
  return token.escaped ? token.text : escapeHtml(token.text);
}
function htmlInline(tokens, plain) {
  let out = '';
  for (const token of tokens) {
    const t = token.type;
    if (t === 'escape') out += plain ? token.text : escapeHtml(token.text);
    else if (t === 'html') out += token.text;
    else if (t === 'link') out += plain ? (token.tokens ? htmlInline(token.tokens, true) : token.text) : htmlLink(token);
    else if (t === 'image') out += plain ? (token.tokens ? htmlInline(token.tokens, true) : token.text) : htmlImage(token);
    else if (t === 'checkbox') out += plain ? token.raw : htmlCheckbox(token);
    else if (t === 'strong') out += plain ? (token.tokens ? htmlInline(token.tokens, true) : token.text) : '<strong>' + htmlInline(token.tokens) + '</strong>';
    else if (t === 'em') out += plain ? (token.tokens ? htmlInline(token.tokens, true) : token.text) : '<em>' + htmlInline(token.tokens) + '</em>';
    else if (t === 'codespan') out += plain ? token.text : '<code>' + escapeHtml(token.text, true) + '</code>';
    else if (t === 'br') out += plain ? '' : '<br>';
    else if (t === 'del') out += plain ? (token.tokens ? htmlInline(token.tokens, true) : token.text) : '<del>' + htmlInline(token.tokens) + '</del>';
    else if (t === 'text') out += plain ? token.text : htmlTextToken(token);
    else throw new Error('Token with "' + token.type + '" type was not found.');
  }
  return out;
}
function htmlBlocks(tokens) {
  let out = '';
  for (const token of tokens) {
    const t = token.type;
    if (t === 'space') continue;
    else if (t === 'hr') out += '<hr>\n';
    else if (t === 'heading') out += '<h' + token.depth + '>' + htmlInline(token.tokens) + '</h' + token.depth + '>\n';
    else if (t === 'code') out += htmlCode(token);
    else if (t === 'table') out += htmlTable(token);
    else if (t === 'blockquote') out += '<blockquote>\n' + htmlBlocks(token.tokens) + '</blockquote>\n';
    else if (t === 'list') out += htmlList(token);
    else if (t === 'checkbox') out += htmlCheckbox(token);
    else if (t === 'html') out += token.text;
    else if (t === 'def') continue;
    else if (t === 'paragraph') out += '<p>' + htmlInline(token.tokens) + '</p>\n';
    else if (t === 'text') out += htmlTextToken(token);
    else throw new Error('Token with "' + token.type + '" type was not found.');
  }
  return out;
}

// --- entry point ------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  refDefs = Object.create(null);
  pendingInline = [];
  atTop = true;
  insideLink = false;
  insideRaw = false;
  linkDone = false;
  parenMayFollow = true;
  hintFrames = [];
  const src = markdown.replace(P.crLf, '\n');
  const tokens = lexBlocks(src, []);
  for (let i = 0; i < pendingInline.length; i++) {
    insideRaw = false;
    lexInline(pendingInline[i].src, pendingInline[i].tokens);
  }
  pendingInline = [];
  return htmlBlocks(tokens);
}

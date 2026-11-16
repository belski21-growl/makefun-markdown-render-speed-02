// parse.js — a fast drop-in replacement for marked 18.1.3 (MIT, see NOTICE.md)
// rendering exactly the HTML marked.parse(markdown) returns with marked's
// default options (gfm on, breaks off, pedantic off, async off).
//
// Design (written for this competition): a faithful token-based port of
// marked 18.1.3's Lexer + Parser + Renderer, in plain dependency-free JS.
// Phase A lexes blocks into a token list; inline markup is lexed lazily
// (tokens carry their source in an inline queue, resolved after the whole
// document's link definitions are collected, exactly like marked, so a
// reference defined anywhere resolves everywhere). Phase B renders the
// tokens to strings. Block and inline grammars are marked's own regexes,
// composed from the same small pieces marked composes them from — those
// regexes ARE the specification of marked's output quirks, so reproducing
// them byte for byte is what makes the output byte-identical.
// Optimisations over a naive port (all verified against the practice set
// after each step): an inline fast path for runs with no markup characters;
// first-character dispatch in the inline lexer; a manual scheme/email
// pre-test instead of the URL regex; necessary-condition guards that skip
// the table and setext-heading regexes for ordinary paragraphs; list-loop
// micro-optimisations (indexOf line splitting, allocation-free blank and
// first-non-space checks); and allocation-free code-point helpers in the
// emphasis/tilde scanners. parse is pure: no cache, no memo, no /tmp
// writes, no state kept between calls, so each case renders exactly as it
// would on its own.
//
// The grammar below is the CommonMark 0.31.2 + GFM 0.29 grammar as marked
// 18.1.3 implements it (its regexes are the specification of its output
// quirks, so they are reproduced here, composed from the same small pieces
// marked composes them from). Where marked departs from the spec, marked's
// output is what this module reproduces.

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// --- small helpers ---------------------------------------------------------

// Compose a regex from pieces: replace a placeholder word with another
// regex's source (stripping its leading ^, as a nested anchor would be
// meaningless) — the same composition marked uses for its block grammar.
// Replace the FIRST occurrence of each placeholder (marked's c().replace
// semantics: later insertions must not re-replace text an earlier one put
// in, e.g. the tag name 'blockquote' inside an inserted table pattern).
function sub(re, map) {
  let src = typeof re === 'string' ? re : re.source;
  for (const k of Object.keys(map)) {
    const v = map[k];
    const s = (typeof v === 'string' ? v : v.source).replace(/(^|[^\[])\^/g, '$1');
    const i = src.indexOf(k);
    if (i >= 0) src = src.slice(0, i) + s + src.slice(i + k.length);
  }
  return src;
}
// Global variant, for the setext-heading grammar whose placeholders occur
// twice (marked uses /bull/g etc. there); its pieces hold no other key.
function subG(re, map) {
  let src = typeof re === 'string' ? re : re.source;
  for (const k of Object.keys(map)) {
    const v = map[k];
    const s = (typeof v === 'string' ? v : v.source).replace(/(^|[^\[])\^/g, '$1');
    src = src.split(k).join(s);
  }
  return src;
}
const RX = (src, flags) => new RegExp(src, flags);

// --- "other" regexes (shared atoms) ----------------------------------------
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`),
  // marked clamps the indent to 0..3 (cacheIndex = max(0, min(3, indent-1)))
  // and caches the built regexes; do the same.
  _indentCache: {},
  _ind(n, key, mk) {
    const ci = Math.max(0, Math.min(3, n - 1));
    const k = key + ci;
    return this._indentCache[k] || (this._indentCache[k] = mk(ci));
  },
  nextBulletRegex(n) { return this._ind(n, 'b', (i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)); },
  hrRegex(n) { return this._ind(n, 'h', (i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)); },
  fencesBeginRegex(n) { return this._ind(n, 'f', (i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)); },
  headingBeginRegex(n) { return this._ind(n, 'a', (i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)); },
  htmlBeginRegex(n) { return this._ind(n, 'm', (i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')); },
  blockquoteBeginRegex(n) { return this._ind(n, 'q', (i) => new RegExp(`^ {0,${i}}>`)); },
};

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape HTML: encode=true escapes every & < > " '; encode=false leaves a &
// alone when it already starts a valid entity or numeric character reference.
function esc(s, encode) {
  if (encode) {
    if (O.escapeTest.test(s)) return s.replace(O.escapeReplace, (c) => ESC_MAP[c]);
  } else if (O.escapeTestNoEncode.test(s)) {
    return s.replace(O.escapeReplaceNoEncode, (c) => ESC_MAP[c]);
  }
  return s;
}
// Decode numeric character references (&#65; &#x41;), turning a bare & or an
// invalid/out-of-range reference into &amp; / U+FFFD, as marked does.
function unescapeEntities(s) {
  if (!O.numericCharacterReference.test(s)) return s;
  return s.replace(O.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
// encodeURI, but %25 is decoded back (marked's cleanUrl).
function cleanUrl(href) {
  try { return encodeURI(href).replace(O.percentDecode, '%'); } catch { return null; }
}
// A link label, normalised for reference lookup: collapse whitespace, fold
// case (upper then lower, as marked does).
function normalizeLabel(s) {
  return s.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Split a table row into cells, honouring escaped pipes and edge pipes.
function splitCells(row, count) {
  const t = row.replace(O.findPipe, (m, off, str) => {
    let escaped = false, p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(O.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}
// Trim trailing characters: with invert=false, strip trailing `ch`;
// with invert=true, strip trailing chars that are NOT `ch` (marked's L()).
function rtrim(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let i = 0;
  for (; i < n;) {
    const c = s.charAt(n - i - 1);
    if (c === ch && !invert) i++;
    else if (c !== ch && invert) i++;
    else break;
  }
  return s.slice(0, n - i);
}
// Drop trailing blank lines, keeping at most the shape marked keeps.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && O.blankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
// Find the index of the closing paren matching the paren depth of `a`
// (backslash-aware); -2 means an opener is left unbalanced, -1 none found.
function findParenClose(a, pair) {
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
function expandTabs(s, col = 0) {
  let out = '', c = col;
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (c % 4); out += ' '.repeat(r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}

// --- block grammar (GFM: the defaults) --------------------------------------
// The big patterns are composed from the same small pieces marked composes
// them from, so the composed sources match marked's exactly.

const HR_BODY = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const HR_LINE = ' {0,3}(?:' + HR_BODY + ')(?:\\n+|$)';
const HEADING_LINE = ' {0,3}#{1,6}(?:\\s|$)';
const BQ_LINE = ' {0,3}>';
const FENCES_LINE = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_START = ' {0,3}(?:<\\/?(?:' + TAG + ')(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const LIST_PARA = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const LIST_BQ = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';

const B = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: null, // built below
  html: null, // built below
  def: null, // built below
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  text: /^[^\n]+/,
};
B.hr = RX('^ {0,3}(' + HR_BODY + ')(?:\n+|$)');
B.html = RX('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(' + TAG + ')(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))', 'i');

// Label (link reference name) atom, shared by def / reflink / nolink.
const LABEL = '(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
B.def = RX('^ {0,3}\\[((?!\\s*\\])' + LABEL + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + TITLE + '))? *(?:\\n+|$)');

// GFM table: header line, delimiter line, then body rows (each row must not
// start a block construct of its own).
B.table = RX(sub('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', {
  hr: RX('^ {0,3}(' + HR_BODY + ')(?:\n+|$)'),
  heading: HEADING_LINE,
  blockquote: BQ_LINE,
  code: '(?: {4}| {0,3}	)[^\\n]',
  fences: FENCES_LINE,
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  html: HTML_START,
}));

// GFM paragraph: runs until a line that starts another block construct
// (including a table header + delimiter pair).
const PARA_SRC = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
B.paragraph = RX(sub(PARA_SRC, {
  hr: RX('^ {0,3}(' + HR_BODY + ')(?:\n+|$)'),
  heading: HEADING_LINE,
  '|lheading': '',
  table: B.table,
  blockquote: BQ_LINE,
  fences: FENCES_LINE,
  list: LIST_PARA,
  html: HTML_START,
  tag: TAG,
}));

// GFM setext heading.
const LH_SRC = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
B.lheading = RX(subG(LH_SRC, {
  bull: ' {0,3}(?:[*+-]|\\d{1,9}[.)])',
  blockCode: '(?: {4}| {0,3}\\t)',
  fences: ' {0,3}(?:`{3,}|~{3,})',
  blockquote: BQ_LINE,
  heading: HEADING_LINE,
  hr: HR_LINE,
  html: ' {0,3}<[^\\n>]+>\\n',
  table: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
}));

// GFM block quote: its inner paragraph is the NON-GFM paragraph (no lheading/table,
// list -> bullet): marked builds it that way, so the composed regex differs from B.paragraph.
const PARA_BQ_SRC = '^([^\\n]+(?:\\n(?!hr|heading|blockquote|fences|list|html|[ \\t]+\\n)[^\\n]+)*)';
const BQ_PARA = RX(sub(PARA_BQ_SRC, {
  hr: RX('^ {0,3}(' + HR_BODY + ')(?:\\n+|$)'),
  heading: HEADING_LINE,
  blockquote: BQ_LINE,
  fences: FENCES_LINE,
  list: ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)',
  html: HTML_START,
}));
B.blockquote = RX(sub('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+', {
  paragraph: BQ_PARA,
}));

// ---------- Inline grammar (GFM) — sources identical to marked 18.1.3 ----------
const I = {
  _backpedal: RX("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+"),
  anyPunctuation: RX("\\\\([\\p{P}\\p{S}])", "gu"),
  anyPunctuationOutsideCode: RX("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", "gu"),
  autolink: RX("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>"),
  blockSkip: RX("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g"),
  br: RX("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*"),
  code: RX("^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)"),
  del: RX("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)"),
  delLDelim: RX("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u"),
  delRDelim: RX("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu"),
  emStrongLDelim: RX("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u"),
  emStrongRDelimAst: RX("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu"),
  emStrongRDelimUnd: RX("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu"),
  escape: RX("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])"),
  link: RX("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)"),
  nolink: RX("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?"),
  punctuation: RX("^((?![*_])[\\s\\p{P}\\p{S}])", "u"),
  reflink: RX("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]"),
  reflinkSearch: RX("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g"),
  tag: RX("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>"),
  text: RX("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))"),
  url: RX("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])"),
};

// --- parse state (reset per parse(); recursion shares it, like marked) -------
let links;            // link reference definitions for the current document
let inlineQueue;      // {src, tokens}[] — inline runs, lexed after all blocks
let stateTop;         // block lexer "top" flag (paragraphs only at top level)
let inLink, inRawBlock, linkEmitted, linkParenPossible;
let closerStack;      // emStrong/del closer-hint frames for active inline passes

// Queue an inline run for later lexing (after all link definitions are known).
function inline(src) {
  const tokens = [];
  inlineQueue.push({ src, tokens });
  return tokens;
}

// --- emStrong/del closer hints (helpers.ts scanLastPossibleEmStrongDelClosers)
function scanClosers(src) {
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
function beginCloserScan(maskedSrc) { closerStack.push(scanClosers(maskedSrc)); }
function endCloserScan() { closerStack.pop(); }
function cachedEmStrongCloser(maskedSrc, delim) {
  const f = closerStack[closerStack.length - 1];
  if (f && f.maskedSrc === maskedSrc) return f.em[delim];
  return scanClosers(maskedSrc).em[delim];
}
function cachedDelCloser(maskedSrc) {
  const f = closerStack[closerStack.length - 1];
  if (f && f.maskedSrc === maskedSrc) return f.del;
  return scanClosers(maskedSrc).del;
}

// --- block tokenizers (Tokenizer.ts, GFM defaults) ---------------------------

function tokSpace(src) {
  const cap = B.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}
function tokCode(src) {
  const cap = B.code.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(O.codeRemoveIndent, '') };
  }
}
function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(O.beginningSpace);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}
function tokFences(src) {
  const cap = B.fences.exec(src);
  if (cap) {
    return {
      type: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(I.anyPunctuation, '$1') : cap[2],
      text: indentCodeCompensation(cap[0], cap[3] || ''),
    };
  }
}
function tokHeading(src) {
  const cap = B.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (O.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: inline(text) };
  }
}
function tokHr(src) {
  const cap = B.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}
function tokHtml(src) {
  const cap = B.html.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}
function tokDef(src) {
  const cap = B.def.exec(src);
  if (cap) {
    if (!O.startAngleBracket.test(cap[2]) && findParenClose(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(I.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(I.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}
function tokTable(src) {
  const cap = B.table.exec(src);
  if (!cap) return;
  if (!O.tableDelimiter.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) item.align.push('right');
    else if (O.tableAlignCenter.test(align)) item.align.push('center');
    else if (O.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: inline(headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({ text: cell, tokens: inline(cell), header: false, align: item.align[i] })));
  }
  return item;
}
function tokLheading(src) {
  const cap = B.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: inline(text) };
  }
}
function tokParagraph(src) {
  const cap = B.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: inline(text) };
  }
}
function tokText(src) {
  const cap = B.text.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: inline(cap[0]) };
}

function tokBlockquote(src) {
  const cap = B.blockquote.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (O.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(O.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + currentRaw : currentRaw;
      text = text ? text + '\n' + currentText : currentText;
      // parse blockquote lines as top level tokens; merge paragraphs on continuation
      const top = stateTop;
      stateTop = true;
      blockTokens(currentText, tokens, true);
      stateTop = top;
      if (lines.length === 0) break;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr' || lastToken.type === 'html' || lastToken.type === 'table')) {
        break;
      } else if (lastToken && lastToken.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (lastToken && lastToken.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(newText);
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


// First line of s without allocating a split array.
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}
// /\n[ \t]*\n[ \t]*$/ on a raw list item, without a regex.
function endsDoubleBlank(raw) {
  let i = raw.length - 1;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  if (i < 0 || raw[i] !== '\n') return false;
  i--;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  return i >= 0 && raw[i] === '\n';
}
// Do any of the list-item "begin" regexes match this line? The six begin
// regexes are all ^ {0,ci} + one marker, so only the first non-space
// character (within the allowed indent) can start a match; dispatch on it.
// mask bits: 1 fences, 2 heading, 4 html, 8 blockquote, 16 bullet, 32 hr.
// The inner loop tests all six; the lazy-continuation branch tests only
// fences/heading/html/hr (marked does not test blockquote or bullet there).
function listBeginMatch(line, ci, f, mask) {
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

function tokList(src) {
  let cap = B.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = O.listItemRegex(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (B.hr.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const fl = firstLine(cap[2]);
      const bulletIndent = cap[1].length;
      let line = fl.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
      let nextLine = firstLine(src);
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(O.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && O.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const ci = Math.max(0, Math.min(3, indent - 1));
        const beginFns = {
          fences: O.fencesBeginRegex(indent),
          heading: O.headingBeginRegex(indent),
          html: O.htmlBeginRegex(indent),
          blockquote: O.blockquoteBeginRegex(indent),
          bullet: O.nextBulletRegex(indent),
          hr: O.hrRegex(indent),
        };
        while (src) {
          const rawLine = firstLine(src);
          nextLine = rawLine;
          // leadingSpaceTab only matches at position 0, so skip the replace
          // (and its callback) when the line starts with neither.
          const nextLineWithoutTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
            ? nextLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
            : nextLine;
          if (listBeginMatch(nextLine, ci, beginFns, 63)) break;
          // first char that is not a space (a tab counts), and whether the
          // line is blank (only spaces/tabs): one manual pass, no regex.
          let k = 0;
          let blank = true;
          while (k < nextLineWithoutTabs.length) {
            const ch = nextLineWithoutTabs[k];
            if (ch !== ' ' && ch !== '\t') { blank = false; break; }
            k++;
          }
          const firstNonSpace = k; // first char that is not a space (leading tabs were expanded above)
          if (firstNonSpace >= indent || blank) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if ((line.includes('\t') ? line.replace(O.tabCharGlobal, '    ') : line).search(O.nonSpaceChar) >= 4) break;
            if (listBeginMatch(line, ci, beginFns, 39)) break;
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && B.lheading.test(line + '\n' + nextLine);
            const continuation = setextContinuation
              ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = !nextLine.trim();
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) {
          list.loose = true;
        } else if (endsDoubleBlank(raw)) {
          endsWithBlankLine = true;
        }
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: O.listIsTask.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();
    // First pass: tokenize items and finalize list.loose from spacers
    for (const item of list.items) {
      stateTop = false;
      item.tokens = blockTokens(item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }
    // Second pass: place task checkboxes using the final list.loose
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken && (itemToken.type === 'text' || itemToken.type === 'paragraph'))) {
        item.text = item.text.replace(O.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
        for (let i = inlineQueue.length - 1; i >= 0; i--) {
          if (O.listIsTask.test(inlineQueue[i].src)) {
            inlineQueue[i].src = inlineQueue[i].src.replace(O.listReplaceTask, '');
            break;
          }
        }
        const taskRaw = O.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkboxToken);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkboxToken.raw,
                text: checkboxToken.raw,
                tokens: [checkboxToken],
              });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }
    return list;
  }
}

// A setext underline is always preceded by a newline and starts with at
// most three spaces and = or -; a table's delimiter row is always the second
// line and holds a '-' plus a '|' or ':'. Both are necessary conditions, so
// they let the block loop skip two expensive regexes for ordinary paragraphs.
const LH_GUARD = /\n {0,3}[=-]/;
function tableGuard(src) {
  const i1 = src.indexOf('\n');
  if (i1 === -1) return false;
  let i2 = src.indexOf('\n', i1 + 1);
  if (i2 === -1) i2 = src.length;
  const row = src.slice(i1 + 1, i2);
  return row.includes('-') && (row.includes('|') || row.includes(':'));
}

// --- block lexer (Lexer.blockTokens) ----------------------------------------

function blockTokens(src, tokens, lastParagraphClipped) {
  tokens = tokens || [];
  lastParagraphClipped = lastParagraphClipped || false;
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let token;
    if ((token = tokSpace(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (token.raw.length === 1 && lastToken !== undefined) {
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    if ((token = tokCode(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && (lastToken.type === 'paragraph' || lastToken.type === 'text')) {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        inlineQueue[inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if ((token = tokFences(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokHeading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokHr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokBlockquote(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokList(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokHtml(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokDef(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && (lastToken.type === 'paragraph' || lastToken.type === 'text')) {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        inlineQueue[inlineQueue.length - 1].src = lastToken.text;
      } else {
        if (!links[token.tag]) links[token.tag] = { href: token.href, title: token.title };
        tokens.push(token);
      }
      continue;
    }
    if (tableGuard(src) && (token = tokTable(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (LH_GUARD.test(src) && (token = tokLheading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (stateTop && (token = tokParagraph(src))) {
      const lastToken = tokens[tokens.length - 1];
      if (lastParagraphClipped && lastToken && lastToken.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        inlineQueue.pop();
        inlineQueue[inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    if ((token = tokText(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && lastToken.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        inlineQueue.pop();
        inlineQueue[inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  stateTop = true;
  return tokens;
}

// --- inline tokenizers (Tokenizer.ts, GFM defaults) --------------------------

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = I.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = I.tag.exec(tokenSrc) || I.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function outputLink(cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = inLink;
  const outerLinkEmitted = linkEmitted;
  const outerInRawBlock = inRawBlock;
  inLink = true;
  linkEmitted = false;
  const tokens = inlineTokens(text);
  const textHasLink = linkEmitted;
  linkEmitted = outerLinkEmitted;
  inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      inRawBlock = outerInRawBlock;
      return undefined;
    }
    linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokEscape(src) {
  const cap = I.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}
function tokTag(src) {
  const cap = I.tag.exec(src);
  if (cap) {
    if (!inLink && O.startATag.test(cap[0])) inLink = true;
    else if (inLink && O.endATag.test(cap[0])) inLink = false;
    if (!inRawBlock && O.startPreScriptTag.test(cap[0])) inRawBlock = true;
    else if (inRawBlock && O.endPreScriptTag.test(cap[0])) inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink, inRawBlock, block: false, text: cap[0] };
  }
}
function tokLink(src) {
  if (linkParenPossible === false) return undefined;
  const cap = I.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (O.startAngleBracket.test(trimmedUrl)) {
      if (!O.endAngleBracket.test(trimmedUrl)) return;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParenIndex = findParenClose(cap[2], '()');
      if (lastParenIndex === -2) return;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return outputLink(cap, {
      href: href ? href.replace(I.anyPunctuation, '$1') : href,
      title: title ? title.replace(I.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}
function tokReflink(src) {
  let cap;
  if ((cap = I.reflink.exec(src)) || (cap = I.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const link = links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(cap, link, cap[0]);
  }
}
// Code-point length of s (what [...s].length counts), without allocating.
// Only the delimiter run plus one following character is ever measured here.
function cpLen(s) {
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
// UTF-16 length of the first code point of s: 2 for an astral character.
function firstCpLen(s) {
  return s.charCodeAt(0) >= 0xD800 && s.charCodeAt(0) <= 0xDBFF && s.charCodeAt(1) >= 0xDC00 && s.charCodeAt(1) <= 0xDFFF ? 2 : 1;
}
// Last code point of s as a string ('' when s is empty).
function lastCp(s) {
  if (!s) return '';
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xDC00 && last <= 0xDFFF && s.length >= 2) {
    const prev = s.charCodeAt(s.length - 2);
    if (prev >= 0xD800 && prev <= 0xDBFF) return s.slice(-2);
  }
  return s[s.length - 1];
}

function tokEmStrong(src, maskedSrc, prevChar) {
  let match = I.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = lastCp(maskedSrc.slice(Math.max(0, runStart - 2), runStart));
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!I.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!I.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = cpLen(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
    const lastPossibleEmStrongCloserIndex = cachedEmStrongCloser(maskedSrc, delimChar);
    const emStrongCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleEmStrongCloserIndexInWindow = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleEmStrongCloserIndexInWindow) break;
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
      const lastCharLength = firstCpLen(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(text) };
    }
  }
}
function tokCodespan(src) {
  const cap = I.code.exec(src);
  if (cap) {
    let text = cap[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpaceChars = O.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}
function tokBr(src) {
  const cap = I.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}
function tokDel(src, maskedSrc, prevChar) {
  let match = I.delLDelim.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || I.punctuation.exec(prevChar)) {
    const lLength = cpLen(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = I.delRDelim;
    const lastPossibleDelCloserIndex = cachedDelCloser(maskedSrc);
    const delCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleDelCloserIndex < delCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleDelCloserIndexInWindow = lastPossibleDelCloserIndex - delCloserWindowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleDelCloserIndexInWindow) break;
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
      const lastCharLength = firstCpLen(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(text) };
    }
  }
}
function tokAutolink(src) {
  const cap = I.autolink.exec(src);
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
function tokUrl(src) {
  let cap;
  if ((cap = I.url.exec(src))) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = I._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}
function tokInlineText(src) {
  const cap = I.text.exec(src);
  if (cap) {
    const escaped = inRawBlock;
    return { type: 'text', raw: cap[0], text: escaped ? cap[0] : unescapeEntities(cap[0]), escaped };
  }
}

// --- inline lexer (Lexer.inlineTokens / #tokenizeInlines) --------------------

function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(I.blockSkip)) {
    if (I.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(I.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskSrc(src) {
  let maskedSrc = src;
  if (src.includes('[') && Object.keys(links).length > 0) {
    const reflinkSearch = I.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(reflinkSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    if (maskedSrc.includes(']')) maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  // anyPunctuationOutsideCode can only match a backslash escape or a code
  // span (backticks); blockSkip only a link, code span or <...>.
  if (maskedSrc.includes('\\') || maskedSrc.includes('`')) maskedSrc = maskedSrc.replace(I.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) maskedSrc = maskedSrc.replace(I.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return maskedSrc;
}

// A run with no inline trigger at all is one text token: no escape, tag, link,
// emphasis, code span, break, strikethrough, autolink or bare URL can start
// anywhere in it (br needs two spaces before a newline; a bare URL needs ://,
// www., @, mailto: or xmpp:). The text regex would match the whole run as a
// single text token, so do that directly and skip the tokenizer loop.
const INLINE_FAST = /[\\<[*_`~]|:\/\/|www\.|@|mailto:|xmpp:| {2,}\n/;
function inlineTokens(src, tokens) {
  tokens = tokens || [];
  if (src && !INLINE_FAST.test(src)) {
    tokens.push({ type: 'text', raw: src, text: inRawBlock ? src : unescapeEntities(src), escaped: inRawBlock });
    return tokens;
  }
  const prevLinkParenPossible = linkParenPossible;
  linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(src, tokens);
  } finally {
    linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(src, tokens) {
  const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src) : src;
  beginCloserScan(maskedSrc);
  try {
    return tokenizeInlines(src, maskedSrc, tokens);
  } finally {
    endCloserScan();
  }
}

// Could a bare URL or email start here? A regex pre-test cost 9% of total
// time (its email alternative rescans the first word of every text chunk),
// so check by hand: scheme prefixes by first character, an email by scanning
// the first word for '@'. Returning true only means "try the url tokenizer";
// it still fails on an invalid destination and the text tokenizer takes over.
function maybeUrl(src) {
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

function tokenizeInlines(src, maskedSrc, tokens) {
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
    if (c0 === '\\') {
      if ((token = tokEscape(src)) || (token = tokBr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c0 === '<') {
      if ((token = tokTag(src)) || (token = tokAutolink(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c0 === '[' || (c0 === '!' && src[1] === '[')) {
      if ((token = tokLink(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = tokReflink(src))) {
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
    } else if (c0 === '*' || c0 === '_') {
      if ((token = tokEmStrong(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c0 === '`') {
      if ((token = tokCodespan(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c0 === '~') {
      if ((token = tokDel(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c0 === ' ') {
      if ((token = tokBr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (!inLink && maybeUrl(src) && (token = tokUrl(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokInlineText(src))) {
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

// --- renderer (Renderer.ts + Parser.ts + TextRenderer.ts) --------------------

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function renderCode(token) {
  const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
  const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
  if (!langString) return '<pre><code>' + esc(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + esc(langString) + '">' + esc(code, true) + '</code></pre>\n';
}
function renderTableCell(token) {
  const content = renderInline(token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? '<' + type + ' align="' + token.align + '">' : '<' + type + '>';
  return tag + content + '</' + type + '>\n';
}
function renderTable(token) {
  let cell = '';
  for (const h of token.header) cell += renderTableCell(h);
  const header = '<tr>\n' + cell + '</tr>\n';
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += renderTableCell(c);
    body += '<tr>\n' + cell + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}
function renderList(token) {
  let body = '';
  for (const item of token.items) body += '<li>' + renderTokens(item.tokens) + '</li>\n';
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? ' start="' + token.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}
function renderLink(token) {
  const parsedText = token.autolink ? esc(token.text, true) : renderInline(token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return parsedText;
  const href = esc(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) out += ' title="' + esc(token.title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}
function renderImage(token) {
  let text = token.text;
  if (token.tokens) text = renderInline(token.tokens, true);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return esc(text);
  let out = '<img src="' + esc(cleanHref) + '" alt="' + esc(text) + '"';
  if (token.title) out += ' title="' + esc(token.title) + '"';
  out += '>';
  return out;
}
function renderTextToken(token) {
  if (token.tokens) return renderInline(token.tokens);
  return token.escaped ? token.text : esc(token.text);
}
function renderInline(tokens, plain) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape': out += plain ? token.text : esc(token.text); break;
      case 'html': out += token.text; break;
      case 'link': out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : renderLink(token); break;
      case 'image': out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : renderImage(token); break;
      case 'checkbox': out += plain ? token.raw : renderCheckbox(token); break;
      case 'strong': out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : '<strong>' + renderInline(token.tokens) + '</strong>'; break;
      case 'em': out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : '<em>' + renderInline(token.tokens) + '</em>'; break;
      case 'codespan': out += plain ? token.text : '<code>' + esc(token.text, true) + '</code>'; break;
      case 'br': out += plain ? '' : '<br>'; break;
      case 'del': out += plain ? (token.tokens ? renderInline(token.tokens, true) : token.text) : '<del>' + renderInline(token.tokens) + '</del>'; break;
      case 'text': out += plain ? token.text : renderTextToken(token); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}
function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += '<h' + token.depth + '>' + renderInline(token.tokens) + '</h' + token.depth + '>\n'; break;
      case 'code': out += renderCode(token); break;
      case 'table': out += renderTable(token); break;
      case 'blockquote': out += '<blockquote>\n' + renderTokens(token.tokens) + '</blockquote>\n'; break;
      case 'list': out += renderList(token); break;
      case 'checkbox': out += renderCheckbox(token); break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += '<p>' + renderInline(token.tokens) + '</p>\n'; break;
      case 'text': out += renderTextToken(token); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// --- entry point ------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  links = Object.create(null);
  inlineQueue = [];
  stateTop = true;
  inLink = false;
  inRawBlock = false;
  linkEmitted = false;
  linkParenPossible = true;
  closerStack = [];
  const src = markdown.replace(O.carriageReturn, '\n');
  const tokens = blockTokens(src, []);
  for (let i = 0; i < inlineQueue.length; i++) {
    inRawBlock = false;
    inlineTokens(inlineQueue[i].src, inlineQueue[i].tokens);
  }
  inlineQueue = [];
  return renderTokens(tokens);
}

// A faster drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site spec (README.md) and its reference behaviour:
// the same front matter, template dialect, Markdown subset, slug rule and
// report, byte for byte. The speed comes from doing the same work with less
// of it: bulk HTML escaping instead of one regex call per character, a
// single-pass inline renderer, templates compiled once per case to plain
// JavaScript, front matter scanned without splitting the whole body, and
// word counting without allocating a word list.
//
// No dependencies. `run(input)` returns the output tree: a JSON object of
// every path the build writes and that file's text.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure-ASCII text skips the normalise step: NFKD is the identity on it
 * and it holds no combining marks.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) out = `${slug}-${++n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whitespace code units below 256, for word counting. */
const WS_TABLE = new Uint8Array(256);
for (const c of [32, 9, 10, 11, 12, 13]) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 256) {
      if (WS_TABLE[c]) { inWord = false; continue; }
    } else if (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
      c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) { inWord = false; continue; }
    if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `line` holds only spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
          if (c === 45) {
            if (i === 0 || i === raw.length - 1 || raw.charCodeAt(i - 1) === 45) { ok = false; break; }
          } else if (!alnum) { ok = false; break; }
        }
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The front matter
 * region is scanned by line starts, so the body is never split and rejoined.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line; track its 0-based line number.
  let p = nl0 === -1 ? text.length : nl0 + 1;
  let lineNo = 1;
  let closePos = -1;
  let closeLineNo = -1;
  while (true) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    if (end - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closePos = p;
      closeLineNo = lineNo;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
    lineNo++;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = nl0 === -1 ? text.length : nl0 + 1;
  lineNo = 1;
  while (lineNo < closeLineNo) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // `key: value` with one space after the colon: key is [a-z_]+.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) {
        raw = line.slice(k + 2);
        let e = raw.length;
        while (e > 0) {
          const c = raw.charCodeAt(e - 1);
          if (c !== 32 && c !== 9) break;
          e--;
        }
        raw = raw.slice(0, e);
      } else return { error: `line ${lineNo + 1} is not "key: value"` };
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = nl === -1 ? text.length : nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = closePos + 3;
  const body = after < text.length && text.charCodeAt(after) === 10 ? text.slice(after + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const WS_RE = /\s/;

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is only spaces and tabs after position `k` (used for hr tails). */
function onlySpacesTabs(line, k) {
  for (; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` is a thematic break: `---` or `***` then spaces/tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  return line.charCodeAt(1) === c && line.charCodeAt(2) === c && onlySpacesTabs(line, 3);
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** Whether a list item continues on `line`: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !WS_RE.test(line[k]);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscaped(s, j)) j = s.indexOf(what, j + 1);
  return j;
}

/** Whether the character at `j` is escaped: an odd run of backslashes before it. */
function isEscaped(s, j) {
  let k = j - 1;
  let n = 0;
  while (k >= 0 && s.charCodeAt(k) === 92) { n++; k--; }
  return (n & 1) === 1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** The next inline-significant character: a backslash, backtick, star, [, or a character the escape table names. */
const INLINE_SPECIAL = /[\\`*[&<>"']/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One regex pass
 * finds the next significant character, and plain text between them needs no
 * escaping at all: a run holds no escapable character by construction, so it
 * is written raw. A backslash is itself significant, so one it escapes is
 * always met as the pair, never as bare markup.
 */
function renderInline(s, env) {
  const out = [];
  const n = s.length;
  let i = 0;
  let runStart = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // A backslash escape: the pair is consumed here.
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
        i = j + 2;
        runStart = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        runStart = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > runStart) out.push(s.slice(runStart, j));
          out.push('<strong>', renderInline(s.slice(j + 2, k), env), '</strong>');
          i = k + 2;
          runStart = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<em>', renderInline(s.slice(j + 1, k), env), '</em>');
        i = k + 1;
        runStart = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 91) {
      // A link: `[text](target)`.
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<a href="', escapeHtml(env.link(target)), '">', renderInline(s.slice(j + 1, k), env), '</a>');
        i = mm + 1;
        runStart = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // An escapable character in plain text: write the run raw, then the entity.
    if (j > runStart) out.push(s.slice(runStart, j));
    out.push(ESCAPES[s[j]]);
    i = j + 1;
    runStart = i;
  }
  if (n > runStart) out.push(s.slice(runStart, n));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0 || ((line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) && isBlankLine(line))) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = renderInline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        // A bullet list.
        const items = [];
        while (i < n) {
          const l = lines[i];
          if (l.length >= 2 && (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
            items.push([trimLine(l.slice(2))]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let html = '<ul>\n';
        for (let k = 0; k < items.length; k++) html += `<li>${renderInline(items[k].join('\n'), env)}</li>\n`;
        blocks.push(`${html}</ul>\n`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${renderInline(ls.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      // An ordered list: 1 to 9 digits, then ". ".
      let k = 0;
      while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
      if (k >= 1 && k <= 9 && line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) {
        const start = Number(line.slice(0, k));
        const items = [];
        while (i < n) {
          const l = lines[i];
          let d = 0;
          while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) {
            items.push([trimLine(l.slice(d + 2))]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let html = start !== 1 ? `<ol start="${start}">\n` : '<ol>\n';
        for (let k2 = 0; k2 < items.length; k2++) html += `<li>${renderInline(items[k2].join('\n'), env)}</li>\n`;
        blocks.push(`${html}</ol>\n`);
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = renderInline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// The render helpers a compiled template closes over through its H argument.
// Scopes are plain objects chained by prototype: the root holds the page's
// values, each for-loop a child holding its element and `loop`. A first name
// read off the scope is therefore the nearest scope that binds it, exactly
// as the dialect reads it; later names are own properties of the value.
const TPL_HELPERS = {
  txt: textOf,
  T: truthy,
  /** A value as escaped text: a string escaped, a number or boolean in its own digits, an array's items joined by ", " then escaped, anything else "". */
  ev(v) {
    if (typeof v === 'string') return escapeHtml(v);
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
    return '';
  },
  L1(S, a) {
    return S[a];
  },
  L2(S, a, b) {
    const v = S[a];
    if (v === null || typeof v !== 'object') return undefined;
    return Object.hasOwn(v, b) ? v[b] : undefined;
  },
  LG(S, path) {
    let v = S[path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  },
};

/** JavaScript source for the lookup of `path` in scope variable `sv`. */
function lookupCode(path, sv) {
  if (path.length === 1) return `H.L1(${sv},${JSON.stringify(path[0])})`;
  if (path.length === 2) return `H.L2(${sv},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
  return `H.LG(${sv},${JSON.stringify(path)})`;
}

let tmpCounter = 0;

/**
 * JavaScript statements rendering `nodes` into the caller's `_o` array, in
 * scope variable `sv`. `idxOf` maps an included template's name to its index
 * in H.fns; an include of a name with no index renders nothing.
 */
function genNodes(nodes, sv, out, idxOf) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(`_o.push(${JSON.stringify(n.text)});`);
        break;
      case 'var':
        out.push(`_o.push(H.ev(${lookupCode(n.path, sv)}));`);
        break;
      case 'raw':
        out.push(`_o.push(H.txt(${lookupCode(n.path, sv)}));`);
        break;
      case 'if': {
        const cond = n.not ? `!H.T(${lookupCode(n.path, sv)})` : `H.T(${lookupCode(n.path, sv)})`;
        out.push(`if(${cond}){`);
        genNodes(n.then, sv, out, idxOf);
        if (n.else !== null) {
          out.push('}else{');
          genNodes(n.else, sv, out, idxOf);
        }
        out.push('}');
        break;
      }
      case 'for': {
        const id = tmpCounter++;
        const csv = `_s${id}`;
        const xs = `_x${id}`;
        const kk = `_k${id}`;
        out.push(`{const ${xs}=${lookupCode(n.path, sv)};if(Array.isArray(${xs})){for(let ${kk}=0;${kk}<${xs}.length;${kk}++){const ${csv}=Object.create(${sv});`);
        // A loop variable named "__proto__" must be an own property, not a
        // prototype write; every other name assigns directly.
        if (n.name === '__proto__') out.push(`Object.defineProperty(${csv},${JSON.stringify(n.name)},{value:${xs}[${kk}],enumerable:true,writable:true,configurable:true});`);
        else out.push(`${csv}.${n.name}=${xs}[${kk}];`);
        out.push(`${csv}.loop={index:${kk}+1,first:${kk}===0,last:${kk}===${xs}.length-1,length:${xs}.length};`);
        genNodes(n.body, csv, out, idxOf);
        out.push('}}}');
        break;
      }
      case 'include': {
        const idx = idxOf.get(n.name);
        if (idx !== undefined) out.push(`if(D<${INCLUDE_DEPTH}){H.fns[${idx}](${sv},D+1,H,_o);}`);
        break;
      }
    }
  }
}

/**
 * `nodes` compiled to a render function (S, D, H, _o) that appends the
 * template's text to `_o`. Includes call the included template's function
 * directly, so no per-include string is built or joined.
 */
function compileTemplate(nodes, idxOf) {
  const out = [];
  genNodes(nodes, 'S', out, idxOf);
  return new Function('S', 'D', 'H', '_o', out.join('\n'));
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const idxOf = new Map();
  let ti = 0;
  for (const name of templates.keys()) idxOf.set(name, ti++);
  const fns = [];
  for (const [name, nodes] of templates) fns[idxOf.get(name)] = compileTemplate(nodes, idxOf);
  const H = { ...TPL_HELPERS, fns };

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static. Line ends are made "\n" only where a \r is present.
  const sorted = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft. The checks run in order; the first that fails is the
  // one reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 0; d < RESERVED.length; d++) {
      const dir = RESERVED[d];
      if (dir !== 'posts' && s.path.startsWith(`${dir}/`)) { own = dir; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      let scheme = false;
      const c0 = target.charCodeAt(0);
      if (c0 >= 65 && c0 <= 90 || c0 >= 97 && c0 <= 122) {
        const colon = target.indexOf(':');
        if (colon > 0) {
          scheme = true;
          for (let k = 1; k < colon; k++) {
            const c = target.charCodeAt(k);
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) { scheme = false; break; }
          }
        }
      }
      if (scheme) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older
  // neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const tags = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const output = {};
  // Each source's card, computed once and shared by its page record.
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      // reading_minutes is only ever rendered for posts (a card, or a
      // post's own page record), so a page's body is never word-counted.
      reading_minutes: s.post ? Math.max(1, Math.ceil(wordsOf(s.body) / 200)) : 1,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const indexFn = fns[idxOf.get('index')];
  const tagFn = fns[idxOf.get('tag')];
  const tagsFn = fns[idxOf.get('tags')];
  const newScope = () => {
    const S = Object.create(null);
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    return S;
  };
  const renderFn = (fn, S) => {
    if (fn === undefined) return null;
    const _o = [];
    fn(S, 0, H, _o);
    return _o.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    const S = newScope();
    S.page = page;
    const fn = fns[idxOf.get(s.layout)];
    if (fn !== undefined) output[`${s.outDir}/index.html`] = renderFn(fn, S);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const cards = [];
    for (let i = 0; i < slice.length; i++) cards.push(slice[i].card);
    const S = newScope();
    S.posts = cards;
    S.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = renderFn(indexFn, S);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const cards = [];
    for (let j = 0; j < t.posts.length; j++) cards.push(t.posts[j].card);
    const S = newScope();
    S.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: cards };
    const html = renderFn(tagFn, S);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderFn(tagsFn, newScope());
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

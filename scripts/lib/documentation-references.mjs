// Check explicit comparison language even when a product is absent from the configured list.
const comparisons = [
  /\b(?:inspired\s+by|(?:modelled|modeled|styled|patterned)\s+after|in\s+the\s+style\s+of|look[- ]and[- ]feel\s+of|exactly\s+like)\b/gi,
  /\b(?:[Ss]imilar\s+to|[Cc]omparable\s+to|[Aa]n\s+alternative\s+to|[Cc]lone\s+of|[Cc]opied\s+from|[Aa]s\s+seen\s+in|[Ll]ike)\s+[`*_\[]*[A-Z][\w.-]*\b/g,
  /\b[A-Z][\w.-]*[-‐‑–](?:style|like|inspired)\s+(?:UI|UX|interface|layout|navigation|dashboard|design|composer|sidebar|interaction|animation|experience)\b/g,
  /(?:에서|에게서)\s*영감을\s*(?:받|얻)|(?:처럼|와\s*유사한|과\s*유사한)\s*(?:보이|디자인|UI|UX|화면|인터페이스)/g,
];

export function documentationReferencePatterns(config = '') {
  const names = config.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const patterns = names.map(name => {
    const literal = name.split(/\s+/).map(word => RegExp.escape(word)).join('\\s+');
    return new RegExp(`(?<![a-z0-9])${literal}(?![a-z0-9])`, 'gi');
  });
  return [...comparisons, ...patterns];
}

export function documentationReferenceLines(text, patterns) {
  const lines = new Set();
  // Match across soft wraps within a paragraph and report the original line number.
  let lineNumber = 1;
  for (const paragraph of text.split(/(\r?\n[ \t]*\r?\n)/)) {
    for (const pattern of patterns) {
      for (const match of paragraph.matchAll(pattern)) {
        lines.add(lineNumber + paragraph.slice(0, match.index).split('\n').length - 1);
      }
    }
    lineNumber += paragraph.split('\n').length - 1;
  }
  return [...lines].sort((a, b) => a - b);
}

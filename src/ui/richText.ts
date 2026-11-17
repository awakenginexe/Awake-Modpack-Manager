/**
 * Project descriptions come from Modrinth (Markdown, often with HTML in it) and CurseForge (HTML), written by
 * anyone. They are never inserted as HTML: the text is parsed into an inert document and rebuilt from an
 * allowlist of plain formatting tags, https links and https images. Everything else is dropped or unwrapped.
 */

const KEEP = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'center', 'sub', 'sup', 'kbd']);
/** Removed together with everything inside them. */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'link', 'meta', 'base', 'template', 'noscript', 'video', 'audio', 'title', 'head']);
const web = (url: string | null) => (url && /^https:\/\/[^\s"'<>]+$/i.test(url.trim()) ? url.trim() : null);

function copy(from: Node, to: Node, doc: Document) {
  for (const node of Array.from(from.childNodes)) {
    if (node.nodeType === 3) { to.appendChild(doc.createTextNode(node.textContent ?? '')); continue; }
    if (node.nodeType !== 1) continue;
    const el = node as Element, tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) { copy(el, to, doc); continue; } // unknown wrapper (div, span, font): keep its text
    const out = doc.createElement(tag);
    if (tag === 'a') {
      const href = web(el.getAttribute('href'));
      if (!href) { copy(el, to, doc); continue; }
      out.setAttribute('href', href);
      out.setAttribute('rel', 'noreferrer noopener');
    } else if (tag === 'img') {
      const src = web(el.getAttribute('src'));
      if (!src) continue;
      out.setAttribute('src', src);
      out.setAttribute('alt', el.getAttribute('alt') ?? '');
      out.setAttribute('loading', 'lazy');
      out.setAttribute('referrerpolicy', 'no-referrer');
    }
    copy(el, out, doc);
    to.appendChild(out);
  }
}

const inline = (text: string) => text
  .replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`)
  .replace(/!\[([^\]\n]*)\]\(\s*([^)\s]+)[^)\n]*\)/g, '<img alt="$1" src="$2">')
  .replace(/\[([^\]\n]+)\]\(\s*([^)\s]+)[^)\n]*\)/g, '<a href="$2">$1</a>')
  .replace(/(^|[\s(>])(https:\/\/[^\s<)"]+)/g, '$1<a href="$2">$2</a>')
  .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
  .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

/** The common Markdown the sites use: headings, lists, quotes, rules, fenced code, emphasis, links, images. HTML passes through to the allowlist. */
export function markdownToHtml(source: string): string {
  const out: string[] = [];
  let paragraph: string[] = [], list: 'ul' | 'ol' | null = null, fence: string[] | null = null;
  const flush = () => { if (paragraph.length) out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`); paragraph = []; };
  const endList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (/^\s*(```|~~~)/.test(raw)) { out.push(`<pre><code>${fence.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`); fence = null; } else fence.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { flush(); endList(); fence = []; continue; }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const kind = item[1] ? 'ul' : 'ol';
      if (list !== kind) { endList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(item[3]!)}</li>`);
      continue;
    }
    endList();
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) { flush(); out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); }
    else if (/^\s*>/.test(line)) { flush(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); }
    else paragraph.push(line);
  }
  if (fence) out.push(`<pre><code>${fence.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`);
  flush(); endList();
  return out.join('\n');
}

/** A description as safe nodes for `doc`, ready to append. */
export function renderRich(source: string, format: 'markdown' | 'html', doc: Document = document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(format === 'markdown' ? markdownToHtml(source) : source, 'text/html');
  const fragment = doc.createDocumentFragment();
  copy(parsed.body, fragment, doc);
  return fragment;
}

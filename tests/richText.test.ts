import { describe, expect, it } from 'vitest';
import { renderRich } from '../src/ui/richText';

const html = (source: string, format: 'markdown' | 'html' = 'markdown') => {
  const host = document.createElement('div');
  host.appendChild(renderRich(source, format));
  return host.innerHTML.replace(/\n/g, '');
};

describe('project descriptions', () => {
  it('renders the usual Markdown', () => {
    const out = html('# Title\n\nSome **bold** and *soft* text with `code`.\n\n- one\n- two\n\n1. first\n\n![shot](https://cdn.modrinth.com/a.png)\n[site](https://example.com/x)\n\n```\n<b>raw</b>\n```');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>soft</em>');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol><li>first</li></ol>');
    expect(out).toContain('<img src="https://cdn.modrinth.com/a.png" alt="shot" loading="lazy" referrerpolicy="no-referrer">');
    expect(out).toContain('<a href="https://example.com/x" rel="noreferrer noopener">site</a>');
    expect(out).toContain('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>');
  });

  it('keeps plain formatting from HTML and nothing that can run or load', () => {
    const out = html('<div class="x" onclick="alert(1)"><p style="color:red">Hi <b>there</b></p><script>alert(1)</script><iframe src="https://evil"></iframe>'
      + '<img src="https://ok/a.png" onerror="alert(1)"><img src="http://plain/a.png"><img src="javascript:alert(1)">'
      + '<a href="javascript:alert(1)">bad</a><a href="https://ok/" onclick="x()">good</a><svg><script>1</script></svg><form><input></form></div>', 'html');
    expect(out).toBe('<p>Hi <b>there</b></p><img src="https://ok/a.png" alt="" loading="lazy" referrerpolicy="no-referrer">bad<a href="https://ok/" rel="noreferrer noopener">good</a>');
  });

  it('treats HTML inside Markdown the same way', () => {
    const out = html('<center><img src="https://ok/banner.png" width="900"></center>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(out).toContain('<center><img src="https://ok/banner.png" alt="" loading="lazy" referrerpolicy="no-referrer"></center>');
    expect(out).not.toMatch(/script|javascript|alert/);
  });
});

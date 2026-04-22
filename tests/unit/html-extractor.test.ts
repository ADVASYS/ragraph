import { describe, it, expect } from "vitest";
import { extractFromHtml, isSubstantial } from "../../electron/main/core/ingestion/web/HtmlExtractor";

describe("HtmlExtractor", () => {
  it("extracts readable article content to Markdown", () => {
    const html = `
      <html lang="en">
        <head><title>Readability Demo</title></head>
        <body>
          <nav>menu</nav>
          <article>
            <h1>My Article</h1>
            <p>${"This is a substantial paragraph that should be detected as article content. ".repeat(8)}</p>
            <p>Second paragraph with a <a href="/next">link</a>.</p>
          </article>
          <footer>copyright</footer>
        </body>
      </html>`;
    const ext = extractFromHtml(html, "https://example.com/post");
    expect(ext.title).toMatch(/Article|Readability/);
    expect(ext.markdown).toContain("My Article");
    expect(ext.markdown).toContain("substantial paragraph");
    expect(ext.lang).toBe("en");
    expect(ext.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(isSubstantial(ext)).toBe(true);
    expect(ext.links.some((l) => l.endsWith("/next"))).toBe(true);
  });

  it("produces a stable content hash for identical input", () => {
    const html = `<html><body><article><h1>t</h1><p>${"a".repeat(400)}</p></article></body></html>`;
    const a = extractFromHtml(html, "https://a.test/");
    const b = extractFromHtml(html, "https://a.test/");
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("falls back to body conversion for non-article pages", () => {
    const html = `
      <html>
        <body>
          <div class="main">
            <ul>
              <li>Short item</li>
              <li>${"Another item with enough text to push past the boilerplate threshold. ".repeat(4)}</li>
            </ul>
          </div>
        </body>
      </html>`;
    const ext = extractFromHtml(html, "https://example.org/list");
    expect(ext.markdown).toContain("Another item");
    expect(isSubstantial(ext)).toBe(true);
  });

  it("drops javascript:, mailto: and in-page fragments from links", () => {
    const html = `
      <html><body><article>${"<p>body body body body body body body body body body body body body body</p>".repeat(4)}
      <a href="javascript:alert('x')">x</a>
      <a href="mailto:a@b.c">m</a>
      <a href="#top">top</a>
      <a href="https://other.example/ok">ok</a>
      </article></body></html>`;
    const ext = extractFromHtml(html, "https://example.com/");
    const schemes = ext.links.map((l) => new URL(l).protocol);
    expect(schemes.every((s) => s === "http:" || s === "https:")).toBe(true);
    expect(ext.links.some((l) => l === "https://other.example/ok")).toBe(true);
  });

  it("treats near-empty pages as non-substantial", () => {
    const html = `<html><body><p>hi</p></body></html>`;
    const ext = extractFromHtml(html, "https://example.com/");
    expect(isSubstantial(ext)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isHtmlPath, isPdfBytes, isPdfPath } from "./filePreview";

const enc = (text: string) => new TextEncoder().encode(text);

describe("HTML and PDF routing (#35)", () => {
  it("knows HTML and PDF names, case and spaces included", () => {
    expect(isHtmlPath("/p/report.html")).toBe(true);
    expect(isHtmlPath("/p/Index.HTM")).toBe(true);
    expect(isHtmlPath("/p/my report.html")).toBe(true);
    expect(isHtmlPath("/p/-leading.html")).toBe(true);
    expect(isHtmlPath("/p/page.xhtml")).toBe(false);
    expect(isHtmlPath("/p/html")).toBe(false);
    expect(isPdfPath("/p/Paper.PDF")).toBe(true);
    expect(isPdfPath("/p/paper.pdf.txt")).toBe(false);
  });
});

describe("isPdfBytes", () => {
  it("accepts a PDF header, also after a little junk", () => {
    expect(isPdfBytes(enc("%PDF-1.7\n..."))).toBe(true);
    expect(isPdfBytes(enc("\r\n%PDF-1.4"))).toBe(true);
  });

  it("refuses markup saved as .pdf", () => {
    expect(isPdfBytes(enc("<html><script>alert(1)</script></html>"))).toBe(false);
    expect(isPdfBytes(enc("<p>hi</p>%PDF-1.7"))).toBe(false);
  });

  it("refuses empty, short and headerless files", () => {
    expect(isPdfBytes(new Uint8Array())).toBe(false);
    expect(isPdfBytes(enc("%PDF"))).toBe(false);
    expect(isPdfBytes(enc("x".repeat(2000) + "%PDF-1.7"))).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { readPublicLink } from "../src/public-link-reader.js";

const { lookup, request } = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:http", () => ({ request }));
vi.mock("node:https", () => ({ request }));

const startUrl = "http://public.example.org/start";
const signal = () => new AbortController().signal;
const answer = (body: string | Buffer, type: string, status = 200, headers = {}) => ({ body, type, status, headers });

function replies(...items: ReturnType<typeof answer>[]) {
  const responses = items.values();
  request.mockImplementation((_url, options, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const item = responses.next().value;
      if (!item) throw new Error("Unexpected network request");
      const response = Object.assign(Readable.from([Buffer.from(item.body)]), {
        statusCode: item.status,
        headers: { "content-type": item.type, ...item.headers },
      });
      queueMicrotask(() => onResponse(response));
    };
    expect(options.agent).toBe(false);
    return req;
  });
}

beforeEach(() => {
  request.mockReset();
  lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

it("reads an ordinary page by exact URL, preserving source after redirects and omitting page chrome", async () => {
  const final = "https://docs.example.org/article?ref=original";
  replies(answer("", "text/html", 301, { location: final }), answer(`
    <title>Public &amp; useful</title><nav>Navigation</nav>
    <main><article><h1>Start</h1><p>正文 &amp; body</p><script>ignore()</script>
      <p hidden>Hidden</p><p>Last paragraph</p></article></main><footer>Footer</footer>`,
    "text/html; charset=utf-8"));
  expect(await readPublicLink(startUrl, signal())).toEqual({
    ok: true, requestedUrl: startUrl, url: final, format: "html",
    title: "Public & useful", text: "Start\n正文 & body\nLast paragraph", truncated: false,
  });
  expect(lookup.mock.calls).toEqual([["public.example.org.", { all: true }], ["docs.example.org.", { all: true }]]);
  expect(request.mock.calls.map(call => call[0].href)).toEqual([startUrl, final]);
  const pinned = vi.fn();
  request.mock.calls[1]![1].lookup("docs.example.org", {}, pinned);
  expect(pinned).toHaveBeenCalledWith(null, "93.184.216.34", 4);
});

it.each([
  "file:///etc/hosts", "https://user:pass@some.company.org/", "https://some.company.org:8443/",
  "http://localhost/", "http://127.1/", "http://169.254.169.254/", "http://[::ffff:127.0.0.1]/",
  "http://[fe80::1]/", "http://router.local/",
])("rejects a disallowed URL before making a request: %s", async url => {
  expect(await readPublicLink(url, signal())).toMatchObject({ ok: false });
  expect(lookup).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("validates redirected DNS results again and stops when any result is private", async () => {
  lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }, { address: "100.64.1.4", family: 4 }]);
  replies(answer("", "text/html", 302, { location: "https://other.example.org/article" }));
  expect(await readPublicLink(startUrl, signal())).toMatchObject({ code: "LINK_NOT_PUBLIC" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("retains both ends of a long text document and reports missing or gated pages distinctly", async () => {
  replies(
    answer("First\n" + "x".repeat(40_000) + "\nLast", "text/markdown"),
    answer("", "text/html", 403),
    answer("<title>Sign in</title><form><input type='password'></form>", "text/html"),
    answer("", "text/html", 404),
    answer("<title>Web application</title><div id='root'></div><script>hydrate()</script>", "text/html"),
    answer("binary", "image/png"),
  );
  const text = await readPublicLink(startUrl, signal());
  expect(text).toMatchObject({ ok: true, format: "text", truncated: true, text: expect.stringMatching(/^First[\s\S]*Last$/) });
  expect(await readPublicLink(startUrl, signal())).toMatchObject({ code: "LINK_ACCESS_DENIED" });
  expect(await readPublicLink(startUrl, signal())).toMatchObject({ code: "LINK_ACCESS_DENIED" });
  expect(await readPublicLink(startUrl, signal())).toMatchObject({ code: "LINK_UNAVAILABLE" });
  expect(await readPublicLink(startUrl, signal())).toMatchObject({ code: "LINK_TEXT_UNAVAILABLE" });
  expect(await readPublicLink(startUrl, signal())).toMatchObject({ code: "LINK_UNSUPPORTED_FORMAT" });
});

it("honors cancellation even during DNS lookup", async () => {
  lookup.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const result = readPublicLink(startUrl, controller.signal);
  controller.abort();
  expect(await result).toMatchObject({ code: "LINK_CANCELLED" });
  expect(request).not.toHaveBeenCalled();
});

function samplePdf() {
  const body = "BT /F1 16 Tf 20 80 Td (Readable PDF paragraph) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const hasPdfReader = (() => {
  try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
})();

it.skipIf(!hasPdfReader)("extracts text from a real PDF response, including generic PDF downloads", async () => {
  replies(answer(samplePdf(), "application/octet-stream"));
  expect(await readPublicLink(startUrl, signal())).toMatchObject({
    ok: true, format: "pdf", text: "Readable PDF paragraph", truncated: false,
  });
});

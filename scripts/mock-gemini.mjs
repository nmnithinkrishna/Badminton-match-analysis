// Local stand-in for the Gemini Files API + generateContent, for dev and e2e tests.
// MOCK_429_TIMES=n makes the first n generateContent calls return 429.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT ?? 8790);
const report = readFileSync(new URL("./fixtures/report.json", import.meta.url), "utf8");
let fail429 = Number(process.env.MOCK_429_TIMES ?? 0);
const sessions = new Map(); // sessionId -> {size, mime, displayName}
const files = new Map(); // name -> file
let seq = 0;
const stats = { uploads: 0, generate: 0, deletes: 0, got429: 0 };

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "x-goog-upload-command,x-goog-upload-offset,content-type",
  "access-control-expose-headers": "x-goog-upload-status",
};
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...cors, ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => { n += c.length; if (chunks.length < 4) chunks.push(c); });
    req.on("end", () => resolve({ n, text: Buffer.concat(chunks).toString("utf8") }));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (url.pathname === "/stats") return send(res, 200, stats);

  if (req.method === "POST" && url.pathname === "/upload/v1beta/files") {
    if (!req.headers["x-goog-api-key"]) return send(res, 401, { error: "no key" });
    const { text } = await readBody(req);
    const id = `s${++seq}`;
    sessions.set(id, {
      size: Number(req.headers["x-goog-upload-header-content-length"]),
      mime: req.headers["x-goog-upload-header-content-type"],
      displayName: JSON.parse(text).file.display_name,
      origin: req.headers.origin, // like the real API: upload responses only get CORS for this origin
    });
    return send(res, 200, {}, { "x-goog-upload-url": `http://localhost:${PORT}/upload-session/${id}` });
  }
  if ((req.method === "POST" || req.method === "PUT") && url.pathname.startsWith("/upload-session/")) {
    const s = sessions.get(url.pathname.split("/").pop());
    const { n } = await readBody(req);
    if (!s) return send(res, 404, { error: "no session" });
    console.log("upload bytes", n); if (n !== s.size) return send(res, 400, { error: `size ${n} != ${s.size}` });
    stats.uploads++;
    const name = `files/mock${seq}${Date.now().toString(36)}`;
    const file = { name, displayName: s.displayName, uri: `http://localhost:${PORT}/v1beta/${name}`, mimeType: s.mime, sizeBytes: String(n), state: "PROCESSING", videoMetadata: { videoDuration: "60s" }, _t: Date.now() };
    files.set(name, file);
    const { "access-control-allow-origin": _, ...rest } = cors;
    res.writeHead(200, { "content-type": "application/json", ...rest, ...(s.origin ? { "access-control-allow-origin": s.origin } : {}) });
    return res.end(JSON.stringify({ file }));
  }
  if (url.pathname.startsWith("/v1beta/files/")) {
    if (!req.headers["x-goog-api-key"]) return send(res, 401, { error: "no key" });
    const name = url.pathname.slice("/v1beta/".length);
    const f = files.get(name);
    if (!f) return send(res, 404, { error: "not found" });
    if (req.method === "DELETE") { files.delete(name); stats.deletes++; return send(res, 200, {}); }
    if (Date.now() - f._t > 2000) f.state = "ACTIVE";
    const { _t, ...pub } = f;
    return send(res, 200, pub);
  }
  if (req.method === "POST" && /^\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname)) {
    await readBody(req);
    stats.generate++;
    if (fail429 > 0) { fail429--; stats.got429++; return send(res, 429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }); }
    return send(res, 200, {
      candidates: [{ content: { parts: [{ text: report }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 6100, candidatesTokenCount: 1200, thoughtsTokenCount: 300 },
    });
  }
  send(res, 404, { error: "unknown route" });
}).listen(PORT, () => console.log(`mock gemini on :${PORT}`));

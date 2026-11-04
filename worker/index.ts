import { Hono } from "hono";
import { CreateAnalysisBody, type AnalysisStatus, type AnalysisState } from "../shared/report";
import { GeminiError, getFile, startUpload, uploadBody, type GeminiConfig } from "./gemini";
import { log } from "./log";

export { AnalyseMatch } from "./workflow";

const app = new Hono<{ Bindings: Env }>();

const gemini = (env: Env): GeminiConfig => ({ apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL });
const ID_RE = /^[a-f0-9]{32}$/;

app.onError((err, c) => {
  console.error(JSON.stringify({ msg: "unhandled", error: err.message }));
  return c.json({ error: "Something went wrong" }, 500);
});

/** 1. Create an analysis and a Gemini upload session the browser can PUT to directly. */
app.post("/api/analyses", async (c) => {
  const env = c.env;
  if (env.PAUSED === "true") return c.json({ error: "New analyses are paused right now. Please try later." }, 503);

  const parsed = CreateAnalysisBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  const body = parsed.data;

  if (body.sizeBytes > Number(env.MAX_UPLOAD_MB) * 1024 * 1024) {
    return c.json({ error: `Video must be under ${env.MAX_UPLOAD_MB} MB` }, 413);
  }
  if (body.durationS > Number(env.MAX_DURATION_S)) {
    return c.json({ error: `Video must be under ${Math.round(Number(env.MAX_DURATION_S) / 60)} minutes` }, 413);
  }

  // Global daily cap protects the Gemini free quota (resets 00:00 Pacific; UTC day is close enough here).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM analyses WHERE created_at >= ?")
    .bind(dayStart.getTime())
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= Number(env.DAILY_CAP)) {
    return c.json({ error: "We've hit today's analysis limit. Please try again tomorrow." }, 429);
  }

  const id = crypto.randomUUID().replaceAll("-", "");
  const mimeType = body.mimeType === "video/quicktime" ? "video/mov" : body.mimeType;
  const uploadUrl = await startUpload(gemini(env), {
    sizeBytes: body.sizeBytes,
    mimeType,
    displayName: id,
    origin: c.req.header("Origin") ?? new URL(c.req.url).origin,
  });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO analyses (id, state, player_description, size_bytes, mime_type, duration_s, upload_url, created_at, updated_at)
     VALUES (?, 'CREATED', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.playerDescription, body.sizeBytes, mimeType, body.durationS, uploadUrl, now, now)
    .run();
  log(id, "analysis created", { sizeBytes: body.sizeBytes, durationS: body.durationS });
  return c.json({ id, uploadUrl });
});

/** 2b. Fallback: stream the video through the Worker when a direct browser upload isn't possible. */
app.put("/api/analyses/:id/upload", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Not found" }, 404);
  const row = await c.env.DB.prepare("SELECT upload_url, size_bytes, state FROM analyses WHERE id = ?")
    .bind(id)
    .first<{ upload_url: string | null; size_bytes: number; state: string }>();
  if (!row?.upload_url || row.state !== "CREATED") return c.json({ error: "Upload not available" }, 409);
  const len = Number(c.req.header("content-length"));
  if (!c.req.raw.body || len !== row.size_bytes) return c.json({ error: "Size mismatch" }, 400);

  const file = await uploadBody(row.upload_url, c.req.raw.body, row.size_bytes);
  return markUploaded(c.env, id, file.name);
});

/** 3. Browser reports the upload finished; verify it with Gemini and start the workflow. */
app.post("/api/analyses/:id/complete", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { fileName?: unknown } | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName : "";
  if (!/^files\/[a-z0-9-]{1,64}$/.test(fileName)) return c.json({ error: "Invalid file" }, 400);
  return markUploaded(c.env, id, fileName);
});

async function markUploaded(env: Env, id: string, fileName: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT size_bytes, state FROM analyses WHERE id = ?")
    .bind(id)
    .first<{ size_bytes: number; state: string }>();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if (row.state !== "CREATED") return Response.json({ ok: true }); // idempotent

  // Never trust the client: the file must be the one we created a session for, with the declared size.
  const file = await getFile(gemini(env), fileName).catch((e: unknown) => {
    if (e instanceof GeminiError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  });
  if (!file || file.displayName !== id || Number(file.sizeBytes) !== row.size_bytes) {
    return Response.json({ error: "Uploaded file does not match" }, { status: 400 });
  }

  const res = await env.DB.prepare(
    "UPDATE analyses SET state = 'UPLOADED', gemini_file = ?, upload_url = NULL, updated_at = ? WHERE id = ? AND state = 'CREATED'",
  )
    .bind(fileName, Date.now(), id)
    .run();
  if (res.meta.changes === 1) {
    // Instance id = analysis id, so a duplicate "complete" can never start a second job.
    await env.ANALYSE.create({ id, params: { analysisId: id } }).catch((e: Error) => {
      if (!/already exists/i.test(e.message)) throw e;
    });
    log(id, "workflow started");
  }
  return Response.json({ ok: true });
}

/** 4. Status polling. */
app.get("/api/analyses/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Not found" }, 404);
  const row = await c.env.DB.prepare("SELECT state, error, report_json FROM analyses WHERE id = ?")
    .bind(id)
    .first<{ state: AnalysisState; error: string | null; report_json: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const status: AnalysisStatus = {
    id,
    state: row.state,
    error: row.error,
    report: row.report_json ? (JSON.parse(row.report_json) as AnalysisStatus["report"]) : null,
  };
  c.header("Cache-Control", "no-store");
  return c.json(status);
});

app.get("/api/health", (c) => c.json({ ok: true, model: c.env.GEMINI_MODEL }));

export default app;

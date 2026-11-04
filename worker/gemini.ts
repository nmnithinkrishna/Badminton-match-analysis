// Minimal Gemini Developer API client (Files API + generateContent). No SDK: fewer bytes, less CPU.

export type GeminiConfig = { apiKey: string; baseUrl: string };

export type GeminiFile = {
  name: string; // "files/abc"
  displayName?: string;
  uri: string;
  mimeType: string;
  sizeBytes?: string;
  state: "STATE_UNSPECIFIED" | "PROCESSING" | "ACTIVE" | "FAILED";
  videoMetadata?: { videoDuration?: string };
};

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  // Read a little of the body for diagnostics; never log the API key or URLs.
  const text = (await res.text().catch(() => "")).slice(0, 300);
  throw new GeminiError(`${what} failed (${res.status}): ${text}`, res.status);
}

/** Starts a resumable upload session and returns the session upload URL. */
export async function startUpload(
  cfg: GeminiConfig,
  opts: { sizeBytes: number; mimeType: string; displayName: string; origin?: string },
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": cfg.apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(opts.sizeBytes),
      "X-Goog-Upload-Header-Content-Type": opts.mimeType,
      "Content-Type": "application/json",
      // Gemini only adds Access-Control-Allow-Origin to the upload response if the session was opened with the
      // browser's Origin. Without it the upload succeeds but the browser can't read the result (CORS error).
      ...(opts.origin ? { Origin: opts.origin } : {}),
    },
    body: JSON.stringify({ file: { display_name: opts.displayName } }),
  });
  await check(res, "start upload");
  const url = res.headers.get("x-goog-upload-url");
  if (!url) throw new GeminiError("start upload: missing upload URL", 502);
  return url;
}

/** Streams a body into an upload session in one request (used by the proxy fallback). */
export async function uploadBody(
  uploadUrl: string,
  body: ReadableStream,
  sizeBytes: number,
): Promise<GeminiFile> {
  // FixedLengthStream gives the outgoing request a Content-Length without buffering the video.
  const { readable, writable } = new FixedLengthStream(sizeBytes);
  const piping = body.pipeTo(writable);
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: readable,
  });
  await piping.catch(() => {});
  await check(res, "upload");
  const json = (await res.json()) as { file: GeminiFile };
  return json.file;
}

export async function getFile(cfg: GeminiConfig, name: string): Promise<GeminiFile> {
  const res = await fetch(`${cfg.baseUrl}/v1beta/${name}`, {
    headers: { "x-goog-api-key": cfg.apiKey },
  });
  await check(res, "get file");
  return (await res.json()) as GeminiFile;
}

export async function deleteFile(cfg: GeminiConfig, name: string): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/v1beta/${name}`, {
    method: "DELETE",
    headers: { "x-goog-api-key": cfg.apiKey },
  });
  if (res.status === 404) return; // already gone: fine
  await check(res, "delete file");
}

export type GenerateResult = { text: string; tokensIn: number; tokensOut: number; model: string };

export async function generateJson(
  cfg: GeminiConfig,
  opts: {
    model: string;
    file: GeminiFile;
    prompt: string;
    schema: Record<string, unknown>;
    mediaResolution: string;
  },
): Promise<GenerateResult> {
  const res = await fetch(`${cfg.baseUrl}/v1beta/models/${opts.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: opts.file.uri, mimeType: opts.file.mimeType } },
            { text: opts.prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: opts.schema,
        mediaResolution: opts.mediaResolution,
        temperature: 0.4,
      },
    }),
  });
  await check(res, "generateContent");
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    promptFeedback?: { blockReason?: string };
  };
  if (json.promptFeedback?.blockReason) {
    throw new GeminiError(`blocked: ${json.promptFeedback.blockReason}`, 400);
  }
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (!text) throw new GeminiError(`empty response (finishReason=${cand?.finishReason ?? "none"})`, 502);
  const u = json.usageMetadata ?? {};
  return {
    text,
    tokensIn: u.promptTokenCount ?? 0,
    tokensOut: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    model: opts.model,
  };
}

/** "123.5s" -> 123.5 */
export function parseDuration(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const n = Number.parseFloat(d.replace(/s$/, ""));
  return Number.isFinite(n) ? n : undefined;
}

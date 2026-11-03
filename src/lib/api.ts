import type { AnalysisStatus, CreateAnalysisBody } from "../../shared/report";

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export async function createAnalysis(body: CreateAnalysisBody) {
  const res = await fetch("/api/analyses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return json<{ id: string; uploadUrl: string }>(res);
}

export async function getStatus(id: string) {
  return json<AnalysisStatus>(await fetch(`/api/analyses/${id}`));
}

function xhr(
  method: string,
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (p: number) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => resolve({ status: x.status, body: x.responseText });
    x.onerror = () => reject(new Error("network"));
    x.send(file);
  });
}

/**
 * Uploads straight to Gemini using the one-time session URL from our API (the API key never
 * reaches the browser). Falls back to streaming through our Worker if the direct upload is refused.
 */
export async function uploadVideo(id: string, uploadUrl: string, file: File, onProgress: (p: number) => void) {
  try {
    const r = await xhr(
      "POST",
      uploadUrl,
      file,
      { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
      onProgress,
    );
    if (r.status >= 200 && r.status < 300) {
      const fileName = (JSON.parse(r.body) as { file?: { name?: string } }).file?.name;
      if (!fileName) throw new Error("Upload response missing file name");
      await json(
        await fetch(`/api/analyses/${id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName }),
        }),
      );
      return;
    }
    if (r.status !== 401 && r.status !== 403) throw new Error(`Upload failed (${r.status})`);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "network") throw e;
  }
  // Fallback through the Worker.
  onProgress(0);
  const r = await xhr("PUT", `/api/analyses/${id}/upload`, file, { "Content-Type": file.type }, onProgress);
  if (r.status < 200 || r.status >= 300) {
    const msg = (() => {
      try {
        return (JSON.parse(r.body) as { error?: string }).error;
      } catch {
        return undefined;
      }
    })();
    throw new Error(msg ?? `Upload failed (${r.status})`);
  }
}

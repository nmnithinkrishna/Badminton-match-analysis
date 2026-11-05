import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyse } from "../worker/analyse";
import { GeminiError } from "../worker/gemini";

const report = readFileSync(new URL("../scripts/fixtures/report.json", import.meta.url), "utf8");
const cfg = { baseUrl: "https://gemini.test", apiKey: "k" } as Parameters<typeof analyse>[0];
const opts = {
  file: { name: "files/x", uri: "https://gemini.test/v1beta/files/x", mimeType: "video/mp4" } as never,
  playerDescription: "blue shirt",
  models: ["primary", "backup"],
  mediaResolution: "MEDIA_RESOLUTION_LOW",
};
const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: report }] } }], usageMetadata: {} }));
const err = (status: number) => new Response(JSON.stringify({ error: { code: status } }), { status });

/** Fake Gemini: the primary model answers with `primaryStatus`, the backup succeeds. */
function stubGemini(primaryStatus: number) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const model = /models\/([^:]+):/.exec(url)![1];
    calls.push(model);
    return model === "primary" ? err(primaryStatus) : ok();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("model fallback", () => {
  it.each([429, 500, 503, 524])("uses the backup model when the primary returns %i", async (status) => {
    const calls = stubGemini(status);
    const out = await analyse(cfg, opts);
    expect(calls).toEqual(["primary", "backup"]);
    expect(out.model).toBe("backup");
    expect(out.partial).toBe(false);
  });

  it("does not switch models on a bad request (400)", async () => {
    const calls = stubGemini(400);
    await expect(analyse(cfg, opts)).rejects.toBeInstanceOf(GeminiError);
    expect(calls).toEqual(["primary"]);
  });
});

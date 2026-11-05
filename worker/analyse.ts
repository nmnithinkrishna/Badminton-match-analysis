import { ReportSchema, reportJsonSchema, type Report } from "../shared/report";
import { GeminiError, generateJson, type GeminiConfig, type GeminiFile } from "./gemini";
import { buildPrompt, PROMPT_VERSION } from "./prompts/v1";

export { PROMPT_VERSION };

export type AnalyseOutcome = {
  report: Report;
  partial: boolean;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

/**
 * One analysis attempt: call the model, validate, repair once if needed, salvage as a last resort.
 * Throws GeminiError (retryable for 429/5xx) so the Workflow step can back off and retry.
 */
export async function analyse(
  cfg: GeminiConfig,
  opts: {
    file: GeminiFile;
    playerDescription: string;
    models: string[]; // primary first, then fallbacks used on 429 / overload
    mediaResolution: string;
    language?: string;
  },
): Promise<AnalyseOutcome> {
  const basePrompt = buildPrompt({
    playerDescription: opts.playerDescription,
    language: opts.language ?? "English",
  });
  const schema = reportJsonSchema();

  const call = async (prompt: string) => {
    let last: unknown;
    for (const model of opts.models) {
      try {
        return await generateJson(cfg, { model, file: opts.file, prompt, schema, mediaResolution: opts.mediaResolution });
      } catch (e) {
        last = e;
        // Fall through to the next model when this one is out of quota (429) or overloaded / timing out (5xx).
        // A 4xx like 400 means our request is wrong, so another model won't help.
        if (!(e instanceof GeminiError && (e.status === 429 || e.status >= 500))) throw e;
      }
    }
    throw last;
  };

  let tokensIn = 0;
  let tokensOut = 0;
  let first = await call(basePrompt);
  tokensIn += first.tokensIn;
  tokensOut += first.tokensOut;

  let parsed = parseAndValidate(first.text);
  if (parsed.ok) return { report: parsed.report, partial: false, model: first.model, tokensIn, tokensOut };

  // One repair attempt with the validation error appended.
  const repairPrompt = `${basePrompt}\n\nYour previous answer did not match the required format:\n${parsed.error}\nReturn the full corrected JSON.`;
  const second = await call(repairPrompt);
  tokensIn += second.tokensIn;
  tokensOut += second.tokensOut;
  const reparsed = parseAndValidate(second.text);
  if (reparsed.ok) return { report: reparsed.report, partial: false, model: second.model, tokensIn, tokensOut };

  const raw = reparsed.raw ?? parsed.raw;
  return { report: salvage(raw), partial: true, model: second.model, tokensIn, tokensOut };
}

type Parsed =
  | { ok: true; report: Report }
  | { ok: false; error: string; raw: unknown };

export function parseAndValidate(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Response was not valid JSON.", raw: undefined };
  }
  const r = ReportSchema.safeParse(raw);
  if (r.success) return { ok: true, report: r.data };
  const error = r.error.issues
    .slice(0, 10)
    .map((i) => `- ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  return { ok: false, error, raw };
}

/** Keep every top-level field that validates on its own; replace the rest with safe empties. */
export function salvage(raw: unknown): Report {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const shape = ReportSchema.shape;
  const pick = <K extends keyof typeof shape>(k: K, fallback: Report[K]): Report[K] => {
    const r = shape[k].safeParse(obj[k]);
    return r.success ? (r.data as Report[K]) : fallback;
  };
  const takeawaysRaw = Array.isArray(obj.takeaways) ? obj.takeaways : [];
  const takeawayItem = shape.takeaways.element;
  const takeaways = takeawaysRaw
    .map((t) => takeawayItem.safeParse(t))
    .filter((r) => r.success)
    .map((r) => r.data)
    .slice(0, 3);
  return {
    schema_version: 1,
    summary: pick("summary", {
      headline: "Partial analysis",
      overall_note: "The AI could only produce part of the report for this video.",
    }),
    video_quality: pick("video_quality", { usable: false, note: "Could not assess." }),
    rallies: pick("rallies", []),
    moments: pick("moments", []),
    strengths: pick("strengths", []),
    weaknesses: pick("weaknesses", []),
    patterns: pick("patterns", []),
    takeaways: takeaways as Report["takeaways"],
    drills: pick("drills", []),
    limitations: [
      ...pick("limitations", []),
      "Parts of the AI output were incomplete, so this is a partial report.",
    ],
    confidence_overall: "low",
  };
}

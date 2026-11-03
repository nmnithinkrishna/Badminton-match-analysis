import { z } from "zod";
export { fmt, toSeconds } from "./time";

/** Timestamps in the video, as the model writes them: "M:SS", "MM:SS" or "H:MM:SS". */
export const Timestamp = z
  .string()
  .regex(/^\d{1,2}(:\d{2}){1,2}$/, "timestamp must look like MM:SS");

const Confidence = z.enum(["low", "medium", "high"]);

export const ReportSchema = z.object({
  schema_version: z.literal(1),
  summary: z.object({
    headline: z.string().describe("One encouraging sentence, max 12 words."),
    overall_note: z.string().describe("2-3 plain-language sentences about the match."),
  }),
  video_quality: z.object({
    usable: z.boolean().describe("false if the angle, light or length makes analysis unreliable."),
    note: z.string(),
  }),
  rallies: z
    .array(
      z.object({
        start: Timestamp,
        end: Timestamp,
        estimated_winner: z.enum(["me", "opponent", "unclear"]),
        note: z.string().describe("Short, what decided the rally."),
        confidence: Confidence,
      }),
    )
    .describe("Estimated rally boundaries in time order."),
  moments: z
    .array(
      z.object({
        time: Timestamp,
        kind: z.enum(["strength", "weakness", "tip"]),
        label: z.string().describe("On-screen caption, max 8 words."),
        detail: z.string().describe("One sentence explaining it."),
      }),
    )
    .describe("Key moments to caption on the video, 5-20 items, time order."),
  strengths: z.array(
    z.object({ title: z.string(), explanation: z.string(), evidence: z.array(Timestamp) }),
  ),
  weaknesses: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      severity: z.enum(["minor", "moderate", "major"]),
      evidence: z.array(Timestamp),
    }),
  ),
  patterns: z.array(
    z.object({ title: z.string(), explanation: z.string(), evidence: z.array(Timestamp) }),
  ),
  takeaways: z
    .array(z.object({ title: z.string(), explanation: z.string(), evidence: z.array(Timestamp) }))
    .length(3),
  drills: z.array(z.object({ name: z.string(), how_to: z.string(), why: z.string() })),
  limitations: z.array(z.string()),
  confidence_overall: Confidence,
});

export type Report = z.infer<typeof ReportSchema>;

/** JSON Schema sent to Gemini as `responseJsonSchema` (constrained decoding). */
export function reportJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(ReportSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export const AnalysisState = z.enum([
  "CREATED",
  "UPLOADED",
  "PROCESSING_VIDEO",
  "ANALYSING",
  "WAITING_QUOTA",
  "READY",
  "FAILED",
]);
export type AnalysisState = z.infer<typeof AnalysisState>;

export const CreateAnalysisBody = z.object({
  sizeBytes: z.number().int().positive(),
  mimeType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  durationS: z.number().positive(),
  playerDescription: z.string().trim().min(3).max(200),
  consent: z.literal(true),
});
export type CreateAnalysisBody = z.infer<typeof CreateAnalysisBody>;

export type AnalysisStatus = {
  id: string;
  state: AnalysisState;
  error: string | null;
  report: Report | null;
};

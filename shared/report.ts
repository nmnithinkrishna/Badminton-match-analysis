import { z } from "zod";
export { fmt, toSeconds } from "./time";

/** Timestamps in the video, as the model writes them: "M:SS", "MM:SS" or "H:MM:SS". */
export const Timestamp = z
  .string()
  .regex(/^\d{1,2}(:\d{2}){1,2}$/, "timestamp must look like MM:SS");

const Confidence = z.enum(["low", "medium", "high"]);
const Score = z.number().int().min(1).max(10);
const Pct = z.number().int().min(0).max(100);
const Side = z.enum(["me", "opponent"]);

export const SHOTS = ["clear", "smash", "drop", "net", "drive", "lift"] as const;
export const ZONES = ["front_left", "front_right", "mid_left", "mid_right", "back_left", "back_right"] as const;
export const RATINGS = ["speed", "footwork", "attack", "defence", "net_play", "consistency"] as const;
const ShotType = z.enum([...SHOTS, "serve", "block"]);
const Zone = z.enum(ZONES);

const PlayerProfile = z.object({
  look: z.string().describe("How to recognise this player on video, max 8 words."),
  ratings: z
    .object(Object.fromEntries(RATINGS.map((k) => [k, Score])) as Record<(typeof RATINGS)[number], typeof Score>)
    .describe("1-10, relative to a typical club player."),
  speed: z.object({
    level: z.enum(["slow", "moderate", "fast", "very_fast"]),
    est_top_speed_kmh: z.number().min(0).max(30).describe("Rough estimate of fastest movement across court."),
    note: z.string().describe("Max 12 words."),
  }),
  court_coverage: z
    .object(Object.fromEntries(ZONES.map((k) => [k, Pct])) as Record<(typeof ZONES)[number], typeof Pct>)
    .describe("Share of hitting positions per zone of their own half, percent, sums to ~100."),
  shot_mix: z
    .object(Object.fromEntries(SHOTS.map((k) => [k, Pct])) as Record<(typeof SHOTS)[number], typeof Pct>)
    .describe("Share of shots by type, percent, sums to ~100."),
  strengths: z.array(z.string().describe("Max 6 words.")).min(1).max(3),
  work_on: z.array(z.string().describe("Max 6 words.")).min(1).max(3),
});
export type PlayerProfile = z.infer<typeof PlayerProfile>;

export const ReportSchema = z.object({
  schema_version: z.literal(2),
  summary: z.object({
    headline: z.string().describe("Max 10 words, honest, about the match."),
    overall_note: z.string().describe("One sentence, max 25 words."),
  }),
  video_quality: z.object({
    usable: z.boolean().describe("false if the angle, light or length makes analysis unreliable."),
    note: z.string().describe("Max 15 words."),
  }),
  players: z.object({ me: PlayerProfile, opponent: PlayerProfile }),
  rallies: z
    .array(
      z.object({
        start: Timestamp,
        end: Timestamp,
        winner: z.enum(["me", "opponent", "unclear"]),
        shots: z.number().int().min(1).max(200).describe("Estimated number of shots in the rally."),
        ended_by: z.enum(["winner", "forced_error", "unforced_error", "unclear"]),
        final_shot: z.enum([...SHOTS, "serve", "block", "unknown"]),
        intensity: z
          .object({ me: Score, opponent: Score })
          .describe("How hard each player had to move in this rally, 1-10."),
        note: z.string().describe("Max 10 words."),
        confidence: Confidence,
      }),
    )
    .describe("Rallies in time order. Only rallies you can actually see."),
  moments: z
    .array(
      z.object({
        time: Timestamp,
        player: z.enum(["me", "opponent", "both"]),
        kind: z.enum(["strength", "weakness", "tip"]),
        shot: ShotType.optional(),
        zone: Zone.optional().describe("Where the player was on their own half."),
        speed: Score.optional().describe("How fast the player moved for this shot, 1-10."),
        label: z.string().describe("On-screen caption, max 6 words."),
        detail: z.string().describe("Max 12 words."),
      }),
    )
    .describe("Key moments for both players, 15-40 items, time order."),
  takeaways: z
    .array(
      z.object({
        title: z.string().describe("Max 6 words."),
        action: z.string().describe("One concrete instruction, max 15 words."),
        evidence: z.array(Timestamp).min(1).max(3),
      }),
    )
    .length(3),
  drills: z
    .array(z.object({ name: z.string(), how_to: z.string().describe("Max 20 words."), fixes: z.string().describe("Max 6 words.") }))
    .max(3),
  limitations: z.array(z.string()),
  confidence_overall: Confidence,
});

export type Report = z.infer<typeof ReportSchema>;
export type Rally = Report["rallies"][number];
export type Moment = Report["moments"][number];
export type SideKey = z.infer<typeof Side>;

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

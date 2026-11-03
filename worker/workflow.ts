import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { AnalysisState } from "../shared/report";
import { analyse, PROMPT_VERSION } from "./analyse";
import { deleteFile, GeminiError, getFile, parseDuration, type GeminiConfig } from "./gemini";
import { log } from "./log";

export type AnalyseParams = { analysisId: string };

const MAX_FILE_CHECKS = 20;

export class AnalyseMatch extends WorkflowEntrypoint<Env, AnalyseParams> {
  async run(event: WorkflowEvent<AnalyseParams>, step: WorkflowStep) {
    const id = event.payload.analysisId;
    const cfg: GeminiConfig = { apiKey: this.env.GEMINI_API_KEY, baseUrl: this.env.GEMINI_BASE_URL };
    const db = this.env.DB;

    const row = await step.do("load", async () => {
      const r = await db
        .prepare("SELECT gemini_file, player_description, state FROM analyses WHERE id = ?")
        .bind(id)
        .first<{ gemini_file: string | null; player_description: string; state: string }>();
      if (!r?.gemini_file) throw new NonRetryableError("analysis or file not found");
      return r;
    });
    if (row.state === "READY") return; // idempotent: a replayed instance does nothing
    const fileName = row.gemini_file!;

    const setState = (name: string, state: AnalysisState, extra?: { error?: string }) =>
      step.do(name, async () => {
        await db
          .prepare("UPDATE analyses SET state = ?, error = ?, updated_at = ? WHERE id = ?")
          .bind(state, extra?.error ?? null, Date.now(), id)
          .run();
      });

    try {
      await setState("state-processing", "PROCESSING_VIDEO");

      // 1. Wait until Gemini has processed the video. Sleeping costs no CPU.
      let active = false;
      for (let i = 0; i < MAX_FILE_CHECKS && !active; i++) {
        const f = await step.do(`check-file-${i}`, async () => {
          const file = await getFile(cfg, fileName);
          if (file.state === "FAILED") throw new NonRetryableError("Gemini could not process this video");
          return { state: file.state, duration: parseDuration(file.videoMetadata?.videoDuration) };
        });
        if (f.state === "ACTIVE") {
          active = true;
          const max = Number(this.env.MAX_DURATION_S);
          if (f.duration && f.duration > max) {
            throw new NonRetryableError(`Video is longer than ${Math.round(max / 60)} minutes`);
          }
        } else {
          await step.sleep(`wait-file-${i}`, `${Math.min(5 + i * 5, 60)} seconds`);
        }
      }
      if (!active) throw new NonRetryableError("Video processing timed out");

      await setState("state-analysing", "ANALYSING");

      // 2. Analyse. Retries with exponential backoff on 429/5xx; a 429 also flips the UI to "waiting".
      const outcome = await step.do(
        "analyse",
        { retries: { limit: 8, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => {
          const file = await getFile(cfg, fileName);
          try {
            return await analyse(cfg, {
              file,
              playerDescription: row.player_description,
              models: [this.env.GEMINI_MODEL, this.env.GEMINI_FALLBACK_MODEL].filter(Boolean),
              mediaResolution: this.env.MEDIA_RESOLUTION,
            });
          } catch (e) {
            if (e instanceof GeminiError && e.status === 429) {
              await db
                .prepare("UPDATE analyses SET state = 'WAITING_QUOTA', updated_at = ? WHERE id = ?")
                .bind(Date.now(), id)
                .run();
            }
            if (e instanceof GeminiError && !e.retryable) throw new NonRetryableError(e.message);
            throw e;
          }
        },
      );

      // 3. Save. Single UPDATE, safe to replay.
      await step.do("save", async () => {
        await db
          .prepare(
            `UPDATE analyses SET state = 'READY', error = NULL, report_json = ?, model = ?, prompt_version = ?,
             tokens_in = ?, tokens_out = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            JSON.stringify(outcome.report),
            outcome.model,
            PROMPT_VERSION,
            outcome.tokensIn,
            outcome.tokensOut,
            Date.now(),
            id,
          )
          .run();
        log(id, "report saved", { model: outcome.model, partial: outcome.partial, tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut });
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(id, "analysis failed", { error: message });
      await setState("state-failed", "FAILED", { error: friendlyError(message) });
    } finally {
      // 4. Always delete the video from Gemini.
      await step.do("cleanup", { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } }, async () => {
        await deleteFile(cfg, fileName);
        await db.prepare("UPDATE analyses SET gemini_file = NULL WHERE id = ?").bind(id).run();
      });
    }
  }
}

function friendlyError(message: string): string {
  if (/longer than|timed out|could not process/i.test(message)) return message;
  if (/blocked/i.test(message)) return "The AI declined to analyse this video.";
  return "Analysis failed. Please try again with a different video.";
}

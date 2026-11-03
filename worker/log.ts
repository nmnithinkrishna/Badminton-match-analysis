/** Structured log line with the job id. Never pass PII, URLs or keys here. */
export function log(jobId: string, msg: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ jobId, msg, ...data }));
}

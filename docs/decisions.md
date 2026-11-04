# Decisions

Facts checked against official docs on 2026-11-03.

1. **Core engine only.** One page: upload → analyse → annotated video + report. No accounts, payments or sharing yet.
2. **Video goes straight from the phone to Gemini**, not via R2. Gemini's upload endpoint allows browser CORS, so the
   Worker only opens a resumable session (API key stays server-side). Avoids the Workers Free limits that made
   R2→Gemini streaming risky (10 ms CPU, 50 subrequests/invocation) and means we never store raw video.
   Fallback: stream through the Worker in one request (FixedLengthStream, no buffering).
3. **Shrink on the device before upload** (mediabunny/WebCodecs, 480p/15 fps) for files >60 MB. Gemini samples
   1 frame/s, so quality is unaffected while upload size drops ~10× on mobile data.
4. **Annotated output video is rendered in the browser**, not on a server: $0, no GPU, no Worker CPU. Uses the
   same `drawOverlay` code as the live player overlay.
5. **Cloudflare Workflows instead of Queues + hand-rolled state machine.** Durable steps (replays skip finished
   steps), built-in exponential retries for 429/5xx, free sleeps while Gemini processes the file. Workflow instance
   id = analysis id, so duplicate "complete" calls can't start two jobs.
6. **D1 with plain SQL migrations** (one table). Drizzle can come back when the schema grows.
7. **`generateContent` (stable) rather than the beta Interactions API**, with `responseJsonSchema` generated from
   the Zod schema, validated again with Zod; one repair retry, then a salvaged low-confidence partial report.
8. **Model:** `gemini-3.8-flash`, fallback `gemini-3.5-flash-lite` on 429. Free-tier RPM/RPD are only shown in AI Studio.
9. **Media resolution LOW** (~100 tokens per second of video). A 10-min match ≈ 60k input tokens.

## Open items for the owner

- Gemini API terms require users to be 18+ and forbid apps likely to be used by under-18s. Consent text says 18+.
- Free-tier Gemini data may be used to improve Google products and seen by human reviewers. Move to a paid key
  before real users / first payment.

## Verified against the real API (2026-11-04)

- Key works; `gemini-3.8-flash` and `gemini-3.5-flash-lite` are both listed with `generateContent`.
- **Direct browser upload works without the API key**, tested from headless Chromium on another origin. The
  upload URL is a bearer capability (no `key=` in it). One catch: Gemini adds `Access-Control-Allow-Origin` to
  the final upload response **only if the resumable session was started with an `Origin` header**. Without it the
  bytes upload but the browser sees a CORS error and would fall back to the proxy for nothing. The Worker now forwards
  the browser's `Origin` when opening the session, and the mock copies this behaviour so e2e catches a regression.

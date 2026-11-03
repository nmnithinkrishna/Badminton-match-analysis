# CourtSense — core engine

Upload a badminton singles match video → Gemini analyses it → you get your video back with AI coaching
notes burned in, plus a short report (3 takeaways, strengths, weaknesses, drills, estimated rallies).

AI-estimated coaching feedback, not measured analytics.

## How it works

```
Browser                                   Worker (Hono, Cloudflare)              Gemini API
───────                                   ─────────────────────────              ──────────
1. pick video, shrink to 480p (>60 MB) ─► POST /api/analyses ──── start upload ─► resumable session
2. upload video directly ──────────────────────────────────────────────────────► Files API
3. POST /api/analyses/:id/complete ─────► verify file ─► start Workflow
                                          Workflow: wait ACTIVE ─► generateContent (JSON schema)
                                                    validate (Zod) ─► save to D1 ─► delete file
4. poll GET /api/analyses/:id ◄──────────
5. play video with live overlay; "Get annotated video" renders MP4 on the device (WebCodecs)
```

- The API key stays in the Worker. The browser only gets a one-time upload session URL.
- If the direct upload is refused, the browser falls back to `PUT /api/analyses/:id/upload` (streamed through the Worker, ≤100 MB).
- We never store the video. Gemini deletes files after 48 h; we delete it as soon as the report is saved or the job fails.
- 429/5xx from Gemini → automatic retries with exponential backoff, UI shows "in the queue". On 429 the fallback model is tried.

## Run locally (no API key needed)

```bash
pnpm install
cp .dev.vars.example .dev.vars          # mock mode by default
pnpm db:migrate:local
pnpm mock:gemini                        # terminal 1: fake Gemini on :8790
pnpm dev                                # terminal 2: http://localhost:5173
```

To use the real Gemini API locally, put your key in `.dev.vars` and remove the `GEMINI_BASE_URL` line.

## Tests

```bash
pnpm typecheck && pnpm test             # unit tests (schema, salvage, timeline)
pnpm smoke                              # API end-to-end against dev server + mock
node scripts/e2e.mjs                    # browser test at Pixel 7 viewport, incl. annotated export
MOCK_429_TIMES=3 pnpm mock:gemini       # then `pnpm smoke` to watch quota retries
```

`scripts/fixtures/sample.mp4` is generated: `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine -t 60 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest scripts/fixtures/sample.mp4`

## Deploy (Cloudflare free plan)

```bash
npx wrangler login                                   # or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 create courtsense                    # paste database_id into wrangler.jsonc
pnpm db:migrate:remote
npx wrangler secret put GEMINI_API_KEY
pnpm deploy
```

## Config (`wrangler.jsonc` vars)

| Var | Default | Meaning |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | primary model |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | used when the primary returns 429 |
| `MEDIA_RESOLUTION` | `MEDIA_RESOLUTION_LOW` | ~100 tokens/s of video; cheaper and fits free quota |
| `MAX_UPLOAD_MB` | `500` | per video |
| `MAX_DURATION_S` | `900` | 15 min |
| `DAILY_CAP` | `15` | analyses per UTC day (protects free Gemini quota) |
| `PAUSED` | `false` | kill switch for new analyses |
| `GEMINI_API_KEY` | secret | never exposed to the browser |

Prompt lives in `worker/prompts/v1.ts` (`PROMPT_VERSION` is stored on every job, with model and token counts).

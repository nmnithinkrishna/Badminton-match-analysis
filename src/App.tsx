import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisState, Report } from "../shared/report";
import { toSeconds } from "../shared/time";
import { createAnalysis, getStatus, uploadVideo } from "./lib/api";
import { BRAND, buildTimeline, drawOverlay, type Timeline } from "./lib/overlay";
// The video toolkit is large; load it only when needed.
const videoLib = () => import("./lib/video");

const ACCEPT = ["video/mp4", "video/quicktime", "video/webm"] as const;
type Mime = (typeof ACCEPT)[number];

type Phase =
  | { kind: "pick" }
  | { kind: "working"; step: string; progress?: number; state?: AnalysisState }
  | { kind: "result"; report: Report }
  | { kind: "error"; message: string };

const STEPS: { state: AnalysisState | "PREPARING" | "UPLOADING"; label: string }[] = [
  { state: "PREPARING", label: "Preparing video" },
  { state: "UPLOADING", label: "Uploading" },
  { state: "PROCESSING_VIDEO", label: "AI is watching the match" },
  { state: "ANALYSING", label: "Writing your coaching report" },
  { state: "READY", label: "Done" },
];

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [player, setPlayer] = useState("");
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [id, setId] = useState<string | null>(() => new URLSearchParams(location.search).get("id"));

  // Poll status whenever we have an analysis id and no result yet.
  useEffect(() => {
    if (!id || phase.kind === "result" || phase.kind === "error") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await getStatus(id);
        if (stop) return;
        if (s.state === "READY" && s.report) return setPhase({ kind: "result", report: s.report });
        if (s.state === "FAILED") return setPhase({ kind: "error", message: s.error ?? "Analysis failed" });
        if (s.state !== "CREATED") {
          setPhase({ kind: "working", step: s.state, state: s.state });
        }
      } catch (e) {
        if (stop) return;
        if (e instanceof Error && /not found/i.test(e.message)) {
          return setPhase({ kind: "error", message: "This analysis was not found." });
        }
      }
      timer = setTimeout(tick, 4000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, phase.kind]);

  async function start() {
    if (!file) return;
    try {
      if (!ACCEPT.includes(file.type as Mime)) throw new Error("Please choose an MP4, MOV or WebM video.");
      setPhase({ kind: "working", step: "PREPARING", progress: 0 });
      const { probeDuration, compressForUpload } = await videoLib();
      const durationS = await probeDuration(file);
      const upload = await compressForUpload(file, (p) =>
        setPhase({ kind: "working", step: "PREPARING", progress: p }),
      );
      const created = await createAnalysis({
        sizeBytes: upload.size,
        mimeType: (ACCEPT.includes(upload.type as Mime) ? upload.type : "video/mp4") as Mime,
        durationS,
        playerDescription: player,
        consent: true,
      });
      setPhase({ kind: "working", step: "UPLOADING", progress: 0 });
      await uploadVideo(created.id, created.uploadUrl, upload, (p) =>
        setPhase({ kind: "working", step: "UPLOADING", progress: p }),
      );
      history.replaceState(null, "", `?id=${created.id}`);
      setPhase({ kind: "working", step: "PROCESSING_VIDEO" });
      setId(created.id);
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  function reset() {
    history.replaceState(null, "", location.pathname);
    setId(null);
    setFile(null);
    setPhase({ kind: "pick" });
  }

  return (
    <main>
      <header className="top">
        <span className="logo">🏸 {BRAND}</span>
        {phase.kind !== "pick" && (
          <button className="link" onClick={reset}>
            New analysis
          </button>
        )}
      </header>

      {phase.kind === "pick" && (
        <section className="card">
          <h1>AI coaching from your match video</h1>
          <p className="muted">
            Upload a badminton singles match filmed from behind the court. You get your video back with AI coaching
            notes on it, plus a short report.
          </p>
          <label className="drop">
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span>
                <b>{file.name}</b> · {(file.size / 1024 / 1024).toFixed(0)} MB
              </span>
            ) : (
              <span>Tap to choose a match video (max 15 min)</span>
            )}
          </label>
          <label className="field">
            <span>Which player are you?</span>
            <input
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              placeholder="e.g. blue shirt, near side of the court"
              maxLength={200}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              I'm 18 or older and I agree that this video is sent to Google's Gemini AI for analysis. On the free tier
              Google may use it to improve its products, and human reviewers may see it. We delete the video right
              after analysis.
            </span>
          </label>
          <button className="primary" disabled={!file || player.trim().length < 3 || !consent} onClick={start}>
            Analyse my match
          </button>
        </section>
      )}

      {phase.kind === "working" && <Progress step={phase.step} progress={phase.progress} />}

      {phase.kind === "error" && (
        <section className="card">
          <h2>Something went wrong</h2>
          <p>{phase.message}</p>
          <button className="primary" onClick={reset}>
            Try again
          </button>
        </section>
      )}

      {phase.kind === "result" && <Result report={phase.report} file={file} onPickFile={setFile} />}
    </main>
  );
}

function Progress({ step, progress }: { step: string; progress?: number }) {
  const idx = STEPS.findIndex((s) => s.state === step);
  const current = step === "WAITING_QUOTA" ? 3 : Math.max(0, idx);
  return (
    <section className="card">
      <h2>Analysing your match</h2>
      <ol className="steps">
        {STEPS.slice(0, -1).map((s, i) => (
          <li key={s.state} className={i < current ? "done" : i === current ? "now" : ""}>
            {s.label}
            {i === current && progress !== undefined && progress > 0 && <span> · {Math.round(progress * 100)}%</span>}
          </li>
        ))}
      </ol>
      {step === "WAITING_QUOTA" && (
        <p className="note">You're in the queue: the AI is busy right now. We'll keep trying automatically.</p>
      )}
      {current >= 2 && <p className="muted">This takes a few minutes. You can close this page and come back to this link.</p>}
    </section>
  );
}

function Result({ report, file, onPickFile }: { report: Report; file: File | null; onPickFile: (f: File) => void }) {
  const tl = useMemo(() => (report.schema_version === 2 ? buildTimeline(report) : null), [report]);
  const videoRef = useRef<HTMLVideoElement>(null);
  if (!tl) {
    return (
      <section className="card">
        <h2>Older report</h2>
        <p className="muted">This analysis was made with an earlier version of {BRAND}. Run a new analysis to get the match view.</p>
      </section>
    );
  }
  const seek = (ts: string) => {
    const v = videoRef.current;
    const s = toSeconds(ts);
    if (v && Number.isFinite(s)) {
      v.currentTime = Math.max(0, s - 1);
      v.play().catch(() => {});
      v.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  const Ev = ({ list }: { list: string[] }) => (
    <span className="ev">
      {list.map((t) => (
        <button key={t} className="chip" onClick={() => seek(t)}>
          ▶ {t}
        </button>
      ))}
    </span>
  );
  const final = tl.rallies.at(-1)?.score ?? { me: 0, opponent: 0 };
  const shots = tl.rallies.map((r) => r.shots);
  const { me, opponent } = report.players;

  return (
    <>
      <section className="card hero">
        <p className="kicker">AI-estimated · confidence {report.confidence_overall}</p>
        <h1>{report.summary.headline}</h1>
        <div className="score" aria-label={`Estimated rallies won: you ${final.me}, opponent ${final.opponent}`}>
          <div className="side me">
            <span>You</span>
            <b>{final.me}</b>
          </div>
          <span className="dash">–</span>
          <div className="side opp">
            <b>{final.opponent}</b>
            <span>Opponent</span>
          </div>
        </div>
        <div className="stats">
          <div><b>{tl.rallies.length}</b><span>rallies</span></div>
          <div><b>{shots.length ? Math.round(shots.reduce((a, b) => a + b, 0) / shots.length) : "–"}</b><span>avg shots</span></div>
          <div><b>{shots.length ? Math.max(...shots) : "–"}</b><span>longest</span></div>
          <div><b>~{Math.round(me.speed.est_top_speed_kmh)}</b><span>your km/h</span></div>
        </div>
        {!report.video_quality.usable && <p className="note">⚠️ {report.video_quality.note}</p>}
      </section>

      {file ? (
        <AnnotatedPlayer file={file} tl={tl} videoRef={videoRef} />
      ) : (
        <section className="card">
          <p><b>Your match view is on the video.</b> Score, rally stats, both players' moments and head-to-head panels play live on top of it.</p>
          <label className="drop">
            <input type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])} />
            <span>Choose the same video to watch it</span>
          </label>
        </section>
      )}

      <section className="card">
        <h2>Your 3 takeaways</h2>
        <div className="takeaways">
          {report.takeaways.map((t, i) => (
            <div key={t.title} className="tk">
              <span className="n">{i + 1}</span>
              <div>
                <b>{t.title}</b>
                <p>{t.action}</p>
                <Ev list={t.evidence} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>At a glance</h2>
        <div className="glance">
          {([["me", me], ["opponent", opponent]] as const).map(([who, p]) => (
            <div key={who} className={`pl ${who === "me" ? "me" : "opp"}`}>
              <h3>{who === "me" ? "You" : "Opponent"}</h3>
              <div className="tags">
                {p.strengths.map((x) => <span key={x} className="tag good">✓ {x}</span>)}
                {p.work_on.map((x) => <span key={x} className="tag work">! {x}</span>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {report.drills.length > 0 && (
        <section className="card">
          <h2>Drills</h2>
          {report.drills.map((d) => (
            <div key={d.name} className="drill">
              <b>{d.name}</b> <span className="tag work">{d.fixes}</span>
              <p className="muted">{d.how_to}</p>
            </div>
          ))}
        </section>
      )}

      <details className="card">
        <summary>All rallies ({tl.rallies.length})</summary>
        <ul className="rallies">
          {report.rallies.map((r, i) => (
            <li key={i}>
              <button className="chip" onClick={() => seek(r.start)}>▶ {r.start}</button>
              <span className={`win ${r.winner}`}>
                {r.winner === "me" ? "You" : r.winner === "opponent" ? "Opponent" : "Unclear"}
              </span>
              <span className="muted">~{r.shots} shots · {r.note}</span>
            </li>
          ))}
        </ul>
      </details>

      <details className="card notice">
        <summary>About this report</summary>
        <p className="muted">
          AI-estimated from sampled video frames, not measured. Ratings, speeds, shot counts and rally winners are estimates.
        </p>
        <ul>
          {report.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

function AnnotatedPlayer({
  file,
  tl,
  videoRef,
}: {
  file: File;
  tl: Timeline;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string>();
  const [exporting, setExporting] = useState<number | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Draw overlay in sync with playback.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.videoWidth) {
        const w = c.clientWidth * devicePixelRatio;
        const h = c.clientHeight * devicePixelRatio;
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, w, h);
        // Match the video's letterboxed content box.
        const scale = Math.min(w / v.videoWidth, h / v.videoHeight);
        const vw = v.videoWidth * scale;
        const vh = v.videoHeight * scale;
        ctx.save();
        ctx.translate((w - vw) / 2, (h - vh) / 2);
        drawOverlay(ctx, vw, vh, v.currentTime, tl, 0.85 * devicePixelRatio);
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tl, videoRef]);

  async function exportVideo() {
    setErr(null);
    setExporting(0);
    try {
      const { renderAnnotated } = await videoLib();
      const blob = await renderAnnotated(file, tl, (p) => setExporting(p));
      const name = file.name.replace(/\.\w+$/, "") + "-courtsense.mp4";
      const out = new File([blob], name, { type: "video/mp4" });
      setDownload({ url: URL.createObjectURL(out), name });
      // Offer the native share sheet on phones (WhatsApp etc.).
      if (navigator.canShare?.({ files: [out] })) {
        await navigator.share({ files: [out], title: `${BRAND} match analysis` }).catch(() => {});
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section className="card player">
      <div className="stage">
        <video ref={videoRef} src={url} controls playsInline preload="metadata" />
        <canvas ref={canvasRef} aria-hidden />
      </div>
      <div className="row">
        {exporting === null ? (
          <button className="primary" onClick={exportVideo}>
            ⬇ Get annotated video
          </button>
        ) : (
          <button className="primary" disabled>
            Rendering… {Math.round(exporting * 100)}%
          </button>
        )}
        {download && (
          <a className="button" href={download.url} download={download.name}>
            Save {download.name}
          </a>
        )}
      </div>
      {err && <p className="note">Export failed: {err}</p>}
      <p className="muted small">Rendering happens on your device and may take a few minutes for long videos.</p>
    </section>
  );
}

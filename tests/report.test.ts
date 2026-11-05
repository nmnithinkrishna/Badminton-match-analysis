import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReportSchema, reportJsonSchema, toSeconds } from "../shared/report";
import { parseAndValidate, salvage } from "../worker/analyse";
import { activeMoment, activeRally, buildTimeline } from "../src/lib/overlay";

const fixture = readFileSync(new URL("../scripts/fixtures/report.json", import.meta.url), "utf8");

describe("report schema", () => {
  it("accepts the recorded fixture", () => {
    expect(ReportSchema.safeParse(JSON.parse(fixture)).success).toBe(true);
  });

  it("requires exactly 3 takeaways", () => {
    const r = JSON.parse(fixture);
    r.takeaways = r.takeaways.slice(0, 2);
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it("rejects malformed timestamps", () => {
    const r = JSON.parse(fixture);
    r.moments[0].time = "about a minute in";
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it("produces a JSON schema Gemini can use", () => {
    const s = reportJsonSchema();
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe("object");
    const props = s.properties as Record<string, { minItems?: number; maxItems?: number }>;
    expect(props.takeaways.minItems).toBe(3);
    expect(props.takeaways.maxItems).toBe(3);
  });
});

describe("report schema v2", () => {
  it("rejects ratings outside 1-10", () => {
    const r = JSON.parse(fixture);
    r.players.opponent.ratings.speed = 11;
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it("keeps valid rallies when one rally is malformed", () => {
    const raw = JSON.parse(fixture);
    raw.rallies[1].shots = "lots";
    const s = salvage(raw);
    expect(s.rallies).toHaveLength(2);
    expect(s.moments).toHaveLength(raw.moments.length);
  });
});

describe("parseAndValidate / salvage", () => {
  it("validates good output", () => {
    expect(parseAndValidate(fixture).ok).toBe(true);
  });

  it("reports readable errors for bad output", () => {
    const r = parseAndValidate(JSON.stringify({ schema_version: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("summary");
  });

  it("handles non-JSON", () => {
    expect(parseAndValidate("not json").ok).toBe(false);
  });

  it("salvages a partial report as low confidence with a limitation", () => {
    const raw = JSON.parse(fixture);
    delete raw.drills;
    raw.takeaways = [raw.takeaways[0]];
    const s = salvage(raw);
    expect(s.confidence_overall).toBe("low");
    expect(s.drills).toEqual([]);
    expect(s.players.me.ratings.speed).toBe(raw.players.me.ratings.speed);
    expect(s.takeaways).toHaveLength(1);
    expect(s.summary.headline).toBe(raw.summary.headline);
    expect(s.limitations.at(-1)).toMatch(/partial/);
  });
});

describe("timeline", () => {
  const tl = buildTimeline(ReportSchema.parse(JSON.parse(fixture)));

  it("parses timestamps", () => {
    expect(toSeconds("0:05")).toBe(5);
    expect(toSeconds("12:34")).toBe(754);
    expect(toSeconds("1:02:03")).toBe(3723);
    expect(toSeconds("x:yy")).toBeNaN();
  });

  it("finds the moment and rally active at a time", () => {
    expect(activeMoment(tl, 23)?.label).toBe("Lift landed mid-court");
    expect(activeMoment(tl, 60)).toBeUndefined();
    expect(activeRally(tl, 20)?.n).toBe(2);
    expect(activeRally(tl, 33)).toBeUndefined();
  });
});

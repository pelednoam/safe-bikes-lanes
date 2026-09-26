// The trip in the URL: what a shared link says, and what it reveals.
import { describe, expect, it } from "vitest";

import { decodePlan, encodePlan, type PlanLink } from "../src/permalink.js";

const trip: PlanLink = {
  start: [-71.122258, 42.396748],
  end: [-71.086705, 42.362552],
  loop: null,
  profile: "young_kids",
  flat: true,
  walkM: 500,
  avoid: ["busy_street", "sharrow"],
  option: "balanced",
};

describe("encodePlan / decodePlan", () => {
  it("round-trips a trip, to about 11 m", () => {
    const hash = encodePlan(trip);
    expect(hash).toBe(
      "s=-71.1223,42.3967&m=young_kids&f=1&wk=500&x=busy_street,sharrow" +
        "&e=-71.0867,42.3626&o=balanced",
    );
    const back = decodePlan(`#${hash ?? ""}`);
    expect(back).toEqual({ ...trip, start: [-71.1223, 42.3967], end: [-71.0867, 42.3626] });
  });

  it("never publishes a home to the centimetre", () => {
    // six decimals put the sender's front door in every link to ~10 cm
    const hash = encodePlan({ ...trip, start: [-71.12345678, 42.39876543] }) ?? "";
    expect(hash).toContain("s=-71.1235,42.3988&");
    expect(hash).not.toMatch(/\d\.\d{5,}/);
  });

  it("a trip from your location says so, and routes from the recipient's", () => {
    const hash = encodePlan({ ...trip, start: "here" });
    expect(hash).toMatch(/^s=here&/);
    expect(decodePlan(hash ?? "").start).toBe("here");
  });

  it("round-trips a round trip, which has no destination", () => {
    const loop: PlanLink = { ...trip, end: null, option: null, loop: { km: 4.828, kind: "none" } };
    const hash = encodePlan(loop);
    expect(hash).toBe("s=-71.1223,42.3967&m=young_kids&f=1&wk=500&x=busy_street,sharrow&l=4.828,none");
    expect(decodePlan(hash ?? "").loop).toEqual({ km: 4.828, kind: "none" });
  });

  it("writes nothing until there is something to link to", () => {
    expect(encodePlan({ ...trip, start: null })).toBeNull();
    expect(encodePlan({ ...trip, end: null })).toBeNull();
  });

  it("leaves out what the rider has not set", () => {
    const hash = encodePlan({ ...trip, flat: false, walkM: 0, avoid: [], option: null });
    expect(hash).toBe("s=-71.1223,42.3967&m=young_kids&e=-71.0867,42.3626");
  });

  it("reads old links: six decimals, legacy rider names, wk=1", () => {
    const p = decodePlan("#s=-71.122258,42.396748&e=-71.086705,42.362552&m=kids&wk=1");
    expect(p.start).toEqual([-71.122258, 42.396748]);
    expect(p.profile).toBe("young_kids");
    expect(p.walkM).toBe(500);
  });

  it("drops what it cannot trust instead of guessing", () => {
    const p = decodePlan("#s=abc,42&e=-71.1,95&m=racer&o=fastest&l=-3,park&wk=99999");
    expect(p.start).toBeNull();
    expect(p.end).toBeNull(); // latitude 95 is not on Earth
    expect(p.profile).toBeNull();
    expect(p.option).toBeNull();
    expect(p.loop).toBeNull();
    expect(p.walkM).toBe(2000);
  });

  it("an empty hash is an empty plan", () => {
    expect(decodePlan("")).toEqual({
      start: null,
      end: null,
      loop: null,
      profile: null,
      flat: false,
      walkM: null,
      avoid: null,
      option: null,
    });
  });
});

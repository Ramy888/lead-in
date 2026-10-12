import { describe, expect, it } from "vitest";
import { DAYPARTS, daypartAt, demographicFit, formatTime, weakDayparts } from "../src/solver/dayparts.js";

describe("dayparts", () => {
  it("covers every hour of the day exactly once", () => {
    for (let h = 0; h < 24; h++) {
      const covering = DAYPARTS.filter((d) =>
        d.startHour < d.endHour ? h >= d.startHour && h < d.endHour : h >= d.startHour || h < d.endHour,
      );
      expect(covering, `hour ${h}`).toHaveLength(1);
    }
    expect(daypartAt(0).name).toBe("Late night");
  });

  it("scores an older, female-leaning show higher in daytime than late night", () => {
    const cozy = { age: { "55_and_older": 0.7, "24_and_younger": -0.4 }, gender: { female: 0.5, male: -0.5 } };
    const day = DAYPARTS.find((d) => d.name === "Daytime")!.profile;
    const late = DAYPARTS.find((d) => d.name === "Late night")!.profile;
    expect(demographicFit(cozy, day)).toBeGreaterThan(0.8);
    expect(demographicFit(cozy, late)).toBeLessThan(0.3);
    expect(demographicFit(undefined, day)).toBe(0.5);
  });

  it("formats units from a 06:00 broadcast day", () => {
    expect(formatTime(0)).toBe("06:00");
    expect(formatTime(37)).toBe("00:30");
  });

  it("reports dayparts whose airtime-weighted fit is under the threshold, worst first", () => {
    const slot = (startUnit: number, units: number, fit: number) =>
      ({ showId: "x", startUnit, units, fit, handoffScore: 1, weakHandoff: false });
    // Unit 0 = 06:00 (Morning), unit 6 = 09:00 (Daytime).
    const gaps = weakDayparts([slot(0, 2, 0.2), slot(2, 2, 0.4), slot(6, 2, 0.9)], 0.5);
    expect(gaps).toEqual([{ daypart: "Morning", meanFit: 0.3 }]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { nextRunAt, validateTimezone } from "./scheduler.js";

test("calculates daily schedules in the configured timezone", () => {
  assert.equal(
    nextRunAt(
      "0 9 * * *",
      "Asia/Shanghai",
      new Date("2026-08-14T00:01:00.000Z"),
    ),
    "2026-08-14T01:00:00.000Z",
  );
});

test("supports interval and weekday cron fields", () => {
  assert.equal(
    nextRunAt(
      "*/30 * * * 1-5",
      "Asia/Shanghai",
      new Date("2026-08-14T00:01:00.000Z"),
    ),
    "2026-08-14T00:30:00.000Z",
  );
});

test("rejects invalid cron expressions and timezones", () => {
  assert.equal(validateTimezone("Not/A_Timezone"), false);
  assert.throws(() => nextRunAt("0 9 * *", "Asia/Shanghai"));
  assert.throws(() => nextRunAt("70 9 * * *", "Asia/Shanghai"));
});

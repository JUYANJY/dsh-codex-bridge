/**
 * Notification classification: which methods are worth showing, and what to show.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_DELTA_METHODS,
  LIVE_MARKER_METHODS,
  describeNotification,
} from "../src/notifications.js";

test("the delta set holds the methods that carry streamed text", () => {
  for (const method of [
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta",
    "item/fileChange/patchUpdated",
  ]) {
    assert.ok(LIVE_DELTA_METHODS.has(method), `${method} should be a delta method`);
  }
});

test("the marker set holds turn boundaries and status changes", () => {
  for (const method of ["turn/started", "turn/completed", "item/started", "item/completed", "thread/status/changed"]) {
    assert.ok(LIVE_MARKER_METHODS.has(method), `${method} should be a marker method`);
  }
});

test("the two sets are disjoint", () => {
  for (const method of LIVE_DELTA_METHODS) assert.ok(!LIVE_MARKER_METHODS.has(method), method);
});

test("describeNotification prefers the text-bearing key", () => {
  assert.equal(describeNotification("m", { delta: "d" }), "d");
  assert.equal(describeNotification("m", { text: "t" }), "t");
  assert.equal(describeNotification("m", { chunk: "c" }), "c");
  assert.equal(describeNotification("m", { message: "mm" }), "mm");
  assert.equal(describeNotification("m", { summary: "s" }), "s");
});

test("describeNotification falls back to structural descriptions", () => {
  assert.equal(describeNotification("item/started", { item: { type: "reasoning" } }), "item reasoning");
  assert.equal(describeNotification("thread/status/changed", { status: { type: "idle" } }), "status idle");
  assert.match(describeNotification("thread/tokenUsage/updated", { tokenUsage: { total: 1 } }), /^tokens \{/);
  assert.equal(describeNotification("turn/started", {}), "");
  assert.equal(describeNotification("turn/started"), "");
});

test("describeNotification ignores empty strings rather than echoing them", () => {
  assert.equal(describeNotification("m", { delta: "", text: "real" }), "real");
});

test("a budget update describes its windows instead of rendering blank", () => {
  const line = describeNotification("account/rateLimits/updated", {
    rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300 },
      secondary: { usedPercent: 9, windowDurationMins: 10080 },
      rateLimitReachedType: null,
    },
  });
  assert.equal(line, "budget 12%/300min 9% weekly");
  // The reached type is the one part of this notification a reader must not miss.
  assert.equal(
    describeNotification("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: "rate_limit_reached" },
    }),
    "budget 100%/300min REACHED: rate_limit_reached",
  );
  // Missing numbers are printed as unknown, never as zero.
  assert.equal(describeNotification("account/rateLimits/updated", { rateLimits: { primary: {} } }), "budget ?/?min");
});

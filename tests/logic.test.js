const test = require("node:test");
const assert = require("node:assert/strict");
const Logic = require("../js/logic.js");

function at(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

test("seedState gives three sample goals with short steps", () => {
  const now = at(2026, 10, 18);
  const state = Logic.seedState(now);
  assert.equal(state.seeded, true);
  assert.equal(state.goals.length, 3);
  assert.equal(state.currentGoalId, state.goals[0].id);
  assert.equal(state.goals[0].title, "把书桌清出一块，开始写论文");
  state.goals.forEach((goal) => {
    assert.ok(goal.steps.length >= 3);
    goal.steps.forEach((step) => {
      assert.equal(step.status, "pending");
      assert.ok(step.title.length > 0);
      assert.ok(step.minutes === null || Logic.FOCUS_CHOICES.includes(step.minutes));
    });
  });
  assert.equal(state.log.length, 0);
  assert.equal(state.active, null);
});

test("normalizeState keeps saved goals and does not reseed after a deliberate empty list", () => {
  const now = at(2026, 10, 18);
  const seeded = Logic.seedState(now);
  const again = Logic.normalizeState(seeded, now);
  assert.equal(again.goals.length, 3);
  assert.equal(again.goals[0].id, seeded.goals[0].id);
  assert.equal(again.goals[0].steps[0].id, seeded.goals[0].steps[0].id);

  const empty = Logic.normalizeState({ version: 1, seeded: true, goals: [], settings: { focusMinutes: 99, breakMinutes: 8, sound: false } }, now);
  assert.equal(empty.goals.length, 0);
  assert.equal(empty.seeded, true);
  assert.equal(empty.settings.focusMinutes, 10);
  assert.equal(empty.settings.breakMinutes, 3);
  assert.equal(empty.settings.sound, false);

  const firstVisit = Logic.normalizeState({ goals: [] }, now);
  assert.equal(firstVisit.goals.length, 3);
});

test("normalizeState drops a focus session whose step is already done", () => {
  const now = at(2026, 10, 18);
  const state = Logic.seedState(now);
  state.goals[0].steps[0].status = "done";
  state.active = {
    phase: "focus",
    goalId: state.goals[0].id,
    stepId: state.goals[0].steps[0].id,
    plannedSec: 300,
    remainingSec: 200,
    running: true,
    runStartedAt: now,
    timeUp: false,
  };
  const normalized = Logic.normalizeState(state, now);
  assert.equal(normalized.active, null);
});

test("goal progress ignores skipped steps in the percent", () => {
  const goal = {
    steps: [
      { status: "done", minutes: 5 },
      { status: "skipped", minutes: 5 },
      { status: "pending", minutes: 25 },
      { status: "pending" },
    ],
  };
  const stats = Logic.goalStats(goal, { focusMinutes: 10 });
  assert.equal(stats.total, 4);
  assert.equal(stats.done, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.pending, 2);
  assert.equal(stats.pct, 25);
  assert.equal(stats.remainingMin, 35);
  assert.equal(stats.next, goal.steps[2]);
  assert.equal(Logic.overallStats([goal]).pct, 25);
});

test("shortest pending step uses the default focus length", () => {
  const goals = [
    { id: "a", steps: [{ id: "a1", status: "pending", minutes: 15, title: "较长" }] },
    { id: "b", steps: [{ id: "b1", status: "done", minutes: 5 }, { id: "b2", status: "pending", title: "最短" }] },
  ];
  const found = Logic.shortestPending(goals, { focusMinutes: 5 });
  assert.equal(found.step.id, "b2");
  assert.equal(found.mins, 5);
});

test("streak counts consecutive local days and stays alive through yesterday", () => {
  const now = at(2026, 2, 1, 15);
  const log = [
    { outcome: "done", at: at(2026, 1, 30, 9) },
    { outcome: "done", at: at(2026, 1, 31, 18) },
    { outcome: "skipped", at: at(2026, 2, 1, 8) },
  ];
  assert.deepEqual(Logic.computeStreak(log, now), { days: 2, aliveToday: false });

  log.push({ outcome: "done", at: at(2026, 2, 1, 10) });
  assert.deepEqual(Logic.computeStreak(log, now), { days: 3, aliveToday: true });

  const gapped = [{ outcome: "done", at: at(2026, 1, 28) }, { outcome: "done", at: at(2026, 2, 1, 10) }];
  assert.deepEqual(Logic.computeStreak(gapped, now), { days: 1, aliveToday: true });
  assert.deepEqual(Logic.computeStreak([], now), { days: 0, aliveToday: false });
});

test("warmth follows recent finished steps", () => {
  const now = at(2026, 6, 18, 12);
  assert.equal(Logic.warmth([], now).label, "未开始");
  assert.equal(Logic.warmth([{ outcome: "done", at: at(2026, 6, 18, 9) }], now).label, "微温");
  assert.equal(
    Logic.warmth(
      [
        { outcome: "done", at: at(2026, 6, 18, 9) },
        { outcome: "done", at: at(2026, 6, 18, 11) },
      ],
      now
    ).label,
    "正热"
  );
  assert.equal(Logic.warmth([{ outcome: "done", at: at(2026, 6, 17, 21) }], now).label, "余温");
  assert.equal(Logic.warmth([{ outcome: "done", at: at(2026, 6, 13, 21) }], now).label, "凉了");
  assert.equal(Logic.warmth([{ outcome: "skipped", at: at(2026, 6, 18, 9) }], now).label, "未开始");
});

test("daily series ends today and counts only finished steps", () => {
  const now = at(2026, 10, 18, 16);
  const series = Logic.dailySeries(
    [
      { outcome: "done", at: at(2026, 10, 18, 9) },
      { outcome: "done", at: at(2026, 10, 18, 11) },
      { outcome: "skipped", at: at(2026, 10, 17, 11) },
      { outcome: "done", at: at(2026, 10, 16, 11) },
    ],
    14,
    now
  );
  assert.equal(series.days.length, 14);
  assert.equal(series.days[13].isToday, true);
  assert.equal(series.days[13].count, 2);
  assert.equal(series.days[12].count, 0);
  assert.equal(series.days[11].count, 1);
  assert.equal(series.max, 2);
});

test("timer remaining, pause, and extend do not drift", () => {
  const now = 10_000_000;
  const active = { remainingSec: 100, running: true, runStartedAt: now - 25_000, plannedSec: 100, timeUp: false, phase: "focus" };
  assert.equal(Logic.remainingSeconds(active, now), 75);
  assert.equal(active.remainingSec, 100);

  const paused = Logic.pauseActive(active, now);
  assert.equal(paused.remainingSec, 75);
  assert.equal(paused.running, false);
  assert.equal(Logic.remainingSeconds(paused, now + 50_000), 75);

  const resumed = Logic.resumeActive(paused, now + 50_000);
  assert.equal(Logic.remainingSeconds(resumed, now + 60_000), 65);

  const extended = Logic.extendActive({ ...paused, timeUp: true }, 300, now);
  assert.equal(extended.remainingSec, 375);
  assert.equal(extended.plannedSec, 400);
  assert.equal(extended.running, true);
  assert.equal(extended.timeUp, false);

  const shrunk = Logic.shrinkActive(active, 30, now);
  assert.equal(shrunk.remainingSec, 30);
  assert.equal(shrunk.plannedSec, 55);
  assert.equal(Logic.remainingSeconds(shrunk, now), 30);
  assert.equal(shrunk.runStartedAt, now);

  const pausedShort = { remainingSec: 20, running: false, runStartedAt: null, plannedSec: 40, timeUp: false };
  assert.equal(Logic.shrinkActive(pausedShort, 30, now), pausedShort);

  const caught = Logic.catchUpActive(active, now + 1_000_000);
  assert.equal(caught.expired, true);
  assert.equal(caught.active.remainingSec, 0);
  assert.equal(caught.active.timeUp, true);
  assert.equal(Logic.catchUpActive(paused, now).expired, false);
});

test("early finish is described as landing", () => {
  assert.match(Logic.describeElapsed(0), /落地/);
  assert.match(Logic.describeElapsed(19), /落地/);
  assert.match(Logic.describeElapsed(45), /45 秒/);
  assert.equal(Logic.describeElapsed(120), "用了 2 分钟。");
  assert.equal(Logic.describeElapsed(90), "用了 1 分 30 秒。");
});

test("todayDone keeps finished steps from the local day in order", () => {
  const now = at(2026, 10, 18, 18);
  const items = Logic.todayDone(
    [
      { outcome: "done", at: at(2026, 10, 18, 15), stepTitle: "下午" },
      { outcome: "skipped", at: at(2026, 10, 18, 10), stepTitle: "跳过" },
      { outcome: "done", at: at(2026, 10, 17, 9), stepTitle: "昨天" },
      { outcome: "done", at: at(2026, 10, 18, 9), stepTitle: "上午" },
    ],
    now
  );
  assert.deepEqual(
    items.map((item) => item.stepTitle),
    ["上午", "下午"]
  );
});

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SuibuLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FOCUS_CHOICES = Object.freeze([5, 10, 15, 25]);
  const BREAK_CHOICES = Object.freeze([0, 3, 5, 10]);
  const LOG_LIMIT = 400;

  function createId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function addDays(ts, days) {
    const d = new Date(ts);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function choice(value, choices, fallback) {
    const n = Number(value);
    return choices.includes(n) ? n : fallback;
  }

  function stepMinutes(step, settings) {
    const custom = Number(step && step.minutes);
    if (FOCUS_CHOICES.includes(custom)) return custom;
    return choice(settings && settings.focusMinutes, FOCUS_CHOICES, 10);
  }

  function doneEvents(log) {
    return (Array.isArray(log) ? log : []).filter(
      (entry) => entry && entry.outcome === "done" && Number.isFinite(Number(entry.at))
    );
  }

  function goalStats(goal, settings) {
    const steps = goal && Array.isArray(goal.steps) ? goal.steps : [];
    let done = 0;
    let skipped = 0;
    const pendingSteps = [];
    steps.forEach((step) => {
      if (step.status === "done") done += 1;
      else if (step.status === "skipped") skipped += 1;
      else pendingSteps.push(step);
    });
    const total = steps.length;
    const remainingMin = pendingSteps.reduce((sum, step) => sum + stepMinutes(step, settings), 0);
    return {
      total,
      done,
      skipped,
      pending: pendingSteps.length,
      pct: total ? Math.round((done / total) * 100) : 0,
      next: pendingSteps[0] || null,
      remainingMin,
    };
  }

  function overallStats(goals) {
    let total = 0;
    let done = 0;
    let skipped = 0;
    let pending = 0;
    (goals || []).forEach((goal) => {
      (goal.steps || []).forEach((step) => {
        total += 1;
        if (step.status === "done") done += 1;
        else if (step.status === "skipped") skipped += 1;
        else pending += 1;
      });
    });
    return {
      total,
      done,
      skipped,
      pending,
      pct: total ? Math.round((done / total) * 100) : 0,
    };
  }

  function shortestPending(goals, settings) {
    let best = null;
    (goals || []).forEach((goal) => {
      (goal.steps || []).forEach((step) => {
        if (step.status !== "pending") return;
        const mins = stepMinutes(step, settings);
        if (!best || mins < best.mins) best = { goal, step, mins };
      });
    });
    return best;
  }

  function computeStreak(log, now) {
    const days = new Set(doneEvents(log).map((entry) => dayKey(entry.at)));
    const todayStart = startOfDay(now);
    let cursor = todayStart;
    if (!days.has(dayKey(cursor))) {
      cursor = startOfDay(addDays(todayStart, -1));
      if (!days.has(dayKey(cursor))) return { days: 0, aliveToday: false };
    }
    let count = 0;
    while (days.has(dayKey(cursor))) {
      count += 1;
      cursor = startOfDay(addDays(cursor, -1));
    }
    return { days: count, aliveToday: days.has(dayKey(todayStart)) };
  }

  function warmth(log, now) {
    const done = doneEvents(log);
    if (done.length === 0) {
      return { level: 0, label: "未开始", hint: "做完第一步，这里会亮起来。" };
    }
    const today = dayKey(now);
    const yesterday = dayKey(addDays(startOfDay(now), -1));
    let todayCount = 0;
    let yesterdayCount = 0;
    done.forEach((entry) => {
      const key = dayKey(entry.at);
      if (key === today) todayCount += 1;
      else if (key === yesterday) yesterdayCount += 1;
    });
    if (todayCount >= 2) return { level: 3, label: "正热", hint: "今天已经走完多步，兴趣还热着。" };
    if (todayCount === 1) return { level: 2, label: "微温", hint: "今天续过一次。再走一步会更稳。" };
    if (yesterdayCount > 0) return { level: 1, label: "余温", hint: "昨天有进展。今天任意一小步就能接上。" };
    return { level: 0, label: "凉了", hint: "没关系。挑最短的一步，做完即可。" };
  }

  function dailySeries(log, days, now) {
    const totalDays = days || 14;
    const today = startOfDay(now);
    const done = doneEvents(log);
    const points = [];
    let max = 0;
    for (let i = totalDays - 1; i >= 0; i -= 1) {
      const ts = startOfDay(addDays(today, -i));
      const key = dayKey(ts);
      const count = done.filter((entry) => dayKey(entry.at) === key).length;
      if (count > max) max = count;
      const date = new Date(ts);
      points.push({
        ts,
        key,
        count,
        isToday: i === 0,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
      });
    }
    return { days: points, max };
  }

  function remainingSeconds(active, now) {
    if (!active) return 0;
    const base = Math.max(0, Number(active.remainingSec) || 0);
    if (!active.running || !active.runStartedAt) return base;
    const elapsed = Math.floor((Number(now) - Number(active.runStartedAt)) / 1000);
    return Math.max(0, base - elapsed);
  }

  function pauseActive(active, now) {
    return {
      ...active,
      remainingSec: remainingSeconds(active, now),
      running: false,
      runStartedAt: null,
    };
  }

  function resumeActive(active, now) {
    return {
      ...active,
      running: true,
      runStartedAt: now,
      timeUp: false,
    };
  }

  function extendActive(active, extraSec, now) {
    const left = remainingSeconds(active, now);
    return {
      ...active,
      plannedSec: Number(active.plannedSec) + extraSec,
      remainingSec: left + extraSec,
      running: true,
      runStartedAt: now,
      timeUp: false,
    };
  }

  function catchUpActive(active, now) {
    if (!active || !active.running) return { active, expired: false };
    if (remainingSeconds(active, now) > 0) return { active, expired: false };
    return {
      expired: true,
      active: {
        ...active,
        remainingSec: 0,
        running: false,
        runStartedAt: null,
        timeUp: true,
      },
    };
  }

  function blankGoal(partial, now) {
    return {
      id: partial.id || createId(),
      title: partial.title,
      why: partial.why || "",
      createdAt: partial.createdAt || now,
      updatedAt: partial.updatedAt || now,
      steps: partial.steps.map((step) => ({
        id: step.id || createId(),
        title: step.title,
        minutes: FOCUS_CHOICES.includes(step.minutes) ? step.minutes : null,
        status: "pending",
        completedAt: null,
      })),
    };
  }

  function seedState(now) {
    const createdAt = now || Date.now();
    const goals = [
      blankGoal(
        {
          title: "把书桌清出一块，开始写论文",
          why: "论文太大，所以每次只碰很小的一块。",
          createdAt,
          steps: [
            { title: "把桌上的东西分成「留下」和「先拿走」", minutes: 5 },
            { title: "只擦写字时手肘会碰到的那一块", minutes: 5 },
            { title: "打开文档，写下三句话大纲", minutes: 10 },
            { title: "写正文第一句，写完就停", minutes: 10 },
          ],
        },
        createdAt
      ),
      blankGoal(
        {
          title: "练会一个吉他和弦切换",
          why: "想弹琴，但不想一坐下就是半小时。",
          createdAt,
          steps: [
            { title: "把吉他拿出来，并调准音", minutes: 5 },
            { title: "只练两个和弦之间的切换，慢速 8 次", minutes: 10 },
            { title: "用很慢的速度连贯弹 1 分钟", minutes: 5 },
          ],
        },
        createdAt
      ),
      blankGoal(
        {
          title: "准备一个 5 分钟的小分享",
          why: "一上来做幻灯片，很容易还没开始就放弃。",
          createdAt,
          steps: [
            { title: "写下希望听众记住的那一句话", minutes: 5 },
            { title: "列出三个要点，每个只写一行", minutes: 10 },
            { title: "给第一个要点配一个自己的例子", minutes: 10 },
            { title: "把这三行用口语念出声一遍", minutes: 5 },
          ],
        },
        createdAt
      ),
    ];
    return {
      version: 1,
      seeded: true,
      settings: { focusMinutes: 10, breakMinutes: 3, sound: true },
      currentGoalId: goals[0].id,
      goals,
      log: [],
      active: null,
      notice: null,
    };
  }

  function normalizeStep(step, seen) {
    if (!step || typeof step !== "object") return null;
    const title = String(step.title || "").trim().slice(0, 80);
    if (!title) return null;
    let id = String(step.id || createId());
    while (seen.has(id)) id = createId();
    seen.add(id);
    const status = step.status === "done" || step.status === "skipped" ? step.status : "pending";
    const minutes = FOCUS_CHOICES.includes(Number(step.minutes)) ? Number(step.minutes) : null;
    return {
      id,
      title,
      minutes,
      status,
      completedAt: status === "pending" ? null : Number(step.completedAt) || null,
    };
  }

  function normalizeGoal(goal, seenGoalIds) {
    if (!goal || typeof goal !== "object") return null;
    const title = String(goal.title || "").trim().slice(0, 60);
    if (!title) return null;
    let id = String(goal.id || createId());
    while (seenGoalIds.has(id)) id = createId();
    seenGoalIds.add(id);
    const seenSteps = new Set();
    const steps = (Array.isArray(goal.steps) ? goal.steps : [])
      .map((step) => normalizeStep(step, seenSteps))
      .filter(Boolean);
    return {
      id,
      title,
      why: String(goal.why || "").trim().slice(0, 120),
      createdAt: Number(goal.createdAt) || Date.now(),
      updatedAt: Number(goal.updatedAt) || Date.now(),
      steps,
    };
  }

  function normalizeActive(active, goals) {
    if (!active || typeof active !== "object") return null;
    const phase = active.phase === "break" ? "break" : "focus";
    const goal = goals.find((item) => item.id === active.goalId);
    if (!goal) return null;
    const step = goal.steps.find((item) => item.id === active.stepId) || null;
    if (phase === "focus" && (!step || step.status !== "pending")) return null;
    if (phase === "break" && active.stepId && !step) return null;
    const plannedSec = Math.round(Number(active.plannedSec));
    if (!Number.isFinite(plannedSec) || plannedSec <= 0) return null;
    let remainingSec = Number(active.remainingSec);
    if (!Number.isFinite(remainingSec) || remainingSec < 0) remainingSec = plannedSec;
    remainingSec = Math.min(plannedSec, remainingSec);
    let running = Boolean(active.running);
    let runStartedAt = Number(active.runStartedAt) || null;
    let timeUp = Boolean(active.timeUp);
    if (timeUp) {
      remainingSec = 0;
      running = false;
      runStartedAt = null;
    }
    if (running && !runStartedAt) return null;
    return {
      phase,
      goalId: goal.id,
      stepId: step ? step.id : null,
      plannedSec,
      remainingSec,
      running,
      runStartedAt: running ? runStartedAt : null,
      timeUp,
    };
  }

  function normalizeNotice(notice) {
    if (!notice || typeof notice !== "object") return null;
    if (notice.type !== "step-done" && notice.type !== "step-skip" && notice.type !== "break-done") return null;
    const goalTitle = String(notice.goalTitle || "").trim();
    const stepTitle = String(notice.stepTitle || "").trim();
    if (!goalTitle || !stepTitle) return null;
    const nextMinutes = FOCUS_CHOICES.includes(Number(notice.nextMinutes)) ? Number(notice.nextMinutes) : null;
    return {
      type: notice.type,
      at: Number(notice.at) || Date.now(),
      goalId: notice.goalId || null,
      stepId: notice.stepId || null,
      goalTitle,
      stepTitle,
      nextStepId: notice.nextStepId || null,
      nextStepTitle: notice.nextStepTitle ? String(notice.nextStepTitle) : null,
      nextMinutes,
      pendingCount: Math.max(0, Number(notice.pendingCount) || 0),
      elapsedSec: Math.max(0, Number(notice.elapsedSec) || 0),
      plannedSec: Math.max(0, Number(notice.plannedSec) || 0),
      line: String(notice.line || ""),
    };
  }

  function normalizeLog(log) {
    if (!Array.isArray(log)) return [];
    const clean = log
      .filter(
        (entry) =>
          entry &&
          (entry.outcome === "done" || entry.outcome === "skipped") &&
          Number.isFinite(Number(entry.at)) &&
          entry.stepTitle &&
          entry.goalTitle
      )
      .map((entry) => ({
        id: String(entry.id || createId()),
        at: Number(entry.at),
        goalId: entry.goalId || null,
        stepId: entry.stepId || null,
        goalTitle: String(entry.goalTitle).slice(0, 60),
        stepTitle: String(entry.stepTitle).slice(0, 80),
        outcome: entry.outcome,
        plannedSec: Math.max(0, Number(entry.plannedSec) || 0),
        elapsedSec: Math.max(0, Number(entry.elapsedSec) || 0),
      }));
    return clean.slice(-LOG_LIMIT);
  }

  function normalizeState(raw, now) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.goals)) return seedState(now || Date.now());
    const seeded = Boolean(raw.seeded);
    if (raw.goals.length === 0 && !seeded) return seedState(now || Date.now());
    const seenGoalIds = new Set();
    const goals = raw.goals.map((goal) => normalizeGoal(goal, seenGoalIds)).filter(Boolean);
    const settings = {
      focusMinutes: choice(raw.settings && raw.settings.focusMinutes, FOCUS_CHOICES, 10),
      breakMinutes: choice(raw.settings && raw.settings.breakMinutes, BREAK_CHOICES, 3),
      sound: !raw.settings || raw.settings.sound !== false,
    };
    const goalIds = new Set(goals.map((goal) => goal.id));
    const currentGoalId = goalIds.has(raw.currentGoalId) ? raw.currentGoalId : goals[0] ? goals[0].id : null;
    let active = normalizeActive(raw.active, goals);
    let notice = normalizeNotice(raw.notice);
    if (active) notice = null;
    return {
      version: 1,
      seeded: seeded || goals.length > 0,
      settings,
      currentGoalId,
      goals,
      log: normalizeLog(raw.log),
      active,
      notice,
    };
  }

  return {
    FOCUS_CHOICES,
    BREAK_CHOICES,
    LOG_LIMIT,
    createId,
    dayKey,
    startOfDay,
    addDays,
    stepMinutes,
    goalStats,
    overallStats,
    shortestPending,
    computeStreak,
    warmth,
    dailySeries,
    remainingSeconds,
    pauseActive,
    resumeActive,
    extendActive,
    catchUpActive,
    seedState,
    normalizeState,
  };
});

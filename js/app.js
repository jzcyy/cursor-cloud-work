(function () {
  "use strict";

  const Logic = globalThis.SuibuLogic;
  const Store = globalThis.SuibuStore;

  const LINES = {
    "step-done": [
      "做完就可以停。兴趣还在的时候收工，下次更容易回来。",
      "这一步很短，短到你把它做完了。",
      "大目标还在。你刚刚只用一小段时间碰了它。",
      "可以停在这里。下次从来时的下一步开始就好。",
    ],
    "step-skip": [
      "跳过也算处理过。它不会计入完成度。",
      "这一步先放着。之后可以把它改得更短再回来。",
    ],
    "break-done": [
      "休息结束了。下一步仍然只是一小步。",
      "可以开始下一步，也可以今天就停在这里。",
    ],
  };

  const app = {
    view: "home",
    draft: null,
    formError: "",
    quickError: "",
    dialog: null,
    timerBanner: "",
    focusTitle: false,
    focusStepId: null,
    storageError: "",
    showFinished: false,
    armDrop: false,
    tinyError: "",
  };

  let state = Store.load();
  let audioCtx = null;

  function persist() {
    try {
      Store.save(state);
      app.storageError = "";
    } catch (error) {
      app.storageError = "浏览器拒绝保存。可能是存储空间满了，或关闭了站点数据。";
    }
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch]);
  }

  function pickLine(type, seed) {
    const list = LINES[type] || LINES["step-done"];
    let n = 0;
    const text = String(seed || "");
    for (let i = 0; i < text.length; i += 1) n = (n + text.charCodeAt(i)) % list.length;
    return list[n];
  }

  function formatClock(totalSec) {
    const sec = Math.max(0, Math.ceil(Number(totalSec) || 0));
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function formatSpent(totalSec) {
    const sec = Math.max(0, Math.round(Number(totalSec) || 0));
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    if (m === 0) return `${r} 秒`;
    if (r === 0) return `${m} 分钟`;
    return `${m} 分 ${r} 秒`;
  }

  function formatWhen(ts) {
    const date = new Date(ts);
    const now = Date.now();
    const time = date.toLocaleTimeString("zh-CN", { hour: "numeric", minute: "2-digit" });
    if (Logic.dayKey(ts) === Logic.dayKey(now)) return `今天 ${time}`;
    if (Logic.dayKey(ts) === Logic.dayKey(Logic.addDays(Logic.startOfDay(now), -1))) return `昨天 ${time}`;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  function greeting(now) {
    const hour = new Date(now).getHours();
    if (hour < 5) return "夜深了";
    if (hour < 11) return "早上好";
    if (hour < 14) return "中午好";
    if (hour < 18) return "下午好";
    return "晚上好";
  }

  function dailyLine(now) {
    const lines = [
      "兴趣会掉，是正常的。先做短到能做完的一步。",
      "不用看完整座山。只要看见脚下这一步。",
      "做完就可以停。停在还有一点兴趣的时候，明天更容易回来。",
    ];
    return lines[new Date(now).getDate() % lines.length];
  }

  function goalById(id) {
    return state.goals.find((goal) => goal.id === id) || null;
  }

  function currentGoal() {
    return goalById(state.currentGoalId) || state.goals[0] || null;
  }

  function findStep(goal, stepId) {
    return goal ? goal.steps.find((step) => step.id === stepId) || null : null;
  }

  function hashFor(view) {
    return {
      home: "#/",
      progress: "#/progress",
      settings: "#/settings",
      focus: "#/focus",
      editor: "#/edit",
    }[view] || "#/";
  }

  function viewFromHash(hash) {
    return {
      "#/": "home",
      "#/progress": "progress",
      "#/settings": "settings",
      "#/focus": "focus",
      "#/edit": "editor",
    }[hash] || "home";
  }

  function go(view) {
    const hash = hashFor(view);
    if ((location.hash || "#/") !== hash) location.hash = hash;
    else {
      app.view = view;
      paint();
    }
  }

  function blankStep() {
    return { id: Logic.createId(), title: "", minutes: null, status: "pending", completedAt: null };
  }

  function segmentsHtml(goal) {
    if (!goal || !goal.steps.length) return `<p class="muted small">还没有步骤</p>`;
    const stats = Logic.goalStats(goal, state.settings);
    const nextId = stats.next && stats.next.id;
    const label = `${stats.total} 步里完成 ${stats.done} 步，跳过 ${stats.skipped} 步`;
    const cells = goal.steps
      .map((step) => {
        const kind = step.id === nextId ? "next" : step.status === "done" ? "done" : step.status === "skipped" ? "skipped" : "pending";
        return `<i class="seg seg-${kind}"></i>`;
      })
      .join("");
    return `<div class="segments" role="img" aria-label="${esc(label)}">${cells}</div>`;
  }

  function logoHtml() {
    return `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="20" width="6" height="8" rx="1.5"></rect><rect x="13" y="13" width="6" height="15" rx="1.5"></rect><rect x="23" y="6" width="6" height="22" rx="1.5"></rect></svg>`;
  }

  function heatHtml(info) {
    const cells = [1, 2, 3].map((n) => `<i class="${n <= info.level ? "on" : ""}"></i>`).join("");
    return `<div class="heat heat-${info.level}" role="img" aria-label="兴趣温度 ${esc(info.label)}">${cells}</div>`;
  }

  function ensureAudio() {
    if (!state.settings.sound) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  function playChime() {
    if (!state.settings.sound || !audioCtx) return;
    const now = audioCtx.currentTime;
    [523.25, 659.25].forEach((freq, index) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now);
      const start = now + index * 0.12;
      gain.gain.exponentialRampToValueAtTime(0.04, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  }

  function makeNotice(type, goal, step, elapsedSec, plannedSec) {
    const stats = Logic.goalStats(goal, state.settings);
    return {
      type,
      at: Date.now(),
      goalId: goal.id,
      stepId: step.id,
      goalTitle: goal.title,
      stepTitle: step.title,
      nextStepId: stats.next ? stats.next.id : null,
      nextStepTitle: stats.next ? stats.next.title : null,
      nextMinutes: stats.next ? Logic.stepMinutes(stats.next, state.settings) : null,
      pendingCount: stats.pending,
      elapsedSec: Math.max(0, elapsedSec || 0),
      plannedSec: Math.max(0, plannedSec || 0),
      line: pickLine(type, step.id),
    };
  }

  function appendLog(entry) {
    state.log.push(entry);
    if (state.log.length > Logic.LOG_LIMIT) state.log.splice(0, state.log.length - Logic.LOG_LIMIT);
  }

  function beginFocus(goal, step) {
    const mins = Logic.stepMinutes(step, state.settings);
    state.currentGoalId = goal.id;
    state.notice = null;
    state.active = {
      phase: "focus",
      goalId: goal.id,
      stepId: step.id,
      plannedSec: mins * 60,
      remainingSec: mins * 60,
      running: true,
      runStartedAt: Date.now(),
      timeUp: false,
    };
    goal.updatedAt = Date.now();
    ensureAudio();
    persist();
    go("focus");
  }

  function requestStart(goalId, stepId) {
    const goal = goalById(goalId);
    const step = findStep(goal, stepId);
    if (!goal || !step || step.status !== "pending") return;
    const active = state.active;
    if (active && active.phase === "focus" && active.goalId === goalId && active.stepId === stepId) {
      go("focus");
      return;
    }
    if (active) {
      app.dialog = {
        kind: "switch-step",
        goalId,
        stepId,
        title: active.phase === "break" ? "要结束休息吗？" : "要放下当前这一步吗？",
        body: active.phase === "break"
          ? "休息会结束，然后开始你选的这一步。"
          : "当前计时会停掉。这一步仍然算未完成，不计入进度。",
        confirm: active.phase === "break" ? "结束休息并开始" : "放下并开始新的一步",
        danger: false,
      };
      paint();
      return;
    }
    beginFocus(goal, step);
  }

  function finishStep(outcome) {
    const active = state.active;
    if (!active || active.phase !== "focus") return;
    const goal = goalById(active.goalId);
    const step = findStep(goal, active.stepId);
    if (!goal || !step) {
      state.active = null;
      persist();
      go("home");
      return;
    }
    const left = Logic.remainingSeconds(active, Date.now());
    const elapsed = Math.max(0, active.plannedSec - left);
    step.status = outcome === "skipped" ? "skipped" : "done";
    step.completedAt = Date.now();
    goal.updatedAt = Date.now();
    appendLog({
      id: Logic.createId(),
      at: Date.now(),
      goalId: goal.id,
      stepId: step.id,
      goalTitle: goal.title,
      stepTitle: step.title,
      outcome: step.status === "skipped" ? "skipped" : "done",
      plannedSec: active.plannedSec,
      elapsedSec: elapsed,
    });
    state.notice = makeNotice(step.status === "skipped" ? "step-skip" : "step-done", goal, step, elapsed, active.plannedSec);
    state.active = null;
    state.currentGoalId = goal.id;
    persist();
    if (app.view !== "focus") go("focus");
    else paint();
  }

  function startBreak() {
    if (!state.settings.breakMinutes || !state.notice) return;
    const notice = state.notice;
    state.active = {
      phase: "break",
      goalId: notice.goalId,
      stepId: notice.stepId,
      plannedSec: state.settings.breakMinutes * 60,
      remainingSec: state.settings.breakMinutes * 60,
      running: true,
      runStartedAt: Date.now(),
      timeUp: false,
    };
    state.notice = null;
    ensureAudio();
    persist();
    paint();
  }

  function endBreak(expired) {
    const active = state.active;
    const goal = active ? goalById(active.goalId) : null;
    const step = goal ? findStep(goal, active.stepId) : null;
    state.active = null;
    if (goal && step) state.notice = makeNotice("break-done", goal, step, 0, 0);
    else {
      state.notice = {
        type: "break-done",
        at: Date.now(),
        goalId: null,
        stepId: null,
        goalTitle: "休息",
        stepTitle: "休息",
        nextStepId: null,
        nextStepTitle: null,
        nextMinutes: null,
        pendingCount: 0,
        elapsedSec: 0,
        plannedSec: 0,
        line: expired ? "休息结束了。下一步仍然只是一小步。" : "休息先停在这里也可以。",
      };
    }
    persist();
    paint();
  }

  function extendFive() {
    if (!state.active || state.active.phase !== "focus") return;
    state.active = Logic.extendActive(state.active, 5 * 60, Date.now());
    ensureAudio();
    persist();
    paint();
  }

  function dropTimerButton() {
    const active = state.active;
    if (!active || active.phase !== "focus" || active.running || active.timeUp) return "";
    return `<button type="button" class="btn btn-quiet" data-action="drop-timer" data-testid="drop-timer">${app.armDrop ? "确认放掉" : "放掉这次计时"}</button>`;
  }

  function shrinkTwo() {
    if (!state.active || state.active.phase !== "focus" || state.active.timeUp) return;
    const next = Logic.shrinkActive(state.active, 2 * 60, Date.now());
    if (next === state.active) return;
    state.active = next;
    persist();
    paint();
  }

  function splitStep(goalId, stepId) {
    const goal = goalById(goalId);
    const step = findStep(goal, stepId);
    if (!goal || !step || step.status !== "pending" || goal.steps.length >= 30) return;
    const opener = Logic.splitOpener(step);
    if (!opener) return;
    const index = goal.steps.findIndex((item) => item.id === step.id);
    if (index < 0) return;
    goal.steps.splice(index, 0, opener);
    goal.updatedAt = Date.now();
    persist();
    paint();
  }

  function shortenFive(goalId, stepId) {
    const goal = goalById(goalId);
    const step = findStep(goal, stepId);
    if (!goal || !step || step.status !== "pending") return;
    if (Logic.stepMinutes(step, state.settings) <= 5) return;
    step.minutes = 5;
    goal.updatedAt = Date.now();
    const active = state.active;
    if (active && active.phase === "focus" && active.goalId === goalId && active.stepId === stepId && !active.timeUp) {
      state.active = Logic.shrinkActive(active, 5 * 60, Date.now());
    }
    persist();
    paint();
  }

  function dropTimer() {
    if (!state.active) return;
    if (!app.armDrop) {
      app.armDrop = true;
      paint();
      return;
    }
    app.armDrop = false;
    state.active = null;
    persist();
    go("home");
  }

  function startTiny(title) {
    const goal = Logic.tinyGoal(title, Date.now());
    if (!goal) {
      app.tinyError = "先写这一件小事。";
      paint();
      return;
    }
    state.goals.unshift(goal);
    state.seeded = true;
    app.tinyError = "";
    persist();
    requestStart(goal.id, goal.steps[0].id);
  }

  function togglePause() {
    const active = state.active;
    if (!active || active.timeUp) return;
    state.active = active.running ? Logic.pauseActive(active, Date.now()) : Logic.resumeActive(active, Date.now());
    if (state.active.running) ensureAudio();
    persist();
    paint();
  }

  function leaveFocus() {
    if (state.notice && !state.active) {
      state.notice = null;
      persist();
      go("home");
      return;
    }
    if (state.active && state.active.running && !state.active.timeUp) {
      state.active = Logic.pauseActive(state.active, Date.now());
      persist();
    }
    go("home");
  }

  function catchUp(chime) {
    const active = state.active;
    if (!active || !active.running) return false;
    const result = Logic.catchUpActive(active, Date.now());
    if (!result.expired) return false;
    if (result.active.phase === "break") {
      state.active = result.active;
      endBreak(true);
    } else {
      state.active = result.active;
      persist();
      if (app.view === "editor") app.timerBanner = "专注时间到了。这一步可以收工，也可以再续 5 分钟。";
      paint();
    }
    if (chime) playChime();
    return true;
  }

  function otherPendingGoal(excludeId) {
    return state.goals.find((goal) => goal.id !== excludeId && Logic.goalStats(goal, state.settings).pending > 0) || null;
  }

  function renderShell(content) {
    const view = app.view;
    const titles = { home: "今日", progress: "进度", settings: "设置", focus: "专注", editor: "编辑" };
    document.title = `${titles[view] || "碎步"} · 碎步`;
    const nav = ["home", "progress", "settings"]
      .map((item) => {
        const label = { home: "今日", progress: "进度", settings: "设置" }[item];
        const current = view === item ? ' aria-current="page"' : "";
        return `<a href="${hashFor(item)}"${current}>${label}</a>`;
      })
      .join("");
    const dialog = app.dialog ? renderDialog() : "";
    return `<div class="app ${view === "focus" ? "app-focus" : ""}">
      <header class="top">
        <div class="top-inner">
          <a class="brand" href="#/">${logoHtml()}碎步</a>
          <nav class="nav">${nav}</nav>
        </div>
      </header>
      <main class="main" id="main">${content}</main>
      ${dialog}
    </div>`;
  }

  function renderDialog() {
    const dialog = app.dialog;
    return `<div class="scrim" data-action="dialog-cancel" role="presentation">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">${esc(dialog.title)}</h2>
        <p>${esc(dialog.body)}</p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-action="dialog-cancel">取消</button>
          <button type="button" class="btn ${dialog.danger ? "btn-danger" : "btn-primary"}" data-action="dialog-confirm">${esc(dialog.confirm)}</button>
        </div>
      </div>
    </div>`;
  }

  function renderHome() {
    const now = Date.now();
    const goal = currentGoal();
    const active = state.active;
    const warmth = Logic.warmth(state.log, now);
    const streak = Logic.computeStreak(state.log, now);
    const banner = [];
    if (app.storageError) banner.push(`<p class="form-error" role="alert">${esc(app.storageError)}</p>`);
    if (state.notice && !active) {
      banner.push(`<div class="banner"><p>刚刚处理了「${esc(state.notice.stepTitle)}」。</p><span><a href="#/focus">查看</a> <button type="button" class="btn btn-quiet" data-action="dismiss-notice">知道了</button></span></div>`);
    }
    const hero = renderHero(goal, active);
    const steps = goal ? renderStepList(goal, active) : "";
    const quick = goal
      ? `<form class="quick" data-action="quick-add">
          <input data-field="quick-title" name="title" maxlength="80" autocomplete="off" placeholder="再加一个很短的步骤，例如：只写开头一句" aria-label="新步骤" />
          <div class="quick-actions">
            <button class="btn btn-ghost" type="submit" name="mode" value="add">添加</button>
            <button class="btn btn-primary" type="submit" name="mode" value="start" data-testid="quick-start">添加并开始</button>
          </div>
        </form>${app.quickError ? `<p class="form-error" data-quick-error role="alert">${esc(app.quickError)}</p>` : ""}`
      : "";
    const others = state.goals.filter((item) => !goal || item.id !== goal.id);
    const sideGoals = state.goals.length
      ? `<section class="card"><h2>大目标</h2><div class="goal-list">${renderGoalChip(goal, true)}${others.map((item) => renderGoalChip(item, false)).join("")}</div></section>`
      : "";
    const interest = `<section class="card interest">
      <h2>兴趣</h2>
      <p class="interest-label">${esc(warmth.label)}</p>
      ${heatHtml(warmth)}
      <p class="small">${esc(warmth.hint)}</p>
      <p class="small muted">${streak.days > 0 ? `连续 ${streak.days} 天${streak.aliveToday ? "，今天已接上" : "，到昨天为止"}` : "还没有连续天数。完成一步就会开始。"}</p>
    </section>`;
    return `${banner.join("")}
      <section class="intro">
        <p class="kicker">${esc(new Date(now).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }))}</p>
        <h1>${greeting(now)}</h1>
        <p class="lede">${esc(dailyLine(now))}</p>
      </section>
      <div class="layout">
        <div class="stack" data-testid="today-view">
          ${hero}
          ${goal ? `<section class="card"><div class="goal-head"><div><h2>步骤</h2>${segmentsHtml(goal)}</div><button type="button" class="btn btn-quiet" data-action="open-edit" data-id="${esc(goal.id)}">编辑目标</button></div>${steps}</section>${quick}` : ""}
        </div>
        <aside class="stack">
          ${interest}
          ${sideGoals}
          <section class="card" data-testid="tiny-card">
            <h2>只有一点点兴趣</h2>
            <p class="hint">不必先写完整的大目标。记一件 5 分钟的小事，马上开始。</p>
            <form class="quick" data-action="tiny-start">
              <input name="title" maxlength="60" autocomplete="off" placeholder="例如：只把杯子洗了" aria-label="一件小事" data-field="tiny-title" />
              <button class="btn btn-ghost" type="submit">记下来并开始</button>
            </form>
            ${app.tinyError ? `<p class="form-error" data-tiny-error role="alert">${esc(app.tinyError)}</p>` : ""}
          </section>
          <button type="button" class="btn btn-ghost" data-action="open-new" data-testid="new-goal">新建大目标</button>
        </aside>
      </div>
      <p class="footer">数据只在这台浏览器里，键名 suibu.v1。没有账号。</p>`;
  }

  function renderHero(goal, active) {
    if (!goal && !active) {
      return `<section class="card hero"><p class="kicker">从这里开始</p><h1>先写一个一直拖着的大目标</h1><p class="reassure">再把它拆成几件 10 分钟内能停下来的小事。短到失去兴趣之前就做完。</p><button type="button" class="btn btn-primary" data-action="open-new">写下第一个大目标</button></section>`;
    }
    if (active) {
      const activeGoal = goalById(active.goalId);
      const step = findStep(activeGoal, active.stepId);
      const left = Logic.remainingSeconds(active, Date.now());
      const mins = Math.round(active.plannedSec / 60);
      if (active.phase === "break") {
        return `<section class="card hero"><p class="kicker">正在休息</p><h1 data-clock>${formatClock(left)}</h1><p class="reassure">休息结束不会自动开始下一步。</p><div class="actions"><a class="btn btn-primary" href="#/focus">回到休息</a></div></section>`;
      }
      const title = step ? step.title : "当前步骤";
      const status = active.timeUp ? "时间到了" : active.running ? "专注进行中" : "专注已暂停";
      const button = active.timeUp
        ? `<a class="btn btn-moss" href="#/focus">去收工</a>`
        : `<a class="btn btn-primary" href="#/focus">回到专注</a>${dropTimerButton()}`;
      return `<section class="card hero" data-testid="active-hero"><p class="kicker">${esc(status)} · ${esc(activeGoal ? activeGoal.title : "")}</p><h1>${esc(title)}</h1><p class="meta"><span data-clock>${formatClock(left)}</span> · 计划 ${mins} 分钟</p><div class="actions">${button}</div></section>`;
    }
    const stats = Logic.goalStats(goal, state.settings);
    if (!stats.next) {
      const other = otherPendingGoal(goal.id);
      return `<section class="card hero"><p class="kicker">${esc(goal.title)}</p><h1>这个大目标的步骤都走完了</h1><p class="reassure">完成 ${stats.done} 步${stats.skipped ? `，跳过 ${stats.skipped} 步` : ""}。可以再加一个更小的下一步，也可以换一个目标。</p><div class="actions"><button type="button" class="btn btn-primary" data-action="open-edit" data-id="${esc(goal.id)}">再加一步</button>${other ? `<button type="button" class="btn btn-ghost" data-action="select-goal" data-id="${esc(other.id)}">去看「${esc(other.title)}」</button>` : ""}</div></section>`;
    }
    const mins = Logic.stepMinutes(stats.next, state.settings);
    const index = goal.steps.findIndex((step) => step.id === stats.next.id) + 1;
    const short = Logic.shortestPending(state.goals, state.settings);
    const shorter = short && short.step.id !== stats.next.id && short.mins < mins
      ? `<button type="button" class="btn btn-ghost" data-action="start-step" data-goal="${esc(short.goal.id)}" data-step="${esc(short.step.id)}">改做更短的 · ${short.mins} 分钟</button>`
      : "";
    const shorterHint = shorter ? `<p class="hint">更短的一步是「${esc(short.step.title)}」。</p>` : "";
    const cue = Logic.returnCue(Logic.warmth(state.log, Date.now()).label);
    return `<section class="card hero"><p class="kicker">当前一步 · ${esc(goal.title)}</p><h1 data-testid="step-title">${esc(stats.next.title)}</h1>${cue ? `<p class="hint" data-testid="return-cue">${esc(cue)}</p>` : ""}<p class="meta">约 ${mins} 分钟 · 第 ${index} 步，共 ${stats.total} 步</p>${segmentsHtml(goal)}<p class="reassure" data-testid="next-line">${esc(Logic.nextStepLine(stats.pending, mins))}</p><div class="actions"><button type="button" class="btn btn-primary" data-testid="start-focus" data-action="start-step" data-goal="${esc(goal.id)}" data-step="${esc(stats.next.id)}">开始这 ${mins} 分钟</button>${shorter}</div>${shorterHint}</section>`;
  }

  function finishedLabel(goal) {
    const done = goal.steps.filter((step) => step.status === "done").length;
    const skipped = goal.steps.filter((step) => step.status === "skipped").length;
    const parts = [];
    if (done) parts.push(`已完成 ${done} 步`);
    if (skipped) parts.push(`跳过 ${skipped} 步`);
    return parts.join("，");
  }

  function renderStepList(goal, active) {
    const stats = Logic.goalStats(goal, state.settings);
    const finished = finishedLabel(goal);
    const visible = !finished || app.showFinished ? goal.steps : goal.steps.filter((step) => step.status === "pending");
    const toggle = finished
      ? `<button type="button" class="btn btn-quiet done-toggle" data-action="toggle-finished" data-testid="toggle-finished" aria-expanded="${app.showFinished}">${app.showFinished ? "收起已完成" : `${esc(finished)}，点开看看`}</button>`
      : "";
    return `${toggle}<ol class="steps">${visible
      .map((step) => {
        const mins = Logic.stepMinutes(step, state.settings);
        const isNext = stats.next && stats.next.id === step.id;
        const isActive = active && active.stepId === step.id && active.phase === "focus";
        const markClass = step.status === "done" ? "mark mark-done" : step.status === "skipped" ? "mark mark-skip" : isNext ? "mark mark-next" : "mark";
        const markText = step.status === "done" ? "✓" : step.status === "skipped" ? "–" : "";
        let side = `<span class="muted small">${mins} 分钟</span>`;
        if (step.status === "pending") {
          const shorten = mins > 5
            ? `<button type="button" class="btn btn-quiet" data-action="shorten-5" data-testid="shorten-5" data-goal="${esc(goal.id)}" data-step="${esc(step.id)}">改成 5 分钟</button>`
            : "";
          const canSplit = goal.steps.length < 30 && (step.title.trim().length >= 16 || mins >= 10);
          const split = canSplit
            ? `<button type="button" class="btn btn-quiet" data-action="split-step" data-testid="split-step" data-goal="${esc(goal.id)}" data-step="${esc(step.id)}">拆一个更小的开头</button>`
            : "";
          side += isActive
            ? `<a class="btn btn-ghost" href="#/focus">进行中</a>${split}`
            : `<button type="button" class="btn btn-ghost" data-action="start-step" data-goal="${esc(goal.id)}" data-step="${esc(step.id)}">开始</button>${shorten}${split}`;
        } else {
          side = `<span class="muted small">${step.status === "done" ? "已完成" : "已跳过"}${step.completedAt ? ` · ${esc(formatWhen(step.completedAt))}` : ""}</span>`;
        }
        return `<li class="step ${step.status === "done" ? "is-done" : ""} ${isNext ? "is-next" : ""}">
          <span class="${markClass}" aria-hidden="true">${markText}</span>
          <div><p class="step-title">${esc(step.title)}</p></div>
          <div class="step-side">${side}</div>
        </li>`;
      })
      .join("")}</ol>`;
  }

  function renderGoalChip(goal, isCurrent) {
    if (!goal) return "";
    const stats = Logic.goalStats(goal, state.settings);
    return `<div class="goal-chip ${isCurrent ? "is-current" : ""}">
      <button type="button" class="as-text" data-action="select-goal" data-id="${esc(goal.id)}">
        <span class="chip-title">${esc(goal.title)}</span>
        <span class="chip-sub">${stats.done}/${stats.total} 步完成${goal.why ? ` · ${esc(goal.why)}` : ""}</span>
      </button>
      <button type="button" class="btn btn-quiet" data-action="open-edit" data-id="${esc(goal.id)}">编辑</button>
      ${segmentsHtml(goal)}
    </div>`;
  }

  function renderProgress() {
    const now = Date.now();
    const overall = Logic.overallStats(state.goals);
    const warmth = Logic.warmth(state.log, now);
    const streak = Logic.computeStreak(state.log, now);
    const series = Logic.dailySeries(state.log, 14, now);
    const sum = series.days.reduce((total, day) => total + day.count, 0);
    const bars = series.days
      .map((day) => {
        const height = day.count === 0 || series.max === 0 ? 8 : Math.max(18, Math.round((day.count / series.max) * 100));
        return `<div class="bar ${day.count ? "has" : ""} ${day.isToday ? "today" : ""}" title="${esc(day.label)} ${day.count} 步"><b><i style="height:${height}%"></i></b><span>${day.isToday ? "今" : esc(day.label)}</span></div>`;
      })
      .join("");
    const today = Logic.todayDone(state.log, now);
    const todayHtml = today.length
      ? `<ol class="today-list">${today
          .map(
            (entry) =>
              `<li><strong>${esc(entry.stepTitle)}</strong><span class="muted small">${esc(entry.goalTitle)} · ${esc(formatWhen(entry.at))}</span></li>`
          )
          .join("")}</ol>`
      : `<p>今天还没有。任意一小步都会出现在这里。</p>`;
    const last = state.log[state.log.length - 1];
    const lastHtml = last
      ? `<section class="card" data-testid="last-session"><h2>上一次专注</h2><p><strong>${last.outcome === "done" ? "完成了" : "跳过了"}「${esc(last.stepTitle)}」</strong></p><p class="muted">${esc(formatWhen(last.at))} · ${esc(last.goalTitle)}</p><p>计划 ${formatSpent(last.plannedSec)}，实际 ${formatSpent(last.elapsedSec)}。${last.outcome === "skipped" ? "这次不计入完成度。" : ""}</p></section>`
      : `<section class="card" data-testid="last-session"><h2>上一次专注</h2><p>还没有完成过专注。从今日里开始第一步就好。</p></section>`;
    const goals = state.goals.length
      ? state.goals
          .map((goal) => {
            const stats = Logic.goalStats(goal, state.settings);
            return `<div class="goal-line"><div class="row-between"><strong>${esc(goal.title)}</strong><span class="muted small">${stats.pct}%</span></div><div class="track" aria-hidden="true"><span style="width:${stats.pct}%"></span></div><p class="small muted">完成 ${stats.done} · 跳过 ${stats.skipped} · 还剩 ${stats.pending}</p>${segmentsHtml(goal)}<button type="button" class="btn btn-quiet" data-action="select-goal" data-id="${esc(goal.id)}">在今日打开</button></div>`;
          })
          .join("")
      : `<p>还没有大目标。</p>`;
    const streakHint = streak.days === 0
      ? "完成任意一步，连续天数就从今天开始。"
      : streak.aliveToday
        ? "今天已经接上了。"
        : "连续到昨天。今天再完成一步就能接上。";
    const suggested = Logic.suggestedNext(state.goals, state.currentGoalId, state.settings);
    const nextCard = suggested
      ? `<section class="card" data-testid="next-from-progress" style="margin-top:0.9rem"><h2>下一次只要这一步</h2><p><strong>${esc(suggested.step.title)}</strong></p><p class="muted small">${esc(suggested.goal.title)} · ${suggested.mins} 分钟</p><p class="hint">不必把后面的都排进今天。从这一步开始就够了。</p><button type="button" class="btn btn-primary" data-action="start-step" data-goal="${esc(suggested.goal.id)}" data-step="${esc(suggested.step.id)}" data-testid="start-suggested">开始这 ${suggested.mins} 分钟</button></section>`
      : "";
    return `<section data-testid="progress-view">
      <div class="intro"><p class="kicker">看见没有放弃</p><h1>进度</h1><p class="lede">完成度只计算真正做完的步骤。跳过会留下来，但不会假装它已经完成。</p></div>
      <div class="stats">
        <article class="card stat"><p class="kicker">完成度</p><strong data-testid="progress-pct">${overall.pct}%</strong><p class="small muted">${overall.done}/${overall.total} 步完成，还剩 ${overall.pending}</p></article>
        <article class="card stat"><p class="kicker">连续天数</p><strong>${streak.days}</strong><p class="small muted">${esc(streakHint)}</p></article>
        <article class="card stat"><p class="kicker">兴趣温度</p><strong>${esc(warmth.label)}</strong>${heatHtml(warmth)}<p class="small muted">${esc(warmth.hint)}</p></article>
      </div>
      ${nextCard}
      <section class="card" style="margin-top:0.9rem" data-testid="today-done">
        <h2>今天落地的小步</h2>
        ${todayHtml}
      </section>
      <section class="card" style="margin-top:0.9rem">
        <h2>近 14 天完成的步数</h2>
        <div class="chart" data-testid="chart" role="img" aria-label="近 14 天共完成 ${sum} 步">${bars}</div>
        ${sum === 0 ? `<p class="hint">完成一步之后，今天这根柱子会立起来。</p>` : `<p class="hint">这 14 天一共完成 ${sum} 步。</p>`}
      </section>
      <div class="layout" style="margin-top:0.9rem">
        ${lastHtml}
        <section class="card"><h2>每个大目标</h2>${goals}</section>
      </div>
    </section>`;
  }

  function renderSettings() {
    const focus = Logic.FOCUS_CHOICES.map((mins) => `<button type="button" class="btn btn-ghost" data-action="set-focus" data-value="${mins}" aria-pressed="${state.settings.focusMinutes === mins}">${mins} 分钟</button>`).join("");
    const breaks = Logic.BREAK_CHOICES.map((mins) => `<button type="button" class="btn btn-ghost" data-action="set-break" data-value="${mins}" aria-pressed="${state.settings.breakMinutes === mins}">${mins === 0 ? "不休息" : `${mins} 分钟`}</button>`).join("");
    return `<section class="editor" data-testid="settings-view">
      <div class="intro"><p class="kicker">让一步保持很短</p><h1>设置</h1><p class="lede">默认时长只影响还没单独设过分钟数的步骤。已经开始的计时不会中途改掉。</p></div>
      <section class="card">
        <p class="choice-label">默认专注时长</p>
        <div class="choices" style="margin:0.6rem 0 1rem">${focus}</div>
        <p class="choice-label">做完一步之后的休息</p>
        <p class="hint">休息结束不会自动开始下一步。你可以回来，也可以今天就停。</p>
        <div class="choices" style="margin:0.6rem 0 1rem">${breaks}</div>
        <div class="switch">
          <div><p class="choice-label">时间到时响一声</p><p class="hint">很轻的两声。浏览器如果拦截声音，界面上的提示仍然在。</p></div>
          <button type="button" class="btn btn-ghost" data-action="toggle-sound" aria-pressed="${state.settings.sound}">${state.settings.sound ? "开" : "关"}</button>
        </div>
      </section>
      <section class="card" style="margin-top:0.9rem">
        <h2>本地数据</h2>
        <p>目标、步骤和专注记录都在这台浏览器的 localStorage（suibu.v1）。清除站点数据、换浏览器或无痕窗口，都会看不到它们。</p>
        <button type="button" class="btn btn-danger" data-action="ask-reset">清空并恢复示例</button>
      </section>
    </section>`;
  }

  function renderEditor() {
    const draft = app.draft;
    if (!draft) return `<p>没有正在编辑的目标。</p>`;
    const heading = draft.goalId ? "编辑大目标" : "新建大目标";
    const steps = draft.steps
      .map((step, index) => {
        const options = [`<option value="" ${step.minutes == null ? "selected" : ""}>默认（${state.settings.focusMinutes} 分钟）</option>`]
          .concat(Logic.FOCUS_CHOICES.map((mins) => `<option value="${mins}" ${Number(step.minutes) === mins ? "selected" : ""}>${mins} 分钟</option>`))
          .join("");
        const status = step.status === "done" ? "已完成" : step.status === "skipped" ? "已跳过" : "未开始";
        const longHidden = !(Number(step.minutes) === 25 || (step.minutes == null && state.settings.focusMinutes === 25));
        return `<div class="step-edit">
          <div class="step-edit-top"><strong>第 ${index + 1} 步 · ${status}</strong><span>
            <button type="button" class="btn btn-quiet" data-action="move-step" data-dir="up" data-id="${esc(step.id)}" ${index === 0 ? "disabled" : ""}>上移</button>
            <button type="button" class="btn btn-quiet" data-action="move-step" data-dir="down" data-id="${esc(step.id)}" ${index === draft.steps.length - 1 ? "disabled" : ""}>下移</button>
            <button type="button" class="btn btn-quiet" data-action="remove-step" data-id="${esc(step.id)}">删除</button>
          </span></div>
          <input data-field="step-title" data-id="${esc(step.id)}" maxlength="80" value="${esc(step.title)}" placeholder="${esc(["例如：只打开文档，写下一句话", "例如：把要处理的东西分成两堆", "例如：做一个 5 分钟就能停的最小版本"][index % 3])}" aria-label="第 ${index + 1} 步" />
          <p class="hint warn" data-len-hint ${step.title.trim().length > 36 ? "" : "hidden"}>标题有点长。越像一句动作，越容易开始。</p>
          <div class="minutes-row"><select data-field="step-minutes" data-id="${esc(step.id)}" aria-label="第 ${index + 1} 步时长">${options}</select>${step.status !== "pending" ? `<button type="button" class="btn btn-ghost" data-action="revert-step" data-id="${esc(step.id)}">恢复为未完成</button>` : ""}</div>
          <p class="hint warn" data-long-hint ${longHidden ? "hidden" : ""}>25 分钟对容易失去兴趣的人有点长。能再拆开的话，完成率会更高。</p>
        </div>`;
      })
      .join("");
    return `<form class="editor" data-action="save-goal" data-testid="editor">
      <div class="intro"><p class="kicker">拆短，短到还能做完</p><h1>${heading}</h1></div>
      ${app.formError ? `<p class="form-error" role="alert">${esc(app.formError)}</p>` : ""}
      ${app.timerBanner ? `<p class="banner">${esc(app.timerBanner)} <a href="#/focus">去处理</a></p>` : ""}
      <section class="card">
        <label class="field"><span>大目标</span><input data-field="goal-title" maxlength="60" value="${esc(draft.title)}" placeholder="例如：准备下周的小分享" /></label>
        <label class="field"><span>为什么想做（可选）</span><textarea data-field="goal-why" maxlength="120" placeholder="一句话就好。写给失去兴趣时的自己。">${esc(draft.why)}</textarea></label>
        <h2>很短的步骤</h2>
        <p class="hint">一步最好短到 5–15 分钟。短到你还没失去兴趣，它就已经做完。</p>
        ${steps}
        <button type="button" class="btn btn-ghost" data-action="add-step" ${draft.steps.length >= 30 ? "disabled" : ""}>添加一步</button>
        ${draft.steps.length > 8 ? `<p class="hint warn">步骤一多，又会变成大任务。能合并，或另开一个目标吗？</p>` : ""}
        <div class="actions" style="margin-top:1rem">
          <button type="submit" class="btn btn-primary" data-testid="save-goal">保存</button>
          <button type="button" class="btn btn-ghost" data-action="cancel-edit">取消</button>
          ${draft.goalId ? `<button type="button" class="btn btn-danger" data-action="ask-delete">删除这个目标</button>` : ""}
        </div>
      </section>
    </form>`;
  }

  function ringHtml(active) {
    const r = 52;
    const circ = 2 * Math.PI * r;
    const left = Logic.remainingSeconds(active, Date.now());
    const progress = active.plannedSec ? (active.plannedSec - left) / active.plannedSec : 0;
    const offset = circ * (1 - Math.min(1, Math.max(0, progress)));
    return `<div class="timer-wrap ${active.phase === "break" ? "phase-break" : ""}">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ring-track" cx="60" cy="60" r="${r}"></circle>
        <circle class="ring-value" data-ring data-circ="${circ.toFixed(3)}" cx="60" cy="60" r="${r}" stroke-dasharray="${circ.toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}"></circle>
      </svg>
      <div class="clock" data-clock data-testid="timer" role="timer" aria-label="剩余时间">${formatClock(left)}</div>
    </div>`;
  }

  function renderFocus() {
    if (state.notice && !state.active) return renderNotice(state.notice);
    const active = state.active;
    if (!active) return `<section class="focus"><h1>没有正在进行的专注</h1><a class="btn btn-primary" href="#/">回到今日</a></section>`;
    const goal = goalById(active.goalId);
    const step = findStep(goal, active.stepId);
    if (active.phase === "break") {
      return `<section class="focus phase-break">
        <p class="kicker">休息</p>
        ${ringHtml(active)}
        <h1 class="focus-title">站起来，或者什么都不做</h1>
        <p>休息结束不会自动开始下一步。</p>
        <div class="controls"><button type="button" class="btn btn-ghost" data-action="toggle-pause">${active.running ? "暂停" : "继续"}</button><button type="button" class="btn btn-primary" data-action="end-break">结束休息</button></div>
      </section>`;
    }
    const status = active.timeUp ? "时间到了" : active.running ? "专注中" : "已暂停";
    const left = Logic.remainingSeconds(active, Date.now());
    const shrink = !active.timeUp && left > 120
      ? `<button type="button" class="btn btn-ghost" data-action="shrink-2" data-testid="shrink-2">只再做 2 分钟</button>`
      : "";
    const sheet = active.timeUp
      ? `<div class="sheet"><h2>这一小段时间到了</h2><p>可以收工，也可以再续 5 分钟。兴趣还在的时候停，这一步也算落地。</p><div class="controls"><button type="button" class="btn btn-moss" data-action="complete-step" data-testid="complete-step">完成这一步</button><button type="button" class="btn btn-primary" data-action="extend-5">再续 5 分钟</button><button type="button" class="btn btn-ghost" data-action="ask-skip">跳过</button></div></div>`
      : `<p class="soon" data-soon ${left <= 60 ? "" : "hidden"}>还不到 1 分钟。做完就可以停。</p>
        <p class="soon" data-half hidden>已经过了一半。停在这里也算做了。</p>
        <div class="controls">
          <button type="button" class="btn btn-moss" data-action="complete-step" data-testid="complete-step">这一步完成</button>
          ${shrink}
          <button type="button" class="btn btn-ghost" data-action="toggle-pause">${active.running ? "暂停" : "继续"}</button>
          ${dropTimerButton()}
          <button type="button" class="btn btn-quiet" data-action="ask-skip">跳过</button>
        </div>
        <button type="button" class="btn btn-quiet" data-action="leave-focus">${active.running ? "暂停并离开" : "回到今日"}</button>
        <p class="keys">空格暂停或继续 · Esc 离开</p>`;
    return `<section class="focus" data-testid="focus-view">
      <p class="kicker">${esc(status)}${goal ? ` · ${esc(goal.title)}` : ""}</p>
      ${ringHtml(active)}
      <h1 class="focus-title">${esc(step ? step.title : "这一步")}</h1>
      ${goal && goal.why ? `<p class="focus-why">${esc(goal.why)}</p>` : ""}
      <p>后面的步骤先不用看。这一步结束就可以停。</p>
      ${sheet}
    </section>`;
  }

  function renderNotice(notice) {
    const goal = goalById(notice.goalId);
    const stats = goal ? Logic.goalStats(goal, state.settings) : null;
    const next = stats && stats.next ? stats.next : null;
    const pending = stats ? stats.pending : notice.pendingCount;
    const nextTitle = next ? next.title : notice.nextStepTitle;
    const nextMinutes = next ? Logic.stepMinutes(next, state.settings) : notice.nextMinutes;
    const nextId = next ? next.id : notice.nextStepId;
    const mark = notice.type === "step-skip" ? "done-mark skip" : notice.type === "break-done" ? "done-mark rest" : "done-mark";
    const heading = notice.type === "step-skip" ? "先跳过这一步" : notice.type === "break-done" ? "休息结束了" : pending === 0 ? "这个大目标的步骤都走完了" : "这一步完成了";
    let detail = "";
    if (notice.type === "step-done") {
      detail = `<p>「${esc(notice.stepTitle)}」${esc(Logic.describeElapsed(notice.elapsedSec))}</p>`;
      detail += goal ? segmentsHtml(goal) : "";
      detail += pending > 0 && nextTitle
        ? `<p>「${esc(notice.goalTitle)}」还剩 ${pending} 步。下一步是「${esc(nextTitle)}」，大约 ${nextMinutes} 分钟。</p>`
        : `<p>「${esc(notice.goalTitle)}」的步骤都走完了。你是用很多个短瞬间做完的。</p>`;
    } else if (notice.type === "step-skip") {
      detail = `<p>「${esc(notice.stepTitle)}」先放着。${nextTitle ? `下一步是「${esc(nextTitle)}」。` : ""}</p>`;
    } else if (nextTitle) {
      detail = `<p>下一步是「${esc(nextTitle)}」，大约 ${nextMinutes} 分钟。</p>`;
    }
    const other = goal ? otherPendingGoal(goal.id) : otherPendingGoal(null);
    const buttons = [];
    if (notice.type === "step-done") {
      buttons.push(`<button type="button" class="btn btn-primary" data-action="dismiss-notice" data-testid="stop-today">今天先停在这里</button>`);
      if (state.settings.breakMinutes > 0) {
        buttons.push(`<button type="button" class="btn btn-ghost" data-action="start-break">休息 ${state.settings.breakMinutes} 分钟</button>`);
      }
      if (nextId && goal) {
        buttons.push(`<button type="button" class="btn btn-ghost" data-action="start-step" data-goal="${esc(goal.id)}" data-step="${esc(nextId)}">再做下一步</button>`);
      } else if (other) {
        buttons.push(`<button type="button" class="btn btn-ghost" data-action="select-goal" data-id="${esc(other.id)}">接着看「${esc(other.title)}」</button>`);
      }
      if (pending === 0 && goal) buttons.push(`<a class="btn btn-ghost" href="#/progress">看看进度</a>`);
    } else {
      if (nextId && goal) {
        buttons.push(`<button type="button" class="btn btn-primary" data-action="start-step" data-goal="${esc(goal.id)}" data-step="${esc(nextId)}">开始下一步</button>`);
      } else if (other) {
        buttons.push(`<button type="button" class="btn btn-primary" data-action="select-goal" data-id="${esc(other.id)}">接着看「${esc(other.title)}」</button>`);
      }
      if (pending === 0 && goal) buttons.push(`<a class="btn btn-ghost" href="#/progress">看看进度</a>`);
      buttons.push(`<button type="button" class="btn btn-quiet" data-action="dismiss-notice">回到今日</button>`);
    }
    return `<section class="focus" data-testid="notice">
      <div class="${mark}" aria-hidden="true"></div>
      <div class="sheet">
        <p class="kicker">${esc(notice.goalTitle)}</p>
        <h1>${heading}</h1>
        <p>${esc(notice.line || "")}</p>
        ${detail}
        <div class="controls">${buttons.join("")}</div>
      </div>
    </section>`;
  }

  function render() {
    if (app.view === "progress") return renderProgress();
    if (app.view === "settings") return renderSettings();
    if (app.view === "editor") return renderEditor();
    if (app.view === "focus") return renderFocus();
    return renderHome();
  }

  function patchTimer() {
    const active = state.active;
    if (!active) return;
    const left = Logic.remainingSeconds(active, Date.now());
    const text = formatClock(left);
    document.querySelectorAll("[data-clock]").forEach((el) => {
      if (el.textContent !== text) el.textContent = text;
    });
    const circ = 2 * Math.PI * 52;
    const progress = active.plannedSec ? (active.plannedSec - left) / active.plannedSec : 0;
    const offset = String(circ * (1 - Math.min(1, Math.max(0, progress))));
    document.querySelectorAll("[data-ring]").forEach((el) => el.setAttribute("stroke-dashoffset", offset));
    document.querySelectorAll("[data-soon]").forEach((el) => {
      el.hidden = left > 60;
    });
    document.querySelectorAll("[data-half]").forEach((el) => {
      el.hidden = progress < 0.5 || left <= 60;
    });
  }

  function paint() {
    const root = document.getElementById("app");
    try {
      root.innerHTML = renderShell(render());
    } catch (error) {
      console.error(error);
      root.innerHTML = `<div class="fatal"><h1>界面渲染出错了</h1><p>可以清除这台浏览器里的碎步数据后刷新。</p><button type="button" id="wipe">清除本地数据并刷新</button></div>`;
      document.getElementById("wipe").addEventListener("click", () => {
        localStorage.removeItem(Store.KEY);
        location.href = "#/";
        location.reload();
      });
      return;
    }
    patchTimer();
    if (app.focusTitle) {
      app.focusTitle = false;
      document.querySelector("[data-field=goal-title]")?.focus();
    } else if (app.focusStepId) {
      const id = app.focusStepId;
      app.focusStepId = null;
      document.querySelector(`[data-field=step-title][data-id="${cssEscape(id)}"]`)?.focus();
    }
    const dialogBtn = document.querySelector(".dialog [data-action=dialog-confirm]");
    if (dialogBtn && !document.querySelector(".dialog")?.contains(document.activeElement)) dialogBtn.focus();
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/"/g, "");
  }

  function syncFromHash() {
    const hash = location.hash || "#/";
    let view = viewFromHash(hash);
    if (view === "editor" && !app.draft) view = "home";
    if (view === "focus" && !state.active && !state.notice) view = "home";
    if (view !== "editor") {
      app.draft = null;
      app.formError = "";
      app.timerBanner = "";
    }
    app.view = view;
    const desired = hashFor(view);
    if ((location.hash || "#/") !== desired) history.replaceState(null, "", desired);
    paint();
  }

  function readDraftFromDom() {
    if (!app.draft) return;
    const title = document.querySelector("[data-field=goal-title]");
    if (!title) return;
    app.draft.title = title.value;
    const why = document.querySelector("[data-field=goal-why]");
    if (why) app.draft.why = why.value;
    app.draft.steps.forEach((step) => {
      const input = document.querySelector(`[data-field=step-title][data-id="${cssEscape(step.id)}"]`);
      const select = document.querySelector(`[data-field=step-minutes][data-id="${cssEscape(step.id)}"]`);
      if (input) step.title = input.value;
      if (select) step.minutes = select.value === "" ? null : Number(select.value);
    });
  }

  function openEditor(goalId) {
    app.formError = "";
    app.timerBanner = "";
    if (goalId) {
      const goal = goalById(goalId);
      if (!goal) return;
      app.draft = {
        goalId: goal.id,
        title: goal.title,
        why: goal.why,
        steps: goal.steps.map((step) => ({ ...step })),
      };
      if (!app.draft.steps.length) app.draft.steps.push(blankStep());
    } else {
      app.draft = { goalId: null, title: "", why: "", steps: [blankStep(), blankStep()] };
    }
    app.focusTitle = true;
    go("editor");
  }

  function saveGoal() {
    readDraftFromDom();
    const draft = app.draft;
    if (!draft) return;
    const title = draft.title.trim();
    const steps = draft.steps
      .map((step) => ({
        id: step.id || Logic.createId(),
        title: step.title.trim().slice(0, 80),
        minutes: Logic.FOCUS_CHOICES.includes(Number(step.minutes)) ? Number(step.minutes) : null,
        status: step.status === "done" || step.status === "skipped" ? step.status : "pending",
        completedAt: step.status === "done" || step.status === "skipped" ? step.completedAt || Date.now() : null,
      }))
      .filter((step) => step.title);
    if (!title) {
      app.formError = "先给大目标起个名字。";
      paint();
      return;
    }
    if (!steps.length) {
      app.formError = "至少写一个很短的步骤。";
      paint();
      return;
    }
    const now = Date.now();
    if (!draft.goalId) {
      const goal = { id: Logic.createId(), title: title.slice(0, 60), why: draft.why.trim().slice(0, 120), createdAt: now, updatedAt: now, steps };
      state.goals.unshift(goal);
      state.currentGoalId = goal.id;
    } else {
      const index = state.goals.findIndex((goal) => goal.id === draft.goalId);
      if (index < 0) return;
      const previous = state.goals[index];
      const pendingIds = new Set(steps.filter((step) => step.status === "pending").map((step) => step.id));
      state.log = state.log.filter((entry) => !(entry.goalId === previous.id && pendingIds.has(entry.stepId)));
      state.goals[index] = {
        ...previous,
        title: title.slice(0, 60),
        why: draft.why.trim().slice(0, 120),
        updatedAt: now,
        steps,
      };
      if (state.active && state.active.goalId === previous.id) {
        const live = steps.find((step) => step.id === state.active.stepId);
        if (!live || (state.active.phase === "focus" && live.status !== "pending")) state.active = null;
      }
      if (state.notice && state.notice.goalId === previous.id) {
        const live = steps.find((step) => step.id === state.notice.stepId);
        if (!live || live.status === "pending") state.notice = null;
      }
      state.currentGoalId = previous.id;
    }
    state.seeded = true;
    app.draft = null;
    app.formError = "";
    persist();
    go("home");
  }

  function deleteGoal(goalId) {
    const goal = goalById(goalId);
    if (!goal) return;
    state.goals = state.goals.filter((item) => item.id !== goalId);
    if (state.currentGoalId === goalId) state.currentGoalId = state.goals[0] ? state.goals[0].id : null;
    if (state.active && state.active.goalId === goalId) state.active = null;
    if (state.notice && state.notice.goalId === goalId) state.notice = null;
    state.seeded = true;
    app.draft = null;
    persist();
    go("home");
  }

  function confirmDialog() {
    const dialog = app.dialog;
    app.dialog = null;
    if (!dialog) return;
    if (dialog.kind === "reset") {
      state = Logic.seedState(Date.now());
      app.draft = null;
      persist();
      go("home");
      return;
    }
    if (dialog.kind === "delete-goal") {
      deleteGoal(dialog.goalId);
      return;
    }
    if (dialog.kind === "skip") {
      finishStep("skipped");
      return;
    }
    if (dialog.kind === "switch-step") {
      state.active = null;
      const goal = goalById(dialog.goalId);
      const step = findStep(goal, dialog.stepId);
      if (goal && step) beginFocus(goal, step);
      else {
        persist();
        paint();
      }
    }
  }

  function onClick(event) {
    const scrim = event.target.closest(".scrim");
    if (scrim && event.target === scrim) {
      app.dialog = null;
      paint();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action !== "drop-timer") app.armDrop = false;
    if (action === "dialog-cancel") {
      event.preventDefault();
      app.dialog = null;
      paint();
      return;
    }
    if (action === "dialog-confirm") {
      event.preventDefault();
      confirmDialog();
      return;
    }
    if (action === "open-new") openEditor(null);
    else if (action === "open-edit") openEditor(button.dataset.id);
    else if (action === "select-goal") {
      state.currentGoalId = button.dataset.id;
      state.notice = null;
      persist();
      go("home");
    } else if (action === "start-step") requestStart(button.dataset.goal, button.dataset.step);
    else if (action === "toggle-pause") togglePause();
    else if (action === "leave-focus" || action === "dismiss-notice") leaveFocus();
    else if (action === "complete-step") finishStep("done");
    else if (action === "ask-skip") {
      const step = state.active ? findStep(goalById(state.active.goalId), state.active.stepId) : null;
      app.dialog = {
        kind: "skip",
        title: "跳过这一步？",
        body: step ? `「${step.title}」不会计入完成度。之后可以在编辑里把它恢复成未完成。` : "跳过不会计入完成度。",
        confirm: "跳过",
        danger: true,
      };
      paint();
    } else if (action === "extend-5") extendFive();
    else if (action === "shrink-2") shrinkTwo();
    else if (action === "shorten-5") shortenFive(button.dataset.goal, button.dataset.step);
    else if (action === "split-step") splitStep(button.dataset.goal, button.dataset.step);
    else if (action === "drop-timer") dropTimer();
    else if (action === "toggle-finished") {
      app.showFinished = !app.showFinished;
      paint();
    } else if (action === "start-break") startBreak();
    else if (action === "end-break") endBreak(false);
    else if (action === "add-step") {
      readDraftFromDom();
      if (app.draft.steps.length >= 30) return;
      const step = blankStep();
      app.draft.steps.push(step);
      app.focusStepId = step.id;
      paint();
    } else if (action === "remove-step") {
      readDraftFromDom();
      app.draft.steps = app.draft.steps.filter((step) => step.id !== button.dataset.id);
      if (!app.draft.steps.length) app.draft.steps.push(blankStep());
      paint();
    } else if (action === "move-step") {
      readDraftFromDom();
      const steps = app.draft.steps;
      const index = steps.findIndex((step) => step.id === button.dataset.id);
      const next = button.dataset.dir === "up" ? index - 1 : index + 1;
      if (index < 0 || next < 0 || next >= steps.length) return;
      const [item] = steps.splice(index, 1);
      steps.splice(next, 0, item);
      paint();
    } else if (action === "revert-step") {
      readDraftFromDom();
      const step = app.draft.steps.find((item) => item.id === button.dataset.id);
      if (!step) return;
      step.status = "pending";
      step.completedAt = null;
      paint();
    } else if (action === "cancel-edit") {
      app.draft = null;
      go("home");
    } else if (action === "ask-delete") {
      const goal = goalById(app.draft.goalId);
      app.dialog = {
        kind: "delete-goal",
        goalId: app.draft.goalId,
        title: "删除这个大目标？",
        body: goal ? `「${goal.title}」会从列表里消失。已经完成的记录仍留在进度里。` : "这个目标会从列表里消失。",
        confirm: "删除",
        danger: true,
      };
      paint();
    } else if (action === "set-focus") {
      state.settings.focusMinutes = Number(button.dataset.value);
      persist();
      paint();
    } else if (action === "set-break") {
      state.settings.breakMinutes = Number(button.dataset.value);
      persist();
      paint();
    } else if (action === "toggle-sound") {
      state.settings.sound = !state.settings.sound;
      if (state.settings.sound) ensureAudio();
      persist();
      paint();
    } else if (action === "ask-reset") {
      app.dialog = {
        kind: "reset",
        title: "清空并恢复示例？",
        body: "现在的目标、步骤和专注记录会被三个示例替换。此操作只影响这台浏览器。",
        confirm: "恢复示例",
        danger: true,
      };
      paint();
    }
  }

  function onInput(event) {
    const target = event.target;
    if (target.matches("[data-field=quick-title]") && app.quickError) {
      app.quickError = "";
      document.querySelector("[data-quick-error]")?.remove();
    }
    if (target.matches("[data-field=tiny-title]") && app.tinyError) {
      app.tinyError = "";
      document.querySelector("[data-tiny-error]")?.remove();
    }
    if (!app.draft) return;
    if (target.dataset.field === "goal-title") app.draft.title = target.value;
    if (target.dataset.field === "goal-why") app.draft.why = target.value;
    if (target.dataset.field === "step-title") {
      const step = app.draft.steps.find((item) => item.id === target.dataset.id);
      if (step) step.title = target.value;
      const hint = target.closest(".step-edit")?.querySelector("[data-len-hint]");
      if (hint) hint.hidden = target.value.trim().length <= 36;
    }
  }

  function onChange(event) {
    const target = event.target;
    if (!app.draft || target.dataset.field !== "step-minutes") return;
    const step = app.draft.steps.find((item) => item.id === target.dataset.id);
    if (step) step.minutes = target.value === "" ? null : Number(target.value);
    const hint = target.closest(".step-edit")?.querySelector("[data-long-hint]");
    if (hint) {
      const mins = target.value === "" ? state.settings.focusMinutes : Number(target.value);
      hint.hidden = mins < 25;
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (form.matches("[data-action=quick-add]")) {
      event.preventDefault();
      const goal = currentGoal();
      const data = new FormData(form, event.submitter || undefined);
      const text = String(data.get("title") || "").trim();
      const mode = event.submitter && event.submitter.name === "mode" ? event.submitter.value : data.get("mode");
      if (!goal) return;
      if (!text) {
        app.quickError = "先写这一小步要做什么。";
        paint();
        return;
      }
      if (goal.steps.length >= 30) {
        app.quickError = "这个目标已经有 30 步了。先做完或删掉一步再加。";
        paint();
        return;
      }
      const step = { id: Logic.createId(), title: text.slice(0, 80), minutes: null, status: "pending", completedAt: null };
      goal.steps.push(step);
      goal.updatedAt = Date.now();
      app.quickError = "";
      persist();
      if (mode === "start") {
        requestStart(goal.id, step.id);
        return;
      }
      paint();
      return;
    }
    if (form.matches("[data-action=save-goal]")) {
      event.preventDefault();
      saveGoal();
      return;
    }
    if (form.matches("[data-action=tiny-start]")) {
      event.preventDefault();
      startTiny(new FormData(form).get("title"));
    }
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      if (app.dialog) {
        app.dialog = null;
        paint();
        return;
      }
      if (app.view === "editor") {
        app.draft = null;
        go("home");
        return;
      }
      if (app.view === "focus") leaveFocus();
      return;
    }
    if (event.key === " " && app.view === "focus" && !app.dialog && state.active && !state.notice) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
      event.preventDefault();
      togglePause();
    }
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  persist();
  window.addEventListener("hashchange", syncFromHash);
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") catchUp(false);
  });
  syncFromHash();
  catchUp(false);
  window.setInterval(() => {
    if (!catchUp(true)) patchTimer();
  }, 250);
  registerWorker();
})();

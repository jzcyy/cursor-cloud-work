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
    if (todayCount >= 2) return { level: 3, label: "正热", hint: "今天已经走完多步。兴趣还热着，可以停。" };
    if (todayCount === 1) return { level: 2, label: "微温", hint: "今天已经落地一步。停在这里也算接上了。" };
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

function shrinkActive(active, capSec, now) {
  if (!active) return active;
  const cap = Math.max(1, Math.round(Number(capSec) || 0));
  const left = remainingSeconds(active, now);
  if (left <= cap) return active;
  const elapsed = Math.max(0, Number(active.plannedSec) - left);
  return {
    ...active,
    plannedSec: elapsed + cap,
    remainingSec: cap,
    running: Boolean(active.running),
    runStartedAt: active.running ? now : null,
    timeUp: false,
  };
}

function describeElapsed(elapsedSec) {
  const sec = Math.max(0, Math.round(Number(elapsedSec) || 0));
  if (sec < 20) return "刚坐下就收工了。兴趣还在的时候停，这一步也算落地。";
  if (sec < 60) return `用了 ${sec} 秒。短到你把它做完了。`;
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  if (rest === 0) return `用了 ${minutes} 分钟。`;
  return `用了 ${minutes} 分 ${rest} 秒。`;
}

function todayDone(log, now) {
  const key = dayKey(now);
  return doneEvents(log)
    .filter((entry) => dayKey(entry.at) === key)
    .sort((a, b) => Number(a.at) - Number(b.at));
}

  function nextStepLine(pendingCount, minutes) {
    const mins = Number(minutes) || 0;
    const pending = Math.max(0, Number(pendingCount) || 0);
    if (pending <= 1) return `这是最后一步。现在只做这 ${mins} 分钟。`;
    return `后面还有 ${pending - 1} 步，先不用加总。现在只做这 ${mins} 分钟。`;
  }

  function returnCue(warmthLabel) {
    if (warmthLabel === "余温") return "昨天有进展。今天从这一小步接上。";
    if (warmthLabel === "凉了") return "隔了一阵也没关系。从这一小步回来。";
    return "";
  }

  function parkedDayKey(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return dayKey(date.getTime());
  }

  function isParked(parkedDay, now) {
    return parkedDayKey(parkedDay) === dayKey(now);
  }

  function enoughLine(doneCount) {
    const count = Math.max(0, Math.round(Number(doneCount) || 0));
    if (count <= 0) return "";
    return `今天已经落地 ${count} 步。可以停，也可以再走一小步。`;
  }

  function tinyGoal(title, now) {
    const text = String(title || "").trim().slice(0, 60);
    if (!text) return null;
    const createdAt = now || Date.now();
    return {
      id: createId(),
      title: text,
      why: "先做这一件很小的事。",
      createdAt,
      updatedAt: createdAt,
      steps: [
        {
          id: createId(),
          title: text,
          minutes: 5,
          status: "pending",
          completedAt: null,
        },
      ],
    };
  }

  function splitOpener(step) {
    const title = String(step && step.title ? step.title : "").trim();
    if (!title) return null;
    const head = title.length <= 18 ? title : `${title.slice(0, 18)}…`;
    return {
      id: createId(),
      title: `只做开头：${head}`.slice(0, 80),
      minutes: 5,
      status: "pending",
      completedAt: null,
    };
  }

  function suggestedNext(goals, currentGoalId, settings) {
    const list = goals || [];
    const current = list.find((goal) => goal && goal.id === currentGoalId);
    if (current) {
      const next = goalStats(current, settings).next;
      if (next) return { goal: current, step: next, mins: stepMinutes(next, settings) };
    }
    return shortestPending(list, settings);
  }

  function echoGoal(title) {
    const text = String(title || "").replace(/\s+/g, "").replace(/[。！？!?]/g, "");
    if (!text) return "这件事";
    return text.length <= 14 ? text : `${text.slice(0, 14)}…`;
  }

  function shortMinutes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 5;
    return n <= 6 ? 5 : 10;
  }

  function tidyPart(part) {
    return String(part || "")
      .replace(/^(把|将|再|然后|并且|并|先)/, "")
      .trim();
  }

  function listParts(title) {
    const compact = String(title || "").replace(/\s+/g, "");
    const punct = compact
      .split(/[、，,]/)
      .map(tidyPart)
      .filter((part) => part.length >= 4);
    if (punct.length >= 2) return punct.slice(0, 8);
    if (/[「」]/.test(compact)) return null;
    const conj = compact
      .split(/以及|还有|和|与/)
      .map(tidyPart)
      .filter((part) => part.length >= 4);
    if (conj.length >= 2) return conj.slice(0, 8);
    return null;
  }

  function stepsFromParts(parts) {
    const body = parts.map((part) => {
      const head = part.length > 24 ? `${part.slice(0, 24)}…` : part;
      return { title: `只做这一件：${head}`, minutes: head.length > 16 ? 10 : 5 };
    });
    const steps = [];
    if (body.length < 3) steps.push({ title: "先只拿出做第一件要用的东西", minutes: 5 });
    steps.push(...body);
    if (steps.length < 8) steps.push({ title: "先停。记下还没做的那一件", minutes: 5 });
    return steps.slice(0, 8);
  }

  function domainSteps(title) {
    const hay = title.toLowerCase();
    const domains = [
      { id: "share", weight: 3, words: ["分享", "演讲", "汇报", "幻灯片", "ppt", "报告"] },
      { id: "paper", weight: 3, words: ["论文", "文章", "作文", "写作", "文稿", "引言"] },
      { id: "tidy", weight: 3, words: ["整理", "打扫", "清理", "书桌", "桌上", "房间", "衣柜", "收纳"] },
      { id: "music", weight: 3, words: ["吉他", "钢琴", "小提琴", "乐器", "和弦", "练琴"] },
      { id: "code", weight: 3, words: ["代码", "编程", "程序", "bug", "调试"] },
      { id: "mail", weight: 3, words: ["邮件", "回信", "回消息"] },
      { id: "cook", weight: 3, words: ["做饭", "做菜", "晚饭", "午饭", "早餐"] },
      { id: "study", weight: 2, words: ["学习", "看书", "阅读", "复习", "课程", "背单词", "考试"] },
      { id: "exercise", weight: 3, words: ["跑步", "健身", "运动", "拉伸", "瑜伽"] },
      { id: "draw", weight: 3, words: ["画画", "素描", "绘画"] },
      { id: "write", weight: 1, words: ["写"] },
      { id: "practice", weight: 1, words: ["练习", "练"] },
    ];
    let best = null;
    let bestScore = 0;
    domains.forEach((domain) => {
      let score = 0;
      domain.words.forEach((word) => {
        if (hay.includes(word.toLowerCase())) score += domain.weight;
      });
      if (score > bestScore) {
        best = domain.id;
        bestScore = score;
      }
    });
    if (!best) return null;
    const name = echoGoal(title);
    const templates = {
      share: [
        { title: "写下希望对方记住的那一句话", minutes: 5 },
        { title: "列出三个要点，每个只写一行", minutes: 10 },
        { title: "给第一个要点配一个自己的例子", minutes: 10 },
        { title: "先不做完整稿，只写第一页标题", minutes: 5 },
        { title: "用口语把这几行念出声一遍", minutes: 5 },
      ],
      paper: [
        { title: `只打开「${name}」的文档`, minutes: 5 },
        { title: "写下这一次只要完成的那一句", minutes: 5 },
        { title: "列出三个小标题，每个只写一行", minutes: 10 },
        { title: "只写第一段的第一句，写完就停", minutes: 10 },
        { title: "读一遍刚才那几行，改一个别扭的词", minutes: 5 },
        { title: "记下下次从哪一句接着写", minutes: 5 },
      ],
      tidy: [
        { title: "把东西分成「留下」和「先拿走」", minutes: 5 },
        { title: "只把「先拿走」的一堆移出视线", minutes: 10 },
        { title: "擦一块马上会用到的表面", minutes: 5 },
        { title: "给留下的东西找一个固定的位置", minutes: 10 },
        { title: "看一眼，确认这块已经能开始做事", minutes: 5 },
      ],
      music: [
        { title: "把乐器拿出来，准备到能响一声", minutes: 5 },
        { title: "只练最慢的一遍，做对就停", minutes: 10 },
        { title: "用同样的慢速度再来一遍", minutes: 5 },
        { title: "用正常速度做一次最短的版本", minutes: 10 },
        { title: "收好，记下下次从哪一个动作开始", minutes: 5 },
      ],
      code: [
        { title: "只把项目打开，确认要改的是哪一处", minutes: 5 },
        { title: "用一句话写下这次最小的改动", minutes: 5 },
        { title: "只改这一处，先不顺手重构", minutes: 10 },
        { title: "跑一次，看这一处有没有坏", minutes: 10 },
        { title: "记下下次要碰的下一处", minutes: 5 },
      ],
      mail: [
        { title: "只写收件人和这一封的目的", minutes: 5 },
        { title: "用三行写出要说的事，先不润色", minutes: 10 },
        { title: "删掉一句可以不说的", minutes: 5 },
        { title: "读一遍，发出去或存成草稿", minutes: 5 },
      ],
      cook: [
        { title: "只拿出这一餐要用的材料", minutes: 5 },
        { title: "先做最耗时的那样，做到能放着", minutes: 10 },
        { title: "把剩下的洗好或切好", minutes: 10 },
        { title: "完成这一餐能吃的最小版本", minutes: 10 },
        { title: "把主要工具放进水槽", minutes: 5 },
      ],
      study: [
        { title: "只翻到要看的那一节，做个记号", minutes: 5 },
        { title: "读两段，用自己的话写下一句", minutes: 10 },
        { title: "把不懂的地方圈出来，先不查完", minutes: 5 },
        { title: "只查刚才圈出的第一个问题", minutes: 10 },
        { title: "合上，用一句话讲给自己听", minutes: 5 },
      ],
      exercise: [
        { title: "换好或站到能开始的位置", minutes: 5 },
        { title: "只做一轮最轻的版本", minutes: 10 },
        { title: "休息一会儿，再做一轮同样轻的", minutes: 5 },
        { title: "做到自己说停的那一下就停", minutes: 10 },
        { title: "记下下次从哪一个动作开始", minutes: 5 },
      ],
      draw: [
        { title: "只拿出纸和一支笔", minutes: 5 },
        { title: "先画一个很小的轮廓，不涂完", minutes: 10 },
        { title: "只加一处你最想看见的细节", minutes: 10 },
        { title: "离远看一眼，改一条线", minutes: 5 },
        { title: "收起笔，记下下次从哪一笔开始", minutes: 5 },
      ],
      write: [
        { title: `只打开「${name}」要写的那一页`, minutes: 5 },
        { title: "先写一句能当开头的话", minutes: 5 },
        { title: "顺着这句再写四行，写完就停", minutes: 10 },
        { title: "读一遍，删掉一句多余的", minutes: 5 },
      ],
      practice: [
        { title: `只准备「${name}」要用的那样东西`, minutes: 5 },
        { title: "用最慢的速度做一遍", minutes: 10 },
        { title: "再慢速重复一遍", minutes: 5 },
        { title: "用正常速度做一次最短的版本", minutes: 10 },
        { title: "记下下次从哪一下开始", minutes: 5 },
      ],
    };
    return templates[best];
  }

  function genericSteps(title) {
    const name = echoGoal(title);
    return [
      { title: `只找出和「${name}」有关的那一份材料`, minutes: 5 },
      { title: `用一句话写下「${name}」怎样算做完`, minutes: 5 },
      { title: `只做「${name}」的开头，做完就停`, minutes: 10 },
      { title: "把刚才的开头再往前推进一小段", minutes: 10 },
      { title: "收起来，记下下次从哪一句开始", minutes: 5 },
    ];
  }

  function suggestSteps(text) {
    const title = String(text || "").trim();
    if (!title) return [];
    const parts = listParts(title);
    const steps = parts ? stepsFromParts(parts) : domainSteps(title) || genericSteps(title);
    return steps
      .slice(0, 8)
      .map((step) => ({
        title: String(step.title || "").trim().slice(0, 80),
        minutes: shortMinutes(step.minutes),
      }))
      .filter((step) => step.title);
  }

  function cleanPasteLine(line) {
    return String(line || "")
      .trim()
      .replace(/^[-*•·]\s*/, "")
      .replace(/^\d{1,2}\s*[.、)）]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
  }

  function parsePastedSteps(text) {
    const raw = String(text || "").replace(/\r/g, "").trim();
    if (!raw) return { steps: [], truncated: false };
    let lines = raw.split("\n").map(cleanPasteLine).filter(Boolean);
    if (lines.length <= 1 && raw.includes("；")) lines = raw.split("；").map(cleanPasteLine).filter(Boolean);
    const truncated = lines.length > 8;
    const steps = lines.slice(0, 8).map((line) => {
      const marked = line.match(/(\d{1,3})\s*(?:分钟|min)/i) || line.match(/[|｜]\s*(\d{1,3})\s*$/);
      const title = line
        .replace(/[|｜]\s*\d{1,3}\s*(?:分钟|min)?\s*$/i, "")
        .replace(/[（(]\s*\d{1,3}\s*(?:分钟|min)\s*[)）]/gi, "")
        .replace(/(\d{1,3})\s*(?:分钟|min)\s*$/i, "")
        .trim()
        .slice(0, 80);
      return { title, minutes: shortMinutes(marked && marked[1]) };
    }).filter((step) => step.title);
    return { steps, truncated };
  }

  function splitPrompt(title) {
    const name = String(title || "").trim().slice(0, 60) || "（在这里写大目标）";
    return `请把下面的大目标拆成 4 到 6 个很短的步骤。每一步只要 5 或 10 分钟，写成一句马上能做的动作。不要解释，不要加总时长。\n大目标：${name}\n每行一条，格式：步骤内容｜5分钟`;
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
      parkedDay: null,
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
      parkedDay: parkedDayKey(raw.parkedDay),
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
    shrinkActive,
    describeElapsed,
    todayDone,
    nextStepLine,
    returnCue,
    isParked,
    enoughLine,
    tinyGoal,
    splitOpener,
    suggestedNext,
    suggestSteps,
    parsePastedSteps,
    splitPrompt,
    catchUpActive,
    seedState,
    normalizeState,
  };
});

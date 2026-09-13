/*
 * domain.js —— 水下考古协作调度台 · 纯领域逻辑层
 * 不依赖 DOM / localStorage，可在浏览器与 Node（测试）中同时运行。
 * 包含：数据模型工厂、排班四类检查（时间重叠/耗气/天气窗口/依赖顺序）、
 *       任务状态机（提交→复核→批准→执行→关闭，拦截重复提交与跨级流转）、
 *       多人导入合并与冲突检测。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Domain = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------------- 常量 ---------------- */

  // 天气窗口安全阈值：风速节 / 浪高米 / 能见度米
  const WEATHER_LIMITS = { windKts: 15, waveM: 1.2, visM: 3 };
  // 耗气安全系数（含备用气，常规按 1.5 倍规划）
  const GAS_RESERVE_FACTOR = 1.5;
  // 余气量低于该比例时给出警告
  const GAS_WARN_RATIO = 0.3;

  const DIVE_STATUS = ["planned", "scheduled", "completed", "cancelled"];
  const DIVE_STATUS_NAMES = {
    planned: "计划中",
    scheduled: "已排班",
    completed: "已完成",
    cancelled: "已取消",
  };

  // 任务状态机：当前状态 -> 允许的动作 -> 下一状态
  const TASK_FLOW = {
    draft: { submit: "submitted" },
    submitted: { review: "reviewed", reject: "draft" },
    reviewed: { approve: "approved", reject: "draft" },
    approved: { execute: "executing", reject: "draft" },
    executing: { close: "closed" },
    closed: {},
  };
  const TASK_STATUS_NAMES = {
    draft: "草稿",
    submitted: "已提交",
    reviewed: "已复核",
    approved: "已批准",
    executing: "执行中",
    closed: "已关闭",
  };
  const TASK_ACTION_NAMES = {
    submit: "提交",
    review: "复核",
    approve: "批准",
    execute: "执行",
    close: "关闭",
    reject: "退回",
  };

  /* ---------------- 工具 ---------------- */

  let seq = 0;
  function uid(prefix) {
    // 测试环境无 crypto.randomUUID 时退化为计数器，保证确定性
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return prefix + "_" + crypto.randomUUID().slice(0, 8);
    }
    return prefix + "_" + (++seq).toString(36) + Date.now().toString(36);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // "HH:MM" -> 分钟数；非法输入返回 NaN
  function toMin(hhmm) {
    if (typeof hhmm !== "string") return NaN;
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /* ---------------- 模型工厂 ---------------- */

  function createSite(name, extra) {
    return Object.assign(
      {
        id: uid("site"),
        name: name || "未命名遗址",
        location: "",
        depthLimitM: 30,
        personnel: [], // {id,name,role,sacRate,maxDepthM}
        cylinders: [], // {id,code,capacityL,pressureBar,gasType}
        weather: [], // {id,date,windKts,waveM,visM,windowStart,windowEnd,note}
        dives: [], // {id,code,date,start,end,depthM,goal,diverIds,cylinderIds,status}
        dependencies: [], // {id,predId,succId,reason} pred 必须先于 succ
      },
      extra || {}
    );
  }

  function createDive(fields) {
    return Object.assign(
      {
        id: uid("dive"),
        code: "",
        date: "",
        start: "08:00",
        end: "09:00",
        depthM: 18,
        goal: "",
        diverIds: [],
        cylinderIds: [],
        status: "planned",
      },
      fields || {}
    );
  }

  function createTask(fields) {
    const now = (fields && fields.now) || new Date().toISOString();
    return Object.assign(
      {
        id: uid("task"),
        siteId: "",
        diveId: null,
        title: "",
        detail: "",
        status: "draft",
        createdBy: "",
        createdAt: now,
        updatedAt: now,
        history: [],
      },
      fields || {}
    );
  }

  /* ---------------- 排班检查 ---------------- */
  /*
   * validateDivePlan(state, siteId, dive) -> { errors[], warnings[] }
   * dive 为待排班的潜次（可以是尚未入库的草稿，或已存在潜次的修改版）。
   * errors 非空时必须阻止排班；warnings 仅提示。
   */
  function validateDivePlan(state, siteId, dive) {
    const errors = [];
    const warnings = [];
    const site = state.sites.find((s) => s.id === siteId);
    if (!site) {
      return { errors: ["遗址不存在"], warnings };
    }

    // —— 基本字段 ——
    if (!dive.date) errors.push("缺少潜次日期");
    const start = toMin(dive.start);
    const end = toMin(dive.end);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      errors.push("开始/结束时间格式不正确（应为 HH:MM）");
    } else if (end <= start) {
      errors.push("结束时间必须晚于开始时间");
    }
    if (!(dive.depthM > 0)) errors.push("深度必须大于 0");
    if (site.depthLimitM && dive.depthM > site.depthLimitM) {
      errors.push(`计划深度 ${dive.depthM}m 超出遗址深度上限 ${site.depthLimitM}m`);
    }
    if (!dive.diverIds || dive.diverIds.length === 0) {
      errors.push("至少指派一名潜水员");
    }
    if (errors.length) return { errors, warnings }; // 基础数据不合法时不再做衍生检查

    const durationMin = end - start;

    // —— 1. 时间重叠：同一潜水员同日不得重复排班 ——
    const others = site.dives.filter(
      (d) => d.id !== dive.id && d.date === dive.date && d.status !== "cancelled"
    );
    for (const other of others) {
      const oStart = toMin(other.start);
      const oEnd = toMin(other.end);
      if (Number.isNaN(oStart) || Number.isNaN(oEnd)) continue;
      if (!overlaps(start, end, oStart, oEnd)) continue;
      const clash = (dive.diverIds || []).filter((id) => other.diverIds.includes(id));
      if (clash.length) {
        const names = clash
          .map((id) => {
            const p = site.personnel.find((x) => x.id === id);
            return p ? p.name : id;
          })
          .join("、");
        errors.push(
          `时间重叠：${names} 已排在 ${other.code || other.id}（${other.start}-${other.end}）`
        );
      } else {
        warnings.push(
          `与 ${other.code || other.id}（${other.start}-${other.end}）时段重叠，请确认现场可并行作业`
        );
      }
    }

    // —— 2. 耗气：可用气量须覆盖全员需求（含安全系数） ——
    const divers = (dive.diverIds || [])
      .map((id) => site.personnel.find((p) => p.id === id))
      .filter(Boolean);
    const ata = 1 + dive.depthM / 10; // 平均深度近似为作业深度
    let requiredL = 0;
    for (const p of divers) {
      const sac = p.sacRate > 0 ? p.sacRate : 20; // 默认水面耗气 20 L/min
      requiredL += sac * ata * durationMin * GAS_RESERVE_FACTOR;
      if (p.maxDepthM && dive.depthM > p.maxDepthM) {
        errors.push(`${p.name} 的证书深度上限 ${p.maxDepthM}m，低于计划深度 ${dive.depthM}m`);
      }
    }
    const assigned = (dive.cylinderIds || [])
      .map((id) => site.cylinders.find((c) => c.id === id))
      .filter(Boolean);
    if (assigned.length === 0) {
      errors.push("未指派气瓶");
    } else {
      const availableL = assigned.reduce(
        (sum, c) => sum + (c.capacityL || 0) * (c.pressureBar || 0),
        0
      );
      if (availableL < requiredL) {
        errors.push(
          `耗气不足：需求约 ${Math.round(requiredL)}L（含${GAS_RESERVE_FACTOR}倍安全系数），` +
            `已指派气瓶合计 ${Math.round(availableL)}L`
        );
      } else if (availableL < requiredL * (1 + GAS_WARN_RATIO)) {
        warnings.push(
          `气量余量偏低：需求约 ${Math.round(requiredL)}L，可用 ${Math.round(availableL)}L`
        );
      }
    }

    // —— 3. 天气窗口 ——
    const wx = site.weather.find((w) => w.date === dive.date);
    if (!wx) {
      warnings.push(`${dive.date} 无天气记录，排班前请补充气象窗口`);
    } else {
      if (wx.windKts > WEATHER_LIMITS.windKts) {
        errors.push(`风速 ${wx.windKts} 节超过安全上限 ${WEATHER_LIMITS.windKts} 节`);
      }
      if (wx.waveM > WEATHER_LIMITS.waveM) {
        errors.push(`浪高 ${wx.waveM}m 超过安全上限 ${WEATHER_LIMITS.waveM}m`);
      }
      if (wx.visM < WEATHER_LIMITS.visM) {
        errors.push(`能见度 ${wx.visM}m 低于安全下限 ${WEATHER_LIMITS.visM}m`);
      }
      const wStart = toMin(wx.windowStart);
      const wEnd = toMin(wx.windowEnd);
      if (!Number.isNaN(wStart) && !Number.isNaN(wEnd)) {
        if (start < wStart || end > wEnd) {
          errors.push(
            `超出天气窗口：当日可作业窗口 ${wx.windowStart}-${wx.windowEnd}，` +
              `本潜次 ${dive.start}-${dive.end}`
          );
        }
      }
    }

    // —— 4. 依赖顺序：前置潜次必须排在更早时间 ——
    for (const dep of site.dependencies) {
      if (dep.succId !== dive.id) continue;
      const pred = site.dives.find((d) => d.id === dep.predId);
      if (!pred) {
        errors.push(`依赖的前置潜次不存在（${dep.reason || dep.predId}）`);
        continue;
      }
      const later =
        pred.date > dive.date ||
        (pred.date === dive.date && toMin(pred.end) > start);
      if (later) {
        errors.push(
          `依赖顺序冲突：前置潜次 ${pred.code || pred.id}（${pred.date} ${pred.start}-${pred.end}）` +
            `排在本潜次之后${dep.reason ? "（" + dep.reason + "）" : ""}`
        );
      } else if (pred.status !== "completed") {
        warnings.push(
          `前置潜次 ${pred.code || pred.id} 尚未完成，执行本潜次前须确认其完成`
        );
      }
    }

    return { errors, warnings };
  }

  /* 新增依赖前检查：自环与环检测。返回错误消息或 null。 */
  function checkDependency(site, predId, succId) {
    if (predId === succId) return "潜次不能依赖自身";
    if (!site.dives.some((d) => d.id === predId)) return "前置潜次不存在";
    if (!site.dives.some((d) => d.id === succId)) return "后续潜次不存在";
    if (
      site.dependencies.some((d) => d.predId === predId && d.succId === succId)
    ) {
      return "该依赖已存在";
    }
    // 从 succId 沿依赖链向下能回到 predId 则成环
    const adj = new Map();
    for (const d of site.dependencies) {
      if (!adj.has(d.predId)) adj.set(d.predId, []);
      adj.get(d.predId).push(d.succId);
    }
    const stack = [succId];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === predId) return "会形成循环依赖，已拦截";
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) || []) stack.push(nxt);
    }
    return null;
  }

  /* ---------------- 任务状态机 ---------------- */
  /*
   * transitionTask(task, action, actor, note, now)
   * 成功返回新 task（原对象不被修改）；非法流转抛出 Error：
   *  - 重复提交：status 非 draft 时再次 submit
   *  - 跨级流转：当前状态不允许该动作（如 submitted 直接 approve）
   */
  function transitionTask(task, action, actor, note, now) {
    const allowed = TASK_FLOW[task.status];
    if (!allowed) throw new Error(`未知任务状态：${task.status}`);
    if (!(action in allowed)) {
      if (action === "submit") {
        throw new Error(
          `重复提交被拦截：任务已处于「${TASK_STATUS_NAMES[task.status]}」状态`
        );
      }
      const expect = Object.keys(allowed)
        .map((a) => TASK_ACTION_NAMES[a])
        .join(" / ");
      throw new Error(
        `跨级流转被拦截：「${TASK_STATUS_NAMES[task.status]}」状态只能执行：` +
          (expect || "（终态，不可再流转）") +
          `，不能执行「${TASK_ACTION_NAMES[action] || action}」`
      );
    }
    const next = clone(task);
    const ts = now || new Date().toISOString();
    next.history.push({
      ts,
      actor: actor || "未署名",
      action,
      from: task.status,
      to: allowed[action],
      note: note || "",
    });
    next.status = allowed[action];
    next.updatedAt = ts;
    return next;
  }

  function taskActionsFor(status) {
    return Object.keys(TASK_FLOW[status] || {});
  }

  /* ---------------- 导入合并 ---------------- */
  /*
   * 可合并集合：顶层 sites/tasks，以及站点内 personnel/cylinders/weather/dives/dependencies。
   * mergeImport(local, remote) 不修改入参，返回：
   *   { state, report: { added[], skipped[], conflicts[] } }
   * 冲突条目：{ key, collection, siteId?, entityId, local, remote }
   * 规则：远端有本地无 -> 追加；双方都有且内容一致 -> 跳过；不一致 -> 保留本地并记冲突。
   * 审计日志为只增集合：按 id 取并集，不产生冲突。
   */
  const SUB_COLLECTIONS = [
    "personnel",
    "cylinders",
    "weather",
    "dives",
    "dependencies",
  ];

  function mergeImport(local, remote) {
    const state = clone(local);
    const report = { added: [], skipped: [], conflicts: [] };
    if (!remote || typeof remote !== "object") {
      throw new Error("导入内容不是有效的 JSON 对象");
    }

    function mergeList(localList, remoteList, collection, siteId) {
      for (const item of remoteList || []) {
        if (!item || !item.id) continue;
        const idx = localList.findIndex((x) => x.id === item.id);
        const label = `${collection}:${item.id}`;
        if (idx === -1) {
          localList.push(clone(item));
          report.added.push(label);
        } else if (deepEqual(localList[idx], item)) {
          report.skipped.push(label);
        } else {
          report.conflicts.push({
            key: label,
            collection,
            siteId: siteId || null,
            entityId: item.id,
            local: clone(localList[idx]),
            remote: clone(item),
          });
        }
      }
    }

    // 站点：先按 id 合并站点本身，再合并其子集合
    for (const rSite of remote.sites || []) {
      const lSite = state.sites.find((s) => s.id === rSite.id);
      if (!lSite) {
        state.sites.push(clone(rSite));
        report.added.push(`sites:${rSite.id}`);
        continue;
      }
      for (const sub of SUB_COLLECTIONS) {
        mergeList(lSite[sub], rSite[sub], `site.${sub}`, lSite.id);
      }
      // 站点标量字段（名称等）不一致也记冲突
      const lMeta = omitCollections(lSite);
      const rMeta = omitCollections(rSite);
      if (!deepEqual(lMeta, rMeta)) {
        report.conflicts.push({
          key: `sites:${lSite.id}:meta`,
          collection: "site.meta",
          siteId: lSite.id,
          entityId: lSite.id,
          local: clone(lMeta),
          remote: clone(rMeta),
        });
      }
    }

    mergeList(state.tasks, remote.tasks, "tasks");

    // 审计并集
    const seen = new Set(state.audit.map((a) => a.id));
    for (const entry of remote.audit || []) {
      if (entry && entry.id && !seen.has(entry.id)) {
        state.audit.push(clone(entry));
        seen.add(entry.id);
      }
    }
    state.audit.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    return { state, report };
  }

  function omitCollections(site) {
    const meta = {};
    for (const [k, v] of Object.entries(site)) {
      if (!SUB_COLLECTIONS.includes(k)) meta[k] = v;
    }
    return meta;
  }

  /*
   * 解决冲突：choice = "local"（保留本地，丢弃远端）| "remote"（采用远端覆盖本地）。
   * 直接修改传入 state（由 store.commit 包装进撤销栈）。
   */
  function resolveConflict(state, conflict, choice) {
    if (choice !== "local" && choice !== "remote") {
      throw new Error("非法的冲突解决方式：" + choice);
    }
    if (choice === "local") return; // 本地已是当前值，无需改动
    const apply = (list, entity) => {
      const idx = list.findIndex((x) => x.id === entity.id);
      if (idx >= 0) list[idx] = clone(entity);
      else list.push(clone(entity));
    };
    if (conflict.collection === "tasks") {
      apply(state.tasks, conflict.remote);
    } else if (conflict.collection === "site.meta") {
      const site = state.sites.find((s) => s.id === conflict.siteId);
      if (site) Object.assign(site, clone(conflict.remote));
    } else if (conflict.collection.startsWith("site.")) {
      const sub = conflict.collection.slice("site.".length);
      const site = state.sites.find((s) => s.id === conflict.siteId);
      if (site && Array.isArray(site[sub])) apply(site[sub], conflict.remote);
    } else {
      throw new Error("未知的冲突集合：" + conflict.collection);
    }
  }

  /* ---------------- 导出 ---------------- */

  return {
    WEATHER_LIMITS,
    GAS_RESERVE_FACTOR,
    DIVE_STATUS,
    DIVE_STATUS_NAMES,
    TASK_FLOW,
    TASK_STATUS_NAMES,
    TASK_ACTION_NAMES,
    SUB_COLLECTIONS,
    uid,
    clone,
    toMin,
    overlaps,
    deepEqual,
    createSite,
    createDive,
    createTask,
    validateDivePlan,
    checkDependency,
    transitionTask,
    taskActionsFor,
    mergeImport,
    resolveConflict,
  };
});

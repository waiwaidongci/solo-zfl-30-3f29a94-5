/*
 * store.js —— 状态容器：数据层与界面层之间的唯一桥梁。
 * 职责：持有状态、commit（进撤销栈+写审计）、undo/redo、持久化、导入导出、订阅通知。
 * 审计日志只增不减：撤销/重做本身也会被记录，不回滚审计。
 * 不依赖 DOM；storage 可注入（浏览器用 localStorage，测试用内存对象）。
 */
(function (root, factory) {
  const Domain = typeof module !== "undefined" && module.exports
    ? require("./domain.js")
    : root.Domain;
  const api = factory(Domain);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Store = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Domain) {
  "use strict";

  const STORAGE_KEY = "uw-arch-scheduler:v1";

  function memoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }

  function emptyState() {
    return {
      version: 1,
      actor: "值班员",
      sites: [],
      tasks: [],
      audit: [], // {id,ts,actor,action,detail}
      mergeConflicts: [], // 待解决的导入冲突
    };
  }

  /* 演示数据：首次打开即可走通核心流程 */
  function seedState() {
    const s = emptyState();
    const site = Domain.createSite("南海一号·遗址A", {
      location: "阳江海域",
      depthLimitM: 30,
    });
    const p1 = {
      id: Domain.uid("p"),
      name: "林海",
      role: "潜水监督",
      sacRate: 18,
      maxDepthM: 40,
    };
    const p2 = {
      id: Domain.uid("p"),
      name: "苏晴",
      role: "考古潜水员",
      sacRate: 22,
      maxDepthM: 30,
    };
    const p3 = {
      id: Domain.uid("p"),
      name: "赵潜",
      role: "考古潜水员",
      sacRate: 25,
      maxDepthM: 24,
    };
    site.personnel.push(p1, p2, p3);
    site.cylinders.push(
      { id: Domain.uid("c"), code: "瓶-01", capacityL: 12, pressureBar: 200, gasType: "空气" },
      { id: Domain.uid("c"), code: "瓶-02", capacityL: 12, pressureBar: 200, gasType: "空气" },
      { id: Domain.uid("c"), code: "瓶-03", capacityL: 12, pressureBar: 200, gasType: "空气" },
      { id: Domain.uid("c"), code: "瓶-04", capacityL: 12, pressureBar: 200, gasType: "空气" },
      { id: Domain.uid("c"), code: "瓶-05", capacityL: 15, pressureBar: 180, gasType: "空气" }
    );
    site.weather.push(
      { id: Domain.uid("w"), date: "2026-09-14", windKts: 8, waveM: 0.6, visM: 8, windowStart: "07:00", windowEnd: "12:00", note: "上午窗口" },
      { id: Domain.uid("w"), date: "2026-09-15", windKts: 18, waveM: 1.6, visM: 5, windowStart: "08:00", windowEnd: "11:00", note: "风大，慎排" }
    );
    // DIVE-01：12m / 45min / 两人 SAC 18+22 -> 需求约 5940L，四瓶 9600L，校验通过
    const d1 = Domain.createDive({
      code: "DIVE-01",
      date: "2026-09-14",
      start: "07:30",
      end: "08:15",
      depthM: 12,
      goal: "船体东侧测绘",
      diverIds: [p1.id, p2.id],
      cylinderIds: [site.cylinders[0].id, site.cylinders[1].id, site.cylinders[2].id, site.cylinders[3].id],
      status: "scheduled",
    });
    // DIVE-02：20m / 60min / 两人需求约 12690L，仅一瓶 2700L -> 演示耗气拦截与依赖警告
    const d2 = Domain.createDive({
      code: "DIVE-02",
      date: "2026-09-14",
      start: "09:30",
      end: "10:30",
      depthM: 20,
      goal: "陶片取样（依赖测绘完成）",
      diverIds: [p2.id, p3.id],
      cylinderIds: [site.cylinders[4].id],
      status: "planned",
    });
    site.dives.push(d1, d2);
    site.dependencies.push({
      id: Domain.uid("dep"),
      predId: d1.id,
      succId: d2.id,
      reason: "取样须等测绘完成",
    });
    s.sites.push(site);
    const t1 = Domain.createTask({
      siteId: site.id,
      diveId: d1.id,
      title: "DIVE-01 测绘器材清单核对",
      detail: "出发前核对测绳、绘图板、相机防水壳",
      createdBy: "林海",
    });
    s.tasks.push(t1);
    s.audit.push({
      id: Domain.uid("a"),
      ts: new Date().toISOString(),
      actor: "系统",
      action: "init",
      detail: "载入演示数据",
    });
    return s;
  }

  function createStore(options) {
    const opts = options || {};
    const storage = opts.storage || safeLocalStorage() || memoryStorage();
    const key = opts.storageKey || STORAGE_KEY;
    const listeners = new Set();

    let state = null;
    let undoStack = []; // 快照：{sites,tasks,mergeConflicts}
    let redoStack = [];

    function safeLocalStorage() {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.getItem("__probe__");
          return localStorage;
        }
      } catch (e) {
        /* file:// 或隐私模式下可能不可用 */
      }
      return null;
    }

    /* 撤销快照只覆盖业务数据；审计日志只增不减，不参与撤销 */
    function snapshot() {
      return Domain.clone({
        sites: state.sites,
        tasks: state.tasks,
        mergeConflicts: state.mergeConflicts,
      });
    }
    function restore(snap) {
      state.sites = snap.sites;
      state.tasks = snap.tasks;
      state.mergeConflicts = snap.mergeConflicts;
    }

    function persist() {
      try {
        storage.setItem(key, JSON.stringify(state));
      } catch (e) {
        /* 存储不可用时保持内存态 */
      }
    }

    function audit(action, detail) {
      state.audit.push({
        id: Domain.uid("a"),
        ts: new Date().toISOString(),
        actor: state.actor || "未署名",
        action,
        detail: detail || "",
      });
    }

    function emit() {
      persist();
      for (const fn of listeners) fn(state);
    }

    const store = {
      getState() {
        return state;
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,

      setActor(name) {
        state.actor = name && name.trim() ? name.trim() : "未署名";
        persist();
      },

      /* 所有业务修改统一入口：label 用于撤销提示与审计 */
      commit(label, mutator) {
        const before = snapshot();
        const result = mutator(state); // mutator 抛出异常则不入栈、不审计
        undoStack.push(before);
        redoStack = [];
        audit("commit", label);
        emit();
        return result;
      },

      undo() {
        if (!undoStack.length) return false;
        redoStack.push(snapshot());
        restore(undoStack.pop());
        audit("undo", "撤销一步操作");
        emit();
        return true;
      },

      redo() {
        if (!redoStack.length) return false;
        undoStack.push(snapshot());
        restore(redoStack.pop());
        audit("redo", "重做一步操作");
        emit();
        return true;
      },

      exportJSON() {
        return JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            exportedBy: state.actor,
            sites: state.sites,
            tasks: state.tasks,
            audit: state.audit,
          },
          null,
          2
        );
      },

      /* 导入并合并；冲突挂到 mergeConflicts 等待人工解决 */
      importJSON(jsonText) {
        let remote;
        try {
          remote = JSON.parse(jsonText);
        } catch (e) {
          throw new Error("导入失败：不是有效的 JSON 文件");
        }
        let outcome;
        store.commit("导入合并数据", (s) => {
          outcome = Domain.mergeImport(s, remote);
          s.sites = outcome.state.sites;
          s.tasks = outcome.state.tasks;
          // 审计并集合入
          const seen = new Set(s.audit.map((a) => a.id));
          for (const a of outcome.state.audit) {
            if (!seen.has(a.id)) s.audit.push(a);
          }
          s.audit.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
          s.mergeConflicts = s.mergeConflicts.concat(outcome.report.conflicts);
        });
        return outcome.report;
      },

      resolveConflict(key, choice) {
        const c = state.mergeConflicts.find((x) => x.key === key);
        if (!c) throw new Error("冲突不存在或已解决：" + key);
        store.commit(
          `解决冲突 ${key}（${choice === "remote" ? "采用对方" : "保留本地"}）`,
          (s) => {
            Domain.resolveConflict(s, c, choice);
            s.mergeConflicts = s.mergeConflicts.filter((x) => x.key !== key);
          }
        );
      },

      resetAll(useSeed) {
        state = useSeed === false ? emptyState() : seedState();
        undoStack = [];
        redoStack = [];
        persist();
        emit();
      },
    };

    /* 启动：优先读持久化，否则载入演示数据 */
    (function init() {
      let loaded = null;
      try {
        const raw = storage.getItem(key);
        if (raw) loaded = JSON.parse(raw);
      } catch (e) {
        loaded = null;
      }
      if (loaded && Array.isArray(loaded.sites) && Array.isArray(loaded.tasks)) {
        state = Object.assign(emptyState(), loaded);
      } else {
        state = seedState();
        persist();
      }
    })();

    return store;
  }

  return { createStore, emptyState, seedState, memoryStorage, STORAGE_KEY };
});

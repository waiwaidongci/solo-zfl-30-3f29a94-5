/*
 * ui.js —— 界面层：渲染与事件。只调用 Store/Domain 暴露的接口，不直接改数据。
 * 支持：标签页导航、潜次排期（含校验提示）、任务流转、资源/天气/依赖维护、
 *       冲突解决、审计查看、撤销重做、导入导出、键盘快捷键、焦点保持。
 */
(function () {
  "use strict";
  const D = Domain;
  let store = null;

  /* UI 本地状态（不进撤销栈） */
  const ui = {
    tab: "schedule",
    siteId: null,
    toastTimer: null,
  };

  /* ---------------- 基础工具 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function $(sel, rootEl) {
    return (rootEl || document).querySelector(sel);
  }

  function toast(msg, isErr) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isErr ? " err" : "");
    el.hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  /* 渲染时保持焦点：记录 data-fkey 与光标位置，渲染后恢复 */
  function withFocus(fn) {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.fkey : null;
    const selStart = active && "selectionStart" in active ? active.selectionStart : null;
    const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;
    fn();
    if (key) {
      const next = document.querySelector(`[data-fkey="${CSS.escape(key)}"]`);
      if (next) {
        next.focus();
        if (selStart !== null && "setSelectionRange" in next) {
          try { next.setSelectionRange(selStart, selEnd); } catch (e) { /* 非文本输入 */ }
        }
      }
    }
  }

  function currentSite(state) {
    return state.sites.find((s) => s.id === ui.siteId) || state.sites[0] || null;
  }

  function personName(site, id) {
    const p = site.personnel.find((x) => x.id === id);
    return p ? p.name : "（已删除人员）";
  }

  function cylLabel(site, id) {
    const c = site.cylinders.find((x) => x.id === id);
    return c ? c.code : "（已删除气瓶）";
  }

  /* ---------------- 状态徽标 ---------------- */

  function checkBadges(result) {
    if (!result) return "";
    const errs = result.errors.map((m) => `<li class="msg-err">⛔ ${esc(m)}</li>`).join("");
    const warns = result.warnings.map((m) => `<li class="msg-warn">⚠ ${esc(m)}</li>`).join("");
    const ok = !result.errors.length && !result.warnings.length
      ? `<li class="msg-ok">✓ 排班校验通过（时间 / 耗气 / 天气 / 依赖）</li>` : "";
    return `<ul class="msg-list">${errs}${warns}${ok}</ul>`;
  }

  /* ---------------- 渲染：顶栏 ---------------- */

  function renderHeader(state) {
    const siteSel = $("#siteSelect");
    siteSel.innerHTML = state.sites
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
      .join("");
    const site = currentSite(state);
    if (site) siteSel.value = site.id;
    const actor = $("#actorInput");
    if (actor.value !== state.actor) actor.value = state.actor;
    $("#undoBtn").disabled = !store.canUndo();
    $("#redoBtn").disabled = !store.canRedo();

    const banner = $("#conflictBanner");
    if (state.mergeConflicts.length) {
      banner.hidden = false;
      banner.innerHTML =
        `<strong>⚠ 导入合并发现 ${state.mergeConflicts.length} 项冲突</strong>` +
        `<span class="muted">本地与他人版本不一致，请逐项选择保留哪一方。</span>` +
        `<button type="button" class="small" id="gotoConflicts">查看并解决</button>`;
      $("#gotoConflicts").onclick = () => {
        switchTab("schedule");
        const card = $("#conflictCard");
        if (card) { card.scrollIntoView({ behavior: "smooth", block: "start" }); card.focus(); }
      };
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
    }
  }

  /* ---------------- 渲染：潜次排期 ---------------- */

  function renderSchedule(state) {
    const site = currentSite(state);
    const root = $("#panel-schedule");
    if (!site) {
      root.innerHTML = `<div class="empty">暂无遗址，请先在「资源与天气」中新建遗址。</div>`;
      return;
    }
    const dives = site.dives
      .slice()
      .sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1));

    const conflictCard = state.mergeConflicts.length
      ? `<div class="card" id="conflictCard" tabindex="-1">
           <h2>导入冲突（${state.mergeConflicts.length}）</h2>
           ${state.mergeConflicts.map(conflictItemHTML).join("")}
         </div>`
      : "";

    const diveCards = dives.length
      ? dives.map((d) => diveCardHTML(state, site, d)).join("")
      : `<div class="empty">暂无潜次。点击「新建潜次」开始排班。</div>`;

    root.innerHTML = `
      ${conflictCard}
      <div class="split">
        <div class="card">
          <h2>${esc(site.name)} · 潜次排期
            <span class="muted">${esc(site.location || "")} · 深度上限 ${esc(site.depthLimitM)}m</span>
          </h2>
          <div class="schedule-grid">${diveCards}</div>
        </div>
        <div class="card">
          <h2>排班操作</h2>
          <button type="button" id="newDiveBtn">＋ 新建潜次</button>
          <p class="muted">保存「已排班」潜次前会自动检查：时间重叠、耗气、天气窗口、依赖顺序。错误会阻止排班，警告可确认后继续。</p>
          <h3>依赖关系</h3>
          ${depListHTML(site)}
          <h3>快捷</h3>
          <p class="muted">
            <span class="kbd">Ctrl+Z</span> 撤销
            <span class="kbd">Ctrl+Shift+Z</span> 重做
            <span class="kbd">N</span> 新建潜次
            <span class="kbd">?</span> 全部快捷键
          </p>
        </div>
      </div>`;

    $("#newDiveBtn").onclick = () => openDiveModal(null);
    root.querySelectorAll("[data-dive-action]").forEach((btn) => {
      btn.onclick = () => onDiveAction(site.id, btn.dataset.diveAction, btn.dataset.diveId);
    });
    root.querySelectorAll("[data-conflict-choice]").forEach((btn) => {
      btn.onclick = () => {
        try {
          store.resolveConflict(btn.dataset.conflictKey, btn.dataset.conflictChoice);
          toast("冲突已解决（" + (btn.dataset.conflictChoice === "remote" ? "采用对方" : "保留本地") + "）");
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  }

  function diveCardHTML(state, site, d) {
    const check = d.status === "cancelled" ? null : D.validateDivePlan(state, site.id, d);
    const divers = d.diverIds.map((id) => esc(personName(site, id))).join("、") || "—";
    const cyls = d.cylinderIds.map((id) => esc(cylLabel(site, id))).join("、") || "—";
    const deps = site.dependencies
      .filter((x) => x.succId === d.id)
      .map((x) => {
        const pred = site.dives.find((p) => p.id === x.predId);
        return `依赖 ${esc(pred ? pred.code : "?")}${x.reason ? "（" + esc(x.reason) + "）" : ""}`;
      })
      .join("；");
    const hasErr = check && check.errors.length > 0;
    return `
      <article class="dive-card ${hasErr ? "conflict" : ""}" aria-label="潜次 ${esc(d.code)}">
        <div class="dive-head">
          <b>${esc(d.code)}</b>
          <span class="pill st-${esc(d.status)}">${esc(D.DIVE_STATUS_NAMES[d.status])}</span>
        </div>
        <div>${esc(d.date)} ${esc(d.start)}–${esc(d.end)} · 深度 ${esc(d.depthM)}m</div>
        <div class="muted">目标：${esc(d.goal || "—")}</div>
        <div class="muted">潜水员：${divers}</div>
        <div class="muted">气瓶：${cyls}</div>
        ${deps ? `<div class="muted">${deps}</div>` : ""}
        ${checkBadges(check)}
        <div class="row-actions">
          <button type="button" class="small" data-dive-action="edit" data-dive-id="${esc(d.id)}" data-fkey="dive-edit-${esc(d.id)}">编辑</button>
          ${d.status === "scheduled" ? `<button type="button" class="small ghost" data-dive-action="complete" data-dive-id="${esc(d.id)}" data-fkey="dive-complete-${esc(d.id)}">标记完成</button>` : ""}
          ${d.status === "scheduled" || d.status === "planned" ? `<button type="button" class="small secondary" data-dive-action="cancel" data-dive-id="${esc(d.id)}" data-fkey="dive-cancel-${esc(d.id)}">取消</button>` : ""}
          <button type="button" class="small danger" data-dive-action="delete" data-dive-id="${esc(d.id)}" data-fkey="dive-del-${esc(d.id)}">删除</button>
        </div>
      </article>`;
  }

  function depListHTML(site) {
    if (!site.dependencies.length) return `<p class="muted">暂无依赖。可在潜次编辑弹窗下方添加。</p>`;
    return `<ul class="msg-list">` + site.dependencies.map((dep) => {
      const pred = site.dives.find((d) => d.id === dep.predId);
      const succ = site.dives.find((d) => d.id === dep.succId);
      return `<li class="msg-warn" style="background:#eef3f4;color:var(--ink)">
        ${esc(pred ? pred.code : "?")} → ${esc(succ ? succ.code : "?")}
        <span class="muted">${esc(dep.reason || "")}</span>
        <button type="button" class="small danger" data-dep-del="${esc(dep.id)}" data-fkey="dep-del-${esc(dep.id)}">删除</button>
      </li>`;
    }).join("") + `</ul>`;
  }

  function onDiveAction(siteId, action, diveId) {
    if (action === "edit") {
      openDiveModal(diveId);
      return;
    }
    const labels = { complete: "标记潜次完成", cancel: "取消潜次", delete: "删除潜次" };
    try {
      store.commit(labels[action] || action, (s) => {
        const site = s.sites.find((x) => x.id === siteId);
        const dive = site.dives.find((x) => x.id === diveId);
        if (!dive) throw new Error("潜次不存在");
        if (action === "complete") dive.status = "completed";
        if (action === "cancel") dive.status = "cancelled";
        if (action === "delete") {
          site.dives = site.dives.filter((x) => x.id !== diveId);
          site.dependencies = site.dependencies.filter(
            (x) => x.predId !== diveId && x.succId !== diveId
          );
          for (const t of s.tasks) if (t.diveId === diveId) t.diveId = null;
        }
      });
      toast(labels[action] + "（可撤销）");
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ---------------- 潜次编辑弹窗 ---------------- */

  function openDiveModal(diveId) {
    const state = store.getState();
    const site = currentSite(state);
    if (!site) return;
    const existing = diveId ? site.dives.find((d) => d.id === diveId) : null;
    const dive = existing
      ? D.clone(existing)
      : D.createDive({
          code: "DIVE-" + String(site.dives.length + 1).padStart(2, "0"),
          date: (site.weather[0] && site.weather[0].date) || "",
        });
    let warnAck = false;

    const modalRoot = $("#modalRoot");
    modalRoot.innerHTML = `
      <div class="modal-mask" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="diveModalTitle">
          <h2 id="diveModalTitle">${existing ? "编辑潜次" : "新建潜次"} · ${esc(site.name)}</h2>
          <form id="diveForm" novalidate>
            <div class="form-grid">
              <div><label for="df-code">编号</label><input id="df-code" name="code" data-fkey="df-code" required value="${esc(dive.code)}"></div>
              <div><label for="df-date">日期</label><input id="df-date" name="date" data-fkey="df-date" type="date" required value="${esc(dive.date)}"></div>
              <div><label for="df-start">开始</label><input id="df-start" name="start" data-fkey="df-start" type="time" required value="${esc(dive.start)}"></div>
              <div><label for="df-end">结束</label><input id="df-end" name="end" data-fkey="df-end" type="time" required value="${esc(dive.end)}"></div>
              <div><label for="df-depth">计划深度（m）</label><input id="df-depth" name="depthM" data-fkey="df-depth" type="number" min="1" max="60" step="0.5" required value="${esc(dive.depthM)}"></div>
              <div><label for="df-status">状态</label>
                <select id="df-status" name="status" data-fkey="df-status">
                  ${D.DIVE_STATUS.filter((s) => s !== "cancelled").map((s) =>
                    `<option value="${s}" ${dive.status === s ? "selected" : ""}>${D.DIVE_STATUS_NAMES[s]}</option>`).join("")}
                </select>
              </div>
              <div class="full"><label for="df-goal">作业目标</label><input id="df-goal" name="goal" data-fkey="df-goal" value="${esc(dive.goal)}"></div>
            </div>
            <fieldset><legend>潜水员（勾选）</legend>
              <div class="check-grid">
                ${site.personnel.map((p) => `
                  <label><input type="checkbox" name="diver" value="${esc(p.id)}" ${dive.diverIds.includes(p.id) ? "checked" : ""}>
                    ${esc(p.name)} · ${esc(p.role)} · SAC ${esc(p.sacRate)}</label>`).join("")}
              </div>
            </fieldset>
            <fieldset><legend>气瓶（勾选）</legend>
              <div class="check-grid">
                ${site.cylinders.map((c) => `
                  <label><input type="checkbox" name="cyl" value="${esc(c.id)}" ${dive.cylinderIds.includes(c.id) ? "checked" : ""}>
                    ${esc(c.code)} · ${esc(c.capacityL)}L × ${esc(c.pressureBar)}bar</label>`).join("")}
              </div>
            </fieldset>
            <div id="diveCheckResult" aria-live="polite"></div>
            <div class="row-actions">
              <button type="submit" id="diveSaveBtn" data-fkey="diveSaveBtn">${existing ? "保存潜次" : "创建潜次"}</button>
              <button type="button" class="secondary" id="diveCancelBtn">取消</button>
            </div>
          </form>
        </div>
      </div>`;

    const mask = $(".modal-mask", modalRoot);
    const form = $("#diveForm");
    const resultBox = $("#diveCheckResult");

    function readForm() {
      return Object.assign(D.clone(dive), {
        code: form.code.value.trim(),
        date: form.date.value,
        start: form.start.value,
        end: form.end.value,
        depthM: Number(form.depthM.value),
        goal: form.goal.value.trim(),
        status: form.status.value,
        diverIds: Array.from(form.querySelectorAll('input[name="diver"]:checked')).map((x) => x.value),
        cylinderIds: Array.from(form.querySelectorAll('input[name="cyl"]:checked')).map((x) => x.value),
      });
    }

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const draft = readForm();
      const check = D.validateDivePlan(store.getState(), site.id, draft);
      // 「已排班」状态必须通过全部硬性检查；「计划中」仅提示
      if (draft.status === "scheduled" && check.errors.length) {
        warnAck = false;
        resultBox.innerHTML = checkBadges(check) +
          `<p class="muted">存在错误，无法设为「已排班」。可改存为「计划中」稍后处理。</p>`;
        return;
      }
      if ((check.errors.length || check.warnings.length) && !warnAck) {
        warnAck = true;
        resultBox.innerHTML = checkBadges(check) +
          `<p class="muted">再次点击保存将忽略上述${check.errors.length ? "错误（仅限计划中状态）与" : ""}警告。</p>`;
        $("#diveSaveBtn").textContent = "仍然保存";
        return;
      }
      try {
        store.commit(existing ? `编辑潜次 ${draft.code}` : `新建潜次 ${draft.code}`, (s) => {
          const st = s.sites.find((x) => x.id === site.id);
          const idx = st.dives.findIndex((x) => x.id === draft.id);
          if (idx >= 0) st.dives[idx] = draft;
          else st.dives.push(draft);
        });
        closeModal();
        toast(existing ? "潜次已保存" : "潜次已创建");
      } catch (e) {
        toast(e.message, true);
      }
    });

    $("#diveCancelBtn").onclick = closeModal;
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) closeModal(); });
    modalRoot.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    $("#df-code").focus();
    $("#df-code").select();
  }

  function closeModal() {
    $("#modalRoot").innerHTML = "";
  }

  /* ---------------- 渲染：任务流转 ---------------- */

  const FLOW_STEPS = ["draft", "submitted", "reviewed", "approved", "executing", "closed"];

  function renderTasks(state) {
    const site = currentSite(state);
    const root = $("#panel-tasks");
    const tasks = state.tasks
      .filter((t) => !site || t.siteId === site.id)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    root.innerHTML = `
      <div class="card">
        <h2>任务流转 ${site ? "· " + esc(site.name) : ""}
          <button type="button" class="small" id="newTaskBtn" style="margin-left:8px">＋ 新建任务</button>
        </h2>
        <p class="muted">流程：草稿 → 提交 → 复核 → 批准 → 执行 → 关闭。只允许逐级流转，重复提交与跨级操作会被拦截。</p>
        <div class="task-grid">
          ${tasks.length ? tasks.map((t) => taskCardHTML(state, site, t)).join("") : `<div class="empty">暂无任务。</div>`}
        </div>
      </div>`;

    $("#newTaskBtn").onclick = openTaskModal;
    root.querySelectorAll("[data-task-action]").forEach((btn) => {
      btn.onclick = () => {
        try {
          store.commit(
            `任务${D.TASK_ACTION_NAMES[btn.dataset.taskAction]}：${btn.dataset.taskTitle}`,
            (s) => {
              const idx = s.tasks.findIndex((x) => x.id === btn.dataset.taskId);
              if (idx === -1) throw new Error("任务不存在");
              s.tasks[idx] = D.transitionTask(
                s.tasks[idx], btn.dataset.taskAction, s.actor, ""
              );
            }
          );
          toast(`已${D.TASK_ACTION_NAMES[btn.dataset.taskAction]}`);
        } catch (e) {
          toast(e.message, true); // 拦截信息在此可见
        }
      };
    });
    root.querySelectorAll("[data-task-del]").forEach((btn) => {
      btn.onclick = () => {
        try {
          store.commit(`删除任务：${btn.dataset.taskTitle}`, (s) => {
            s.tasks = s.tasks.filter((x) => x.id !== btn.dataset.taskDel);
          });
          toast("任务已删除（可撤销）");
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  }

  function taskCardHTML(state, site, t) {
    const stepIdx = FLOW_STEPS.indexOf(t.status);
    const flow = FLOW_STEPS.map((s, i) =>
      `<span class="step ${i <= stepIdx ? "done" : ""}">${D.TASK_STATUS_NAMES[s]}</span>`
    ).join("<span>→</span>");
    const dive = site && t.diveId ? site.dives.find((d) => d.id === t.diveId) : null;
    const actions = D.taskActionsFor(t.status);
    const last = t.history[t.history.length - 1];
    return `
      <article class="task-card" aria-label="任务 ${esc(t.title)}">
        <div class="dive-head">
          <b>${esc(t.title)}</b>
          <span class="pill tk-${esc(t.status)}">${esc(D.TASK_STATUS_NAMES[t.status])}</span>
        </div>
        <div class="task-flow" aria-label="流转进度">${flow}</div>
        ${dive ? `<div class="muted">关联潜次：${esc(dive.code)}（${esc(dive.date)}）</div>` : ""}
        ${t.detail ? `<div>${esc(t.detail)}</div>` : ""}
        <div class="muted">创建：${esc(t.createdBy || "—")} · 更新：${esc(t.updatedAt.slice(0, 16).replace("T", " "))}</div>
        ${last ? `<div class="muted">最近：${esc(D.TASK_ACTION_NAMES[last.action])} by ${esc(last.actor)}${last.note ? " · " + esc(last.note) : ""}</div>` : ""}
        <div class="row-actions">
          ${actions.map((a) => {
            const danger = a === "reject" ? " secondary" : "";
            return `<button type="button" class="small${danger}" data-task-action="${a}" data-task-id="${esc(t.id)}" data-task-title="${esc(t.title)}" data-fkey="task-${esc(t.id)}-${a}">${D.TASK_ACTION_NAMES[a]}</button>`;
          }).join("")}
          ${t.status === "draft" ? `<button type="button" class="small danger" data-task-del="${esc(t.id)}" data-task-title="${esc(t.title)}" data-fkey="task-del-${esc(t.id)}">删除</button>` : ""}
        </div>
      </article>`;
  }

  function openTaskModal() {
    const state = store.getState();
    const site = currentSite(state);
    if (!site) { toast("请先创建遗址", true); return; }
    const modalRoot = $("#modalRoot");
    modalRoot.innerHTML = `
      <div class="modal-mask" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="taskModalTitle">
          <h2 id="taskModalTitle">新建任务 · ${esc(site.name)}</h2>
          <form id="taskForm">
            <label for="tf-title">任务标题</label>
            <input id="tf-title" name="title" data-fkey="tf-title" required>
            <label for="tf-dive">关联潜次（可选）</label>
            <select id="tf-dive" name="diveId" data-fkey="tf-dive">
              <option value="">不关联</option>
              ${site.dives.map((d) => `<option value="${esc(d.id)}">${esc(d.code)} · ${esc(d.date)}</option>`).join("")}
            </select>
            <label for="tf-detail">任务说明</label>
            <textarea id="tf-detail" name="detail" data-fkey="tf-detail"></textarea>
            <div class="row-actions" style="margin-top:10px">
              <button type="submit" data-fkey="taskCreateBtn">创建草稿</button>
              <button type="button" class="secondary" id="taskCancelBtn">取消</button>
            </div>
          </form>
        </div>
      </div>`;
    const form = $("#taskForm");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const title = form.title.value.trim();
      if (!title) { toast("请填写任务标题", true); return; }
      try {
        store.commit(`新建任务：${title}`, (s) => {
          s.tasks.push(D.createTask({
            siteId: site.id,
            diveId: form.diveId.value || null,
            title,
            detail: form.detail.value.trim(),
            createdBy: s.actor,
          }));
        });
        closeModal();
        toast("任务草稿已创建，可在任务面板提交");
      } catch (e) {
        toast(e.message, true);
      }
    });
    $("#taskCancelBtn").onclick = closeModal;
    $(".modal-mask", modalRoot).addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("modal-mask")) closeModal();
    });
    modalRoot.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    $("#tf-title").focus();
  }

  /* ---------------- 渲染：资源与天气 ---------------- */

  function renderResources(state) {
    const site = currentSite(state);
    const root = $("#panel-resources");
    if (!site) {
      root.innerHTML = `
        <div class="card"><h2>遗址</h2>
          <form id="siteForm" class="inline-form">
            <label>遗址名称<input name="name" data-fkey="site-name" required></label>
            <div><button type="submit">新建遗址</button></div>
          </form>
        </div>`;
      bindSiteForm(null);
      return;
    }
    root.innerHTML = `
      <div class="card">
        <h2>遗址信息</h2>
        <form id="siteForm" class="inline-form">
          <label>名称<input name="name" data-fkey="site-name" value="${esc(site.name)}" required></label>
          <label>位置<input name="location" data-fkey="site-loc" value="${esc(site.location)}"></label>
          <label>深度上限（m）<input name="depthLimitM" data-fkey="site-depth" type="number" min="1" max="100" value="${esc(site.depthLimitM)}"></label>
          <div class="row-actions">
            <button type="submit" class="small">保存遗址信息</button>
            <button type="button" class="small ghost" id="newSiteBtn">新建遗址</button>
          </div>
        </form>
      </div>
      <div class="card">
        <h2>人员</h2>
        <div class="table-wrap"><table class="res-table">
          <thead><tr><th>姓名</th><th>角色</th><th>SAC(L/min)</th><th>深度上限(m)</th><th></th></tr></thead>
          <tbody>${site.personnel.map((p) => `
            <tr><td>${esc(p.name)}</td><td>${esc(p.role)}</td><td>${esc(p.sacRate)}</td><td>${esc(p.maxDepthM)}</td>
            <td><button type="button" class="small danger" data-del="personnel" data-id="${esc(p.id)}" data-fkey="del-p-${esc(p.id)}">删除</button></td></tr>`).join("")}
          </tbody></table></div>
        <form id="personForm" class="inline-form">
          <label>姓名<input name="name" data-fkey="p-name" required></label>
          <label>角色<input name="role" data-fkey="p-role" value="考古潜水员"></label>
          <label>SAC(L/min)<input name="sacRate" data-fkey="p-sac" type="number" min="5" max="60" value="20"></label>
          <label>深度上限(m)<input name="maxDepthM" data-fkey="p-depth" type="number" min="6" max="60" value="30"></label>
          <div><button type="submit" class="small">添加人员</button></div>
        </form>
      </div>
      <div class="card">
        <h2>气瓶</h2>
        <div class="table-wrap"><table class="res-table">
          <thead><tr><th>编号</th><th>容积(L)</th><th>压力(bar)</th><th>气体</th><th>可用气量(L)</th><th></th></tr></thead>
          <tbody>${site.cylinders.map((c) => `
            <tr><td>${esc(c.code)}</td><td>${esc(c.capacityL)}</td><td>${esc(c.pressureBar)}</td><td>${esc(c.gasType)}</td>
            <td>${Math.round(c.capacityL * c.pressureBar)}</td>
            <td><button type="button" class="small danger" data-del="cylinders" data-id="${esc(c.id)}" data-fkey="del-c-${esc(c.id)}">删除</button></td></tr>`).join("")}
          </tbody></table></div>
        <form id="cylForm" class="inline-form">
          <label>编号<input name="code" data-fkey="c-code" required></label>
          <label>容积(L)<input name="capacityL" data-fkey="c-cap" type="number" min="1" max="30" value="12"></label>
          <label>压力(bar)<input name="pressureBar" data-fkey="c-bar" type="number" min="0" max="300" value="200"></label>
          <label>气体<input name="gasType" data-fkey="c-gas" value="空气"></label>
          <div><button type="submit" class="small">添加气瓶</button></div>
        </form>
      </div>
      <div class="card">
        <h2>天气窗口</h2>
        <div class="table-wrap"><table class="res-table">
          <thead><tr><th>日期</th><th>窗口</th><th>风速(节)</th><th>浪高(m)</th><th>能见度(m)</th><th>备注</th><th></th></tr></thead>
          <tbody>${site.weather.map((w) => {
            const bad = w.windKts > D.WEATHER_LIMITS.windKts || w.waveM > D.WEATHER_LIMITS.waveM || w.visM < D.WEATHER_LIMITS.visM;
            return `<tr${bad ? ' style="background:#fbe7e5"' : ""}>
              <td>${esc(w.date)}</td><td>${esc(w.windowStart)}–${esc(w.windowEnd)}</td>
              <td>${esc(w.windKts)}</td><td>${esc(w.waveM)}</td><td>${esc(w.visM)}</td><td>${esc(w.note || "")}</td>
              <td><button type="button" class="small danger" data-del="weather" data-id="${esc(w.id)}" data-fkey="del-w-${esc(w.id)}">删除</button></td></tr>`;
          }).join("")}
          </tbody></table></div>
        <p class="muted">安全阈值：风速 ≤ ${D.WEATHER_LIMITS.windKts} 节，浪高 ≤ ${D.WEATHER_LIMITS.waveM}m，能见度 ≥ ${D.WEATHER_LIMITS.visM}m。超限行已标红。</p>
        <form id="wxForm" class="inline-form">
          <label>日期<input name="date" data-fkey="w-date" type="date" required></label>
          <label>窗口开始<input name="windowStart" data-fkey="w-start" type="time" value="07:00"></label>
          <label>窗口结束<input name="windowEnd" data-fkey="w-end" type="time" value="12:00"></label>
          <label>风速(节)<input name="windKts" data-fkey="w-wind" type="number" min="0" max="60" value="8"></label>
          <label>浪高(m)<input name="waveM" data-fkey="w-wave" type="number" min="0" max="10" step="0.1" value="0.5"></label>
          <label>能见度(m)<input name="visM" data-fkey="w-vis" type="number" min="0" max="50" value="8"></label>
          <label class="span2">备注<input name="note" data-fkey="w-note"></label>
          <div><button type="submit" class="small">添加天气</button></div>
        </form>
      </div>
      <div class="card">
        <h2>潜次依赖</h2>
        ${depListHTML(site)}
        <form id="depForm" class="inline-form">
          <label>前置潜次<select name="predId" data-fkey="dep-pred">
            ${site.dives.map((d) => `<option value="${esc(d.id)}">${esc(d.code)}</option>`).join("")}
          </select></label>
          <label>后续潜次<select name="succId" data-fkey="dep-succ">
            ${site.dives.map((d) => `<option value="${esc(d.id)}">${esc(d.code)}</option>`).join("")}
          </select></label>
          <label class="span2">原因<input name="reason" data-fkey="dep-reason" placeholder="例如：取样须等测绘完成"></label>
          <div><button type="submit" class="small">添加依赖</button></div>
        </form>
      </div>`;

    bindSiteForm(site);
    bindResourceForms(site);
    root.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = () => {
        try {
          store.commit(`删除${btn.dataset.del}记录`, (s) => {
            const st = s.sites.find((x) => x.id === site.id);
            const list = st[btn.dataset.del];
            st[btn.dataset.del] = list.filter((x) => x.id !== btn.dataset.id);
            // 级联清理引用
            if (btn.dataset.del === "personnel") {
              for (const d of st.dives) d.diverIds = d.diverIds.filter((id) => id !== btn.dataset.id);
            }
            if (btn.dataset.del === "cylinders") {
              for (const d of st.dives) d.cylinderIds = d.cylinderIds.filter((id) => id !== btn.dataset.id);
            }
          });
          toast("已删除（可撤销）");
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
    root.querySelectorAll("[data-dep-del]").forEach((btn) => {
      btn.onclick = () => {
        try {
          store.commit("删除依赖", (s) => {
            const st = s.sites.find((x) => x.id === site.id);
            st.dependencies = st.dependencies.filter((x) => x.id !== btn.dataset.depDel);
          });
          toast("依赖已删除（可撤销）");
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  }

  function bindSiteForm(site) {
    const form = $("#siteForm");
    if (!form) return;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = form.name.value.trim();
      if (!name) { toast("请填写遗址名称", true); return; }
      if (site) {
        store.commit(`更新遗址信息：${name}`, (s) => {
          const st = s.sites.find((x) => x.id === site.id);
          st.name = name;
          st.location = form.location.value.trim();
          st.depthLimitM = Number(form.depthLimitM.value) || st.depthLimitM;
        });
        toast("遗址信息已保存");
      } else {
        store.commit(`新建遗址：${name}`, (s) => {
          const ns = D.createSite(name);
          s.sites.push(ns);
          ui.siteId = ns.id;
        });
        toast("遗址已创建");
      }
    });
    const newBtn = $("#newSiteBtn");
    if (newBtn) {
      newBtn.onclick = () => {
        store.commit("新建遗址", (s) => {
          const ns = D.createSite("新遗址 " + (s.sites.length + 1));
          s.sites.push(ns);
          ui.siteId = ns.id;
        });
        toast("已创建新遗址，请在右侧完善信息");
      };
    }
  }

  function bindResourceForms(site) {
    const personForm = $("#personForm");
    if (personForm) personForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = personForm.name.value.trim();
      if (!name) { toast("请填写姓名", true); return; }
      store.commit(`添加人员：${name}`, (s) => {
        s.sites.find((x) => x.id === site.id).personnel.push({
          id: D.uid("p"), name,
          role: personForm.role.value.trim() || "潜水员",
          sacRate: Number(personForm.sacRate.value) || 20,
          maxDepthM: Number(personForm.maxDepthM.value) || 30,
        });
      });
      toast("人员已添加");
    });

    const cylForm = $("#cylForm");
    if (cylForm) cylForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const code = cylForm.code.value.trim();
      if (!code) { toast("请填写气瓶编号", true); return; }
      store.commit(`添加气瓶：${code}`, (s) => {
        s.sites.find((x) => x.id === site.id).cylinders.push({
          id: D.uid("c"), code,
          capacityL: Number(cylForm.capacityL.value) || 12,
          pressureBar: Number(cylForm.pressureBar.value) || 200,
          gasType: cylForm.gasType.value.trim() || "空气",
        });
      });
      toast("气瓶已添加");
    });

    const wxForm = $("#wxForm");
    if (wxForm) wxForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!wxForm.date.value) { toast("请选择日期", true); return; }
      store.commit(`添加天气：${wxForm.date.value}`, (s) => {
        s.sites.find((x) => x.id === site.id).weather.push({
          id: D.uid("w"),
          date: wxForm.date.value,
          windowStart: wxForm.windowStart.value,
          windowEnd: wxForm.windowEnd.value,
          windKts: Number(wxForm.windKts.value) || 0,
          waveM: Number(wxForm.waveM.value) || 0,
          visM: Number(wxForm.visM.value) || 0,
          note: wxForm.note.value.trim(),
        });
      });
      toast("天气窗口已添加");
    });

    const depForm = $("#depForm");
    if (depForm) depForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const predId = depForm.predId.value;
      const succId = depForm.succId.value;
      const err = D.checkDependency(site, predId, succId);
      if (err) { toast(err, true); return; }
      store.commit("添加依赖", (s) => {
        s.sites.find((x) => x.id === site.id).dependencies.push({
          id: D.uid("dep"), predId, succId,
          reason: depForm.reason.value.trim(),
        });
      });
      toast("依赖已添加");
    });
  }

  /* ---------------- 渲染：冲突 ---------------- */

  function conflictItemHTML(c) {
    const title = {
      "tasks": "任务",
      "site.meta": "遗址信息",
      "site.personnel": "人员",
      "site.cylinders": "气瓶",
      "site.weather": "天气",
      "site.dives": "潜次",
      "site.dependencies": "依赖",
    }[c.collection] || c.collection;
    return `
      <div class="conflict-item">
        <div><strong>${esc(title)}</strong> <span class="muted">${esc(c.key)}</span></div>
        <div class="diff-cols">
          <div><h4>本地版本</h4><pre>${esc(JSON.stringify(c.local, null, 1))}</pre></div>
          <div><h4>对方版本</h4><pre>${esc(JSON.stringify(c.remote, null, 1))}</pre></div>
        </div>
        <div class="row-actions">
          <button type="button" class="small ghost" data-conflict-choice="local" data-conflict-key="${esc(c.key)}" data-fkey="cf-local-${esc(c.key)}">保留本地</button>
          <button type="button" class="small" data-conflict-choice="remote" data-conflict-key="${esc(c.key)}" data-fkey="cf-remote-${esc(c.key)}">采用对方</button>
        </div>
      </div>`;
  }

  /* ---------------- 渲染：审计 ---------------- */

  function renderAudit(state) {
    const root = $("#panel-audit");
    const rows = state.audit
      .slice()
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .map((a) => `
        <tr>
          <td>${esc(a.ts.slice(0, 19).replace("T", " "))}</td>
          <td>${esc(a.actor)}</td>
          <td>${esc(a.action)}</td>
          <td>${esc(a.detail)}</td>
        </tr>`)
      .join("");
    root.innerHTML = `
      <div class="card">
        <h2>审计留痕（${state.audit.length} 条）</h2>
        <p class="muted">审计日志只增不减：撤销/重做本身也会留痕。导入合并时会并入对方审计。</p>
        <div class="table-wrap"><table class="audit-table">
          <thead><tr><th>时间</th><th>操作人</th><th>类型</th><th>内容</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="muted">暂无记录</td></tr>`}</tbody>
        </table></div>
      </div>`;
  }

  /* ---------------- 帮助弹窗 ---------------- */

  function openHelpModal() {
    const modalRoot = $("#modalRoot");
    modalRoot.innerHTML = `
      <div class="modal-mask" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
          <h2 id="helpTitle">键盘快捷键</h2>
          <table class="res-table">
            <tbody>
              <tr><td><span class="kbd">Ctrl/⌘+Z</span></td><td>撤销</td></tr>
              <tr><td><span class="kbd">Ctrl/⌘+Shift+Z</span> 或 <span class="kbd">Ctrl+Y</span></td><td>重做</td></tr>
              <tr><td><span class="kbd">Alt+1..4</span></td><td>切换标签页</td></tr>
              <tr><td><span class="kbd">N</span></td><td>新建潜次（排期页）</td></tr>
              <tr><td><span class="kbd">T</span></td><td>新建任务（任务页）</td></tr>
              <tr><td><span class="kbd">?</span></td><td>打开本帮助</td></tr>
              <tr><td><span class="kbd">Esc</span></td><td>关闭弹窗</td></tr>
              <tr><td><span class="kbd">Tab</span> / <span class="kbd">Shift+Tab</span></td><td>在控件间移动，<span class="kbd">Enter</span>/<span class="kbd">空格</span> 触发按钮</td></tr>
            </tbody>
          </table>
          <div class="row-actions" style="margin-top:10px">
            <button type="button" id="helpCloseBtn">关闭</button>
          </div>
        </div>
      </div>`;
    $("#helpCloseBtn").onclick = closeModal;
    $(".modal-mask", modalRoot).addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("modal-mask")) closeModal();
    });
    modalRoot.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    $("#helpCloseBtn").focus();
  }

  /* ---------------- 标签页 ---------------- */

  const TABS = ["schedule", "tasks", "resources", "audit"];

  function switchTab(tab) {
    if (!TABS.includes(tab)) return;
    ui.tab = tab;
    document.querySelectorAll(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tab === tab);
    });
    for (const t of TABS) {
      $("#panel-" + t).hidden = t !== tab;
    }
    renderActive(store.getState());
  }

  function renderActive(state) {
    withFocus(() => {
      if (ui.tab === "schedule") renderSchedule(state);
      else if (ui.tab === "tasks") renderTasks(state);
      else if (ui.tab === "resources") renderResources(state);
      else if (ui.tab === "audit") renderAudit(state);
    });
  }

  function render(state) {
    if (!currentSite(state) && state.sites.length) ui.siteId = state.sites[0].id;
    if (!ui.siteId && state.sites.length) ui.siteId = state.sites[0].id;
    renderHeader(state);
    renderActive(state);
  }

  /* ---------------- 快捷键 ---------------- */

  function onGlobalKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (store.undo()) toast("已撤销");
      return;
    }
    if ((mod && e.shiftKey && e.key.toLowerCase() === "z") || (mod && e.key.toLowerCase() === "y")) {
      e.preventDefault();
      if (store.redo()) toast("已重做");
      return;
    }
    if (e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      switchTab(TABS[Number(e.key) - 1]);
      return;
    }
    if (typing || mod || e.altKey) return;
    if (e.key === "?") { e.preventDefault(); openHelpModal(); return; }
    if (e.key.toLowerCase() === "n" && ui.tab === "schedule") {
      e.preventDefault();
      if (currentSite(store.getState())) openDiveModal(null);
      return;
    }
    if (e.key.toLowerCase() === "t" && ui.tab === "tasks") {
      e.preventDefault();
      openTaskModal();
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init(storeInstance) {
    store = storeInstance;
    const state = store.getState();
    ui.siteId = state.sites[0] ? state.sites[0].id : null;

    document.querySelectorAll(".tab").forEach((el) => {
      el.onclick = () => switchTab(el.dataset.tab);
    });
    switchTab(ui.tab);

    $("#siteSelect").addEventListener("change", (e) => {
      ui.siteId = e.target.value;
      render(store.getState());
    });
    $("#actorInput").addEventListener("change", (e) => {
      store.setActor(e.target.value);
      toast("署名已更新：" + store.getState().actor);
    });
    $("#undoBtn").onclick = () => { if (store.undo()) toast("已撤销"); };
    $("#redoBtn").onclick = () => { if (store.redo()) toast("已重做"); };
    $("#exportBtn").onclick = () => {
      const blob = new Blob([store.exportJSON()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "uw-arch-scheduler-export.json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("已导出 JSON");
    };
    $("#importBtn").onclick = () => $("#importFile").click();
    $("#importFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const report = store.importJSON(String(reader.result));
          toast(
            `导入完成：新增 ${report.added.length} 项，跳过 ${report.skipped.length} 项，冲突 ${report.conflicts.length} 项` +
            (report.conflicts.length ? "，请在排期页解决" : "")
          );
        } catch (err) {
          toast(err.message, true);
        }
        e.target.value = "";
      };
      reader.readAsText(file);
    });
    $("#helpBtn").onclick = openHelpModal;
    document.addEventListener("keydown", onGlobalKeydown);

    store.subscribe(render);
    render(store.getState());
  }

  window.UI = { init, switchTab, _toast: toast };
})();

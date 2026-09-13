/* domain.test.js —— 领域逻辑单元测试（node --test） */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/domain.js");

/* ---------- 测试夹具 ---------- */
function makeState() {
  // 固定站点 id，保证两次 makeState() 可互相合并
  const site = D.createSite("测试遗址", { id: "site1", location: "试验海域", depthLimitM: 30 });
  const p1 = { id: "p1", name: "甲", role: "潜水监督", sacRate: 20, maxDepthM: 40 };
  const p2 = { id: "p2", name: "乙", role: "潜水员", sacRate: 20, maxDepthM: 30 };
  const p3 = { id: "p3", name: "丙", role: "潜水员", sacRate: 30, maxDepthM: 20 };
  site.personnel.push(p1, p2, p3);
  // 两只 12L×200bar = 4800L；一只 2L×50bar = 100L（不够用）
  site.cylinders.push(
    { id: "c1", code: "瓶1", capacityL: 12, pressureBar: 200, gasType: "空气" },
    { id: "c2", code: "瓶2", capacityL: 12, pressureBar: 200, gasType: "空气" },
    { id: "c3", code: "瓶3", capacityL: 2, pressureBar: 50, gasType: "空气" }
  );
  site.weather.push(
    { id: "w1", date: "2026-09-14", windKts: 8, waveM: 0.5, visM: 8, windowStart: "07:00", windowEnd: "12:00", note: "" },
    { id: "w2", date: "2026-09-15", windKts: 20, waveM: 2.0, visM: 1, windowStart: "08:00", windowEnd: "11:00", note: "恶劣" }
  );
  const d1 = D.createDive({
    id: "d1", code: "D1", date: "2026-09-14", start: "08:00", end: "09:00",
    depthM: 18, diverIds: ["p1"], cylinderIds: ["c1", "c2"], status: "scheduled",
  });
  site.dives.push(d1);
  return { version: 1, actor: "测试", sites: [site], tasks: [], audit: [], mergeConflicts: [] };
}

function diveDraft(over) {
  // 基线：15m / 40min / SAC20 -> 需求 20×2.5×40×1.5 = 3000L < 4800L，校验应通过
  return D.createDive(Object.assign({
    id: "d2", code: "D2", date: "2026-09-14", start: "10:00", end: "10:40",
    depthM: 15, diverIds: ["p2"], cylinderIds: ["c1", "c2"], status: "planned",
  }, over));
}

/* ---------- 1. 时间重叠 ---------- */
test("时间重叠：同一潜水员同时段被查重", () => {
  const s = makeState();
  const r = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    start: "08:30", end: "09:30", diverIds: ["p1"],
  }));
  assert.ok(r.errors.some((m) => m.includes("时间重叠") && m.includes("甲")));
});

test("时间重叠：不同时段或不同潜水员不报错误", () => {
  const s = makeState();
  const ok = D.validateDivePlan(s, s.sites[0].id, diveDraft({ diverIds: ["p2"] }));
  assert.equal(ok.errors.length, 0);
  // 时段重叠但人员不同 -> 仅警告
  const warn = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    start: "08:30", end: "09:30", diverIds: ["p2"],
  }));
  assert.equal(warn.errors.length, 0);
  assert.ok(warn.warnings.some((m) => m.includes("并行")));
});

/* ---------- 2. 耗气 ---------- */
test("耗气：气瓶不足被拦截", () => {
  const s = makeState();
  // p3 SAC=30，18m 潜 60 分钟：30 × 2.8 × 60 × 1.5 = 7560L > 4800L
  const r = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    diverIds: ["p3"], depthM: 18, end: "11:00",
  }));
  assert.ok(r.errors.some((m) => m.includes("耗气不足")));
});

test("耗气：气量充足通过；余量偏低给警告；未指派气瓶报错", () => {
  const s = makeState();
  const ok = D.validateDivePlan(s, s.sites[0].id, diveDraft({ diverIds: ["p2"] }));
  assert.equal(ok.errors.length, 0);

  // 60 分钟：需求 4500L，可用 4800L，余量 <30% -> 警告但不拦截
  const low = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    diverIds: ["p2"], end: "11:00",
  }));
  assert.equal(low.errors.length, 0);
  assert.ok(low.warnings.some((m) => m.includes("余量偏低")));

  const none = D.validateDivePlan(s, s.sites[0].id, diveDraft({ cylinderIds: [] }));
  assert.ok(none.errors.some((m) => m.includes("未指派气瓶")));
});

test("耗气：超出个人证书深度上限被拦截", () => {
  const s = makeState();
  const r = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    depthM: 25, diverIds: ["p3"], cylinderIds: ["c1", "c2"], // p3 上限 20m
  }));
  assert.ok(r.errors.some((m) => m.includes("丙") && m.includes("上限")));
});

/* ---------- 3. 天气窗口 ---------- */
test("天气窗口：超出窗口 / 超限天气被拦截，无记录给警告", () => {
  const s = makeState();
  const outside = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    start: "11:00", end: "12:30", // 窗口到 12:00
  }));
  assert.ok(outside.errors.some((m) => m.includes("超出天气窗口")));

  const badWx = D.validateDivePlan(s, s.sites[0].id, diveDraft({
    date: "2026-09-15", start: "08:30", end: "09:30",
  }));
  assert.ok(badWx.errors.some((m) => m.includes("风速")));
  assert.ok(badWx.errors.some((m) => m.includes("浪高")));
  assert.ok(badWx.errors.some((m) => m.includes("能见度")));

  const noWx = D.validateDivePlan(s, s.sites[0].id, diveDraft({ date: "2026-09-20" }));
  assert.equal(noWx.errors.length, 0);
  assert.ok(noWx.warnings.some((m) => m.includes("无天气记录")));
});

/* ---------- 4. 依赖顺序 ---------- */
test("依赖顺序：前置排在后面报错；未完成给警告；已完成通过", () => {
  const s = makeState();
  const site = s.sites[0];
  const d2 = diveDraft({ id: "d2", start: "10:00", end: "11:00" });
  site.dives.push(d2);
  site.dependencies.push({ id: "dep1", predId: "d2", succId: "d1", reason: "测试依赖" });
  // d1 (08:00-09:00) 依赖 d2 (10:00-11:00) -> d1 排在 d2 前，冲突
  const r = D.validateDivePlan(s, site.id, site.dives.find((d) => d.id === "d1"));
  assert.ok(r.errors.some((m) => m.includes("依赖顺序冲突")));

  // 修正方向：d2 依赖 d1，d1 未完成 -> 警告
  site.dependencies = [{ id: "dep2", predId: "d1", succId: "d2", reason: "" }];
  const r2 = D.validateDivePlan(s, site.id, d2);
  assert.equal(r2.errors.length, 0);
  assert.ok(r2.warnings.some((m) => m.includes("尚未完成")));

  // d1 完成后警告消失
  site.dives.find((d) => d.id === "d1").status = "completed";
  const r3 = D.validateDivePlan(s, site.id, d2);
  assert.equal(r3.errors.length, 0);
  assert.ok(!r3.warnings.some((m) => m.includes("尚未完成")));
});

test("依赖：自环、重复、循环依赖被拦截", () => {
  const s = makeState();
  const site = s.sites[0];
  site.dives.push(diveDraft({ id: "d2" }), diveDraft({ id: "d3", code: "D3" }));
  assert.ok(D.checkDependency(site, "d1", "d1").includes("自身"));
  site.dependencies.push({ id: "x", predId: "d1", succId: "d2", reason: "" });
  assert.ok(D.checkDependency(site, "d1", "d2").includes("已存在"));
  site.dependencies.push({ id: "y", predId: "d2", succId: "d3", reason: "" });
  assert.ok(D.checkDependency(site, "d3", "d1").includes("循环"));
  assert.equal(D.checkDependency(site, "d1", "d3"), null);
});

/* ---------- 5. 任务状态机 ---------- */
test("任务流转：完整链路 draft→submitted→reviewed→approved→executing→closed", () => {
  let t = D.createTask({ title: "测试任务", createdBy: "甲", now: "2026-09-13T00:00:00Z" });
  assert.equal(t.status, "draft");
  for (const [action, expect] of [
    ["submit", "submitted"], ["review", "reviewed"], ["approve", "approved"],
    ["execute", "executing"], ["close", "closed"],
  ]) {
    t = D.transitionTask(t, action, "乙", "", "2026-09-13T01:00:00Z");
    assert.equal(t.status, expect);
  }
  assert.equal(t.history.length, 5);
  assert.deepEqual(t.history.map((h) => h.action), ["submit", "review", "approve", "execute", "close"]);
  // 终态不可再流转
  assert.throws(() => D.transitionTask(t, "close", "乙"), /跨级流转被拦截/);
});

test("重复提交被拦截", () => {
  let t = D.createTask({ title: "x" });
  t = D.transitionTask(t, "submit", "甲");
  assert.throws(() => D.transitionTask(t, "submit", "甲"), /重复提交被拦截/);
  // 复核后再提交也算重复提交
  t = D.transitionTask(t, "review", "乙");
  assert.throws(() => D.transitionTask(t, "submit", "甲"), /重复提交被拦截/);
});

test("跨级流转被拦截：草稿不能直接批准/执行/关闭，已提交不能直接批准", () => {
  const t0 = D.createTask({ title: "x" });
  for (const a of ["review", "approve", "execute", "close"]) {
    assert.throws(() => D.transitionTask(t0, a, "甲"), new RegExp("跨级流转被拦截"));
  }
  let t1 = D.transitionTask(t0, "submit", "甲");
  assert.throws(() => D.transitionTask(t1, "approve", "甲"), /跨级流转被拦截/);
  assert.throws(() => D.transitionTask(t1, "execute", "甲"), /跨级流转被拦截/);
  let t2 = D.transitionTask(t1, "review", "乙");
  assert.throws(() => D.transitionTask(t2, "close", "丙"), /跨级流转被拦截/);
});

test("退回：submitted/reviewed/approved 可退回草稿后重新提交", () => {
  let t = D.createTask({ title: "x" });
  t = D.transitionTask(t, "submit", "甲");
  t = D.transitionTask(t, "reject", "乙", "资料不全");
  assert.equal(t.status, "draft");
  t = D.transitionTask(t, "submit", "甲"); // 退回后重新提交合法
  assert.equal(t.status, "submitted");
});

/* ---------- 6. 导入合并 ---------- */
test("合并：新增追加、相同跳过、不同记冲突；审计取并集", () => {
  const local = makeState();
  const remote = makeState(); // 相同 id 体系
  // 远端：改一个人 + 新增一个人 + 新增任务 + 一条审计
  remote.sites[0].personnel[0].name = "甲（改）";
  remote.sites[0].personnel.push({ id: "p9", name: "新人", role: "记录", sacRate: 18, maxDepthM: 20 });
  remote.tasks.push(D.createTask({ id: "t9", title: "远端任务" }));
  remote.audit.push({ id: "a-remote", ts: "2026-09-13T02:00:00Z", actor: "远端", action: "commit", detail: "远端修改" });

  const { state, report } = D.mergeImport(local, remote);
  assert.ok(report.added.includes("site.personnel:p9"));
  assert.ok(report.added.includes("tasks:t9"));
  assert.ok(report.skipped.includes("site.personnel:p2")); // 未变的跳过
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].entityId, "p1");
  assert.equal(report.conflicts[0].local.name, "甲");
  assert.equal(report.conflicts[0].remote.name, "甲（改）");
  // 冲突未解决前本地保持原值
  const mergedP1 = state.sites[0].personnel.find((p) => p.id === "p1");
  assert.equal(mergedP1.name, "甲");
  // 审计并集
  assert.ok(state.audit.some((a) => a.id === "a-remote"));
});

test("冲突解决：保留本地不变，采用对方覆盖", () => {
  const local = makeState();
  const remote = makeState();
  remote.sites[0].personnel[0].sacRate = 99;
  const { state, report } = D.mergeImport(local, remote);
  const conflict = report.conflicts[0];

  // 保留本地
  D.resolveConflict(state, conflict, "local");
  assert.equal(state.sites[0].personnel[0].sacRate, 20);

  // 采用对方
  D.resolveConflict(state, conflict, "remote");
  assert.equal(state.sites[0].personnel[0].sacRate, 99);

  assert.throws(() => D.resolveConflict(state, conflict, "x"), /非法/);
});

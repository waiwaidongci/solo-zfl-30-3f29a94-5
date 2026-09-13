/* store.test.js —— 状态容器测试：撤销重做、审计留痕、持久化、导入合并（node --test） */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/domain.js");
const { createStore, memoryStorage } = require("../js/store.js");

function freshStore(storage) {
  return createStore({ storage: storage || memoryStorage(), storageKey: "test:" + Math.random() });
}

/* ---------- 撤销 / 重做 ---------- */
test("commit 进撤销栈，undo/redo 正确还原", () => {
  const store = freshStore();
  const siteId = store.getState().sites[0].id;
  const before = store.getState().sites[0].personnel.length;

  store.commit("添加人员", (s) => {
    s.sites[0].personnel.push({ id: "px", name: "新人", role: "记录", sacRate: 18, maxDepthM: 20 });
  });
  assert.equal(store.getState().sites[0].personnel.length, before + 1);
  assert.ok(store.canUndo());
  assert.ok(!store.canRedo());

  store.undo();
  assert.equal(store.getState().sites[0].personnel.length, before);
  assert.ok(store.canRedo());

  store.redo();
  assert.equal(store.getState().sites[0].personnel.length, before + 1);

  // 新 commit 清空重做栈
  store.undo();
  store.commit("另一次修改", (s) => { s.sites[0].name = "改名"; });
  assert.ok(!store.canRedo());
  assert.equal(store.getState().sites[0].id, siteId);
});

test("commit 中抛异常：状态不变、不进撤销栈", () => {
  const store = freshStore();
  const undoDepth = () => store.canUndo();
  const nameBefore = store.getState().sites[0].name;
  assert.throws(() => {
    store.commit("会失败的操作", () => { throw new Error("boom"); });
  }, /boom/);
  assert.equal(store.getState().sites[0].name, nameBefore);
  assert.equal(store.canUndo(), undoDepth());
});

/* ---------- 审计留痕 ---------- */
test("审计只增不减：commit/undo/redo 均留痕，撤销不回滚审计", () => {
  const store = freshStore();
  const base = store.getState().audit.length;
  store.commit("测试修改", (s) => { s.sites[0].name = "甲"; });
  store.undo();
  store.redo();
  const audit = store.getState().audit;
  assert.equal(audit.length, base + 3);
  assert.deepEqual(audit.slice(-3).map((a) => a.action), ["commit", "undo", "redo"]);
  assert.equal(audit[base].detail, "测试修改");
  // 再撤销两次，审计仍然只增
  store.undo();
  assert.equal(store.getState().audit.length, base + 4);
});

test("任务流转通过 commit 留痕，且可被撤销", () => {
  const store = freshStore();
  store.commit("新建任务", (s) => {
    s.tasks.push(D.createTask({ id: "t1", siteId: s.sites[0].id, title: "器材核对", createdBy: "测试" }));
  });
  store.commit("提交任务", (s) => {
    s.tasks[0] = D.transitionTask(s.tasks[0], "submit", s.actor);
  });
  assert.equal(store.getState().tasks[0].status, "submitted");
  store.undo();
  assert.equal(store.getState().tasks[0].status, "draft");
  // 重复提交拦截（经 store 层也一样）
  store.redo();
  assert.throws(() => {
    store.commit("重复提交", (s) => {
      s.tasks[0] = D.transitionTask(s.tasks[0], "submit", s.actor);
    });
  }, /重复提交被拦截/);
});

/* ---------- 持久化 ---------- */
test("持久化：同一 storage 重建 store 后状态恢复", () => {
  const storage = memoryStorage();
  const key = "test:persist";
  const s1 = createStore({ storage, storageKey: key });
  s1.commit("改名", (s) => { s.sites[0].name = "永存遗址"; });
  const s2 = createStore({ storage, storageKey: key });
  assert.equal(s2.getState().sites[0].name, "永存遗址");
});

/* ---------- 导入 / 导出 / 冲突 ---------- */
test("导出后可再导入：数据往返一致，相同内容不产生冲突", () => {
  const a = freshStore();
  a.commit("修改", (s) => { s.sites[0].location = "外海"; });
  const json = a.exportJSON();
  const parsed = JSON.parse(json);
  assert.ok(parsed.sites.length >= 1);
  assert.ok(parsed.exportedBy);

  // b 从空库导入 a 的导出 -> 全部新增；再导入一次 -> 全部跳过、零冲突
  const b = freshStore();
  b.resetAll(false);
  const r1 = b.importJSON(json);
  assert.ok(r1.added.length > 0);
  assert.equal(b.getState().sites[0].location, "外海");
  const r2 = b.importJSON(json);
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.added.length, 0);
  assert.ok(r2.skipped.length > 0);
});

test("导入合并：冲突挂起，逐项解决后清空", () => {
  const a = freshStore();
  const siteId = a.getState().sites[0].id;
  const personId = a.getState().sites[0].personnel[0].id;

  // b 是 a 的“同事”：从同一份数据出发后各自修改
  const b = createStore({ storage: memoryStorage(), storageKey: "test:peer" });
  b.resetAll(false);
  b.importJSON(a.exportJSON()); // 同步基线
  b.commit("同事修改", (s) => { s.sites[0].personnel[0].name = "同事改的名"; });

  // 本地也改同一人的另一版
  a.commit("本地修改", (s) => { s.sites[0].personnel[0].name = "本地改的名"; });

  const report = a.importJSON(b.exportJSON());
  assert.ok(report.conflicts.length >= 1);
  const c = a.getState().mergeConflicts.find((x) => x.entityId === personId);
  assert.ok(c, "人员冲突应挂起");
  // 未解决前保持本地值
  assert.equal(
    a.getState().sites.find((s) => s.id === siteId).personnel.find((p) => p.id === personId).name,
    "本地改的名"
  );

  a.resolveConflict(c.key, "remote");
  assert.equal(
    a.getState().sites.find((s) => s.id === siteId).personnel.find((p) => p.id === personId).name,
    "同事改的名"
  );
  assert.equal(a.getState().mergeConflicts.length, 0);
  // 解决冲突本身可撤销
  a.undo();
  assert.equal(
    a.getState().sites.find((s) => s.id === siteId).personnel.find((p) => p.id === personId).name,
    "本地改的名"
  );
  assert.equal(a.getState().mergeConflicts.length, 1);
});

test("导入非法 JSON 报错且状态不变", () => {
  const store = freshStore();
  const sitesBefore = store.getState().sites.length;
  assert.throws(() => store.importJSON("这不是json"), /有效的 JSON/);
  assert.equal(store.getState().sites.length, sitesBefore);
});

test("导入审计并集：对方审计并入本地", () => {
  const a = freshStore();
  const b = freshStore();
  b.commit("对方操作", (s) => { s.sites[0].name = "对方遗址"; });
  const before = a.getState().audit.length;
  a.importJSON(b.exportJSON());
  assert.ok(a.getState().audit.length > before);
  assert.ok(a.getState().audit.some((x) => x.detail === "对方操作"));
});

/* ---------- 署名 ---------- */
test("署名：设置后写入审计", () => {
  const store = freshStore();
  store.setActor("  林海  ");
  assert.equal(store.getState().actor, "林海");
  store.commit("署名测试", (s) => { s.sites[0].name = "X"; });
  assert.equal(store.getState().audit[store.getState().audit.length - 1].actor, "林海");
});

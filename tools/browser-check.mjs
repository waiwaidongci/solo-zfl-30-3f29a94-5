/*
 * tools/browser-check.mjs —— 真实浏览器走查（Playwright + Chromium）
 * 覆盖：桌面端核心流程（排班校验、任务流转、拦截、撤销重做、导入合并冲突、审计、键盘）、
 *       移动端核心流程（标签导航、建任务、提交）、file:// 直开冒烟。
 * 运行：npm run check:browser
 * 产物：tools/shots/*.png 截图 + tools/browser-check-results.md 结果报告
 * 环境：正常桌面系统先执行 npx playwright install-deps chromium 安装浏览器系统依赖；
 *       无 root 的容器可 apt-get download 相关 .deb 本地解压后用
 *       LD_LIBRARY_PATH=<解压目录>/usr/lib/aarch64-linux-gnu npm run check:browser 注入。
 */
import { chromium } from "playwright";
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "tools", "shots");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };

const results = [];
let shotIdx = 0;

function record(name, ok, note = "") {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? " —— " + note : ""}`);
}

async function shot(page, label) {
  shotIdx += 1;
  const file = `${String(shotIdx).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: path.join(SHOTS, file), fullPage: false });
  return file;
}

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      if (!file.startsWith(ROOT)) throw new Error("forbidden");
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------- 桌面端走查 ---------------- */
async function checkDesktop(browser, baseURL) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => record("页面无 JS 异常", false, String(err)));
  await page.goto(baseURL, { waitUntil: "load" });

  // 1. 首屏渲染：种子数据
  await page.waitForSelector(".dive-card");
  const h1 = await page.textContent("h1");
  record("桌面端首屏渲染", h1.includes("调度台") && (await page.locator(".dive-card").count()) === 2,
    `标题「${h1.trim()}」，潜次卡片 ${await page.locator(".dive-card").count()} 张`);

  // 2. 排班校验展示：DIVE-01 通过，DIVE-02 耗气不足 + 依赖警告
  const cards = page.locator(".dive-card");
  const t1 = await cards.nth(0).innerText();
  const t2 = await cards.nth(1).innerText();
  record("排班校验：DIVE-01 全部通过", t1.includes("校验通过"));
  record("排班校验：DIVE-02 耗气不足被标出", t2.includes("耗气不足"));
  record("排班校验：DIVE-02 依赖未完成警告", t2.includes("尚未完成"));
  await shot(page, "desktop-schedule");

  // 3. 键盘新建潜次：先制造时间重叠被拦截，再修正保存
  await page.keyboard.press("n");
  await page.waitForSelector("#diveForm");
  const focusId = await page.evaluate(() => document.activeElement.id);
  record("键盘 N 打开潜次弹窗且聚焦编号", focusId === "df-code");
  await page.keyboard.type("DIVE-09"); // 键盘输入编号
  await page.fill("#df-date", "2026-09-14");
  await page.fill("#df-start", "07:30");
  await page.fill("#df-end", "08:15");
  await page.locator('input[name="diver"]').first().check(); // 林海（与 DIVE-01 同时段）
  await page.locator('input[name="cyl"]').nth(0).check();
  await page.locator('input[name="cyl"]').nth(1).check();
  await page.selectOption("#df-status", "scheduled");
  await page.click("#diveSaveBtn");
  await page.waitForSelector("#diveCheckResult .msg-err");
  const errText = await page.textContent("#diveCheckResult");
  record("时间重叠：同时段同人被拦截", errText.includes("时间重叠") && errText.includes("林海"));
  record("拦截后潜次未落库", (await page.locator(".dive-card").count()) === 2);
  await shot(page, "desktop-dive-overlap-blocked");

  // 修正到 11:00-11:45（窗口内、不重叠），耗气：林海 18×2.8×45×1.5=3402L ≤ 两瓶 4800L
  await page.fill("#df-start", "11:00");
  await page.fill("#df-end", "11:45");
  await page.click("#diveSaveBtn");
  await page.waitForSelector("#diveForm", { state: "detached" });
  record("修正后排班成功", (await page.locator(".dive-card").count()) === 3);
  await shot(page, "desktop-dive-created");

  // 4. 撤销 / 重做（键盘）
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelectorAll(".dive-card").length === 2);
  record("Ctrl+Z 撤销新建潜次", true);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForFunction(() => document.querySelectorAll(".dive-card").length === 3);
  record("Ctrl+Shift+Z 重做恢复", true);

  // 5. 任务全流程流转
  await page.click('.tab[data-tab="tasks"]');
  await page.click("#newTaskBtn");
  await page.fill("#tf-title", "声呐设备下水前检测");
  await page.fill("#tf-detail", "检查电池与缆绳");
  await page.click('button[data-fkey="taskCreateBtn"]');
  await page.waitForSelector(".task-card");
  const flowCard = page.locator(".task-card", { hasText: "声呐设备下水前检测" });
  const flow = ["提交", "复核", "批准", "执行", "关闭"];
  let flowOk = true;
  for (const action of flow) {
    const btn = flowCard.locator("button", { hasText: action }).first();
    if (!(await btn.count())) { flowOk = false; break; }
    await btn.click();
    await page.waitForTimeout(80);
  }
  const pill = await flowCard.locator(".pill").textContent();
  record("任务全流程：提交→复核→批准→执行→关闭", flowOk && pill.includes("已关闭"));
  record("关闭后无可用操作按钮（终态）",
    (await flowCard.locator("[data-task-action]").count()) === 0);
  await shot(page, "desktop-task-closed");

  // 6. 拦截验证（真实浏览器环境中调用数据层）
  const blocked = await page.evaluate(() => {
    const s = window.appStore.getState();
    const closed = s.tasks.find((t) => t.status === "closed");
    const out = {};
    try { Domain.transitionTask(closed, "submit", "检查员"); out.dup = "未拦截"; }
    catch (e) { out.dup = e.message; }
    const draft = Domain.createTask({ title: "临时" });
    try { Domain.transitionTask(draft, "approve", "检查员"); out.skip = "未拦截"; }
    catch (e) { out.skip = e.message; }
    return out;
  });
  record("重复提交被拦截（浏览器内数据层）", blocked.dup.includes("重复提交被拦截"), blocked.dup);
  record("跨级流转被拦截（浏览器内数据层）", blocked.skip.includes("跨级流转被拦截"), blocked.skip);

  // 7. 提交按钮在提交后消失（UI 层防重复）
  await page.click('.tab[data-tab="tasks"]');
  await page.click("#newTaskBtn");
  await page.fill("#tf-title", "重复提交演示");
  await page.click('button[data-fkey="taskCreateBtn"]');
  const card2 = page.locator(".task-card", { hasText: "重复提交演示" });
  await card2.locator("button", { hasText: "提交" }).click();
  await page.waitForTimeout(80);
  record("提交后「提交」按钮消失（UI 防重复）",
    (await card2.locator("button", { hasText: "提交" }).count()) === 0);

  // 8. 审计留痕
  await page.click('.tab[data-tab="audit"]');
  const auditText = await page.textContent("#panel-audit");
  record("审计留痕包含任务流转记录", auditText.includes("任务提交") && auditText.includes("任务关闭"));
  await shot(page, "desktop-audit");

  // 9. 导出 -> 改一份“同事版” -> 导入 -> 冲突 -> 采用对方
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn"),
  ]);
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  exported.sites[0].personnel[0].name = "林海（同事改）";
  exported.tasks.push({
    id: "task_ext_1", siteId: exported.sites[0].id, diveId: null,
    title: "同事补充的任务", detail: "", status: "draft",
    createdBy: "同事", createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z", history: [],
  });
  const tmpFile = path.join(SHOTS, "peer-export.json");
  await writeFile(tmpFile, JSON.stringify(exported, null, 2));
  await page.click("#importBtn");
  await page.setInputFiles("#importFile", tmpFile);
  await page.waitForSelector("#conflictBanner:not([hidden])");
  record("导入合并：冲突横幅出现", true);
  await page.click("#gotoConflicts");
  await page.waitForSelector(".conflict-item");
  await shot(page, "desktop-conflict");
  await page.locator('[data-conflict-choice="remote"]').first().click();
  await page.waitForTimeout(80);
  const merged = await page.evaluate(() => {
    const s = window.appStore.getState();
    return {
      name: s.sites[0].personnel[0].name,
      conflicts: s.mergeConflicts.length,
      hasExtTask: s.tasks.some((t) => t.id === "task_ext_1"),
    };
  });
  record("冲突解决：采用对方后姓名已更新", merged.name === "林海（同事改）", merged.name);
  record("冲突解决后待办清零", merged.conflicts === 0);
  record("导入合并：对方新增任务已并入", merged.hasExtTask);

  // 10. 帮助弹窗与 Esc
  await page.keyboard.press("?");
  await page.waitForSelector("#helpTitle");
  await shot(page, "desktop-help");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#helpTitle", { state: "detached" });
  record("? 打开帮助、Esc 关闭", true);

  await ctx.close();
}

/* ---------------- 移动端走查 ---------------- */
async function checkMobile(browser, baseURL) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, locale: "zh-CN",
    hasTouch: true, isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  });
  const page = await ctx.newPage();
  await page.goto(baseURL, { waitUntil: "load" });
  await page.waitForSelector(".dive-card");

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record("移动端无横向溢出", overflow <= 1, `溢出 ${overflow}px`);
  await shot(page, "mobile-schedule");

  await page.tap('.tab[data-tab="tasks"]');
  await page.tap("#newTaskBtn");
  await page.fill("#tf-title", "移动端创建的任务");
  await page.tap('button[data-fkey="taskCreateBtn"]');
  await page.waitForSelector(".task-card");
  const card = page.locator(".task-card", { hasText: "移动端创建的任务" });
  await card.locator("button", { hasText: "提交" }).tap();
  await page.waitForTimeout(80);
  const pill = await card.locator(".pill").textContent();
  record("移动端核心流程：建任务并提交", pill.includes("已提交"));
  await shot(page, "mobile-task-submitted");

  // 移动端标签切换
  await page.tap('.tab[data-tab="resources"]');
  const resVisible = await page.isVisible("#panel-resources .res-table");
  record("移动端资源页可访问", resVisible);
  await shot(page, "mobile-resources");
  await ctx.close();
}

/* ---------------- file:// 直开冒烟 ---------------- */
async function checkFileProtocol(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("file://" + path.join(ROOT, "index.html"));
  await page.waitForSelector(".dive-card", { timeout: 8000 });
  const n = await page.locator(".dive-card").count();
  let persisted = false;
  try {
    persisted = await page.evaluate(() => {
      localStorage.setItem("__probe__", "1");
      return localStorage.getItem("__probe__") === "1";
    });
  } catch { persisted = false; }
  record("file:// 直接打开可运行", n === 2, `潜次卡片 ${n} 张，localStorage ${persisted ? "可用" : "不可用（内存态兜底）"}`);
  await ctx.close();
}

/* ---------------- 主流程 ---------------- */
const { server, port } = await serve();
const baseURL = `http://127.0.0.1:${port}/`;
await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
try {
  await checkDesktop(browser, baseURL);
  await checkMobile(browser, baseURL);
  await checkFileProtocol(browser);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
const md = [
  "# 真实浏览器检查结果",
  "",
  `- 时间：${new Date().toISOString()}`,
  `- 浏览器：Chromium ${browser.version()}（Playwright ${require("playwright/package.json").version}）`,
  `- 桌面视口 1280×800，移动视口 390×844（触屏）`,
  "",
  "| # | 检查项 | 结果 | 备注 |",
  "|---|--------|------|------|",
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? "✅ 通过" : "❌ 失败"} | ${r.note || ""} |`),
  "",
  `合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项。`,
  "",
  "截图见 tools/shots/。",
  "",
].join("\n");
await writeFile(path.join(ROOT, "tools", "browser-check-results.md"), md);
console.log(`\n${failed.length ? "❌ 有失败项" : "✅ 全部通过"}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);

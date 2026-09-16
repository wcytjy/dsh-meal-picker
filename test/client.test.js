/**
 * 客户端 bundle 冒烟测试。
 *
 * 没有浏览器、没有 DSH，靠三样东西把客户端跑起来：
 *   1. 一个假的 window.__ModuleLoader__（捕获插件工厂）
 *   2. 一个假的 cordis ctx（捕获 slots.register 的注册项）
 *   3. 真的 React + react-dom/server（从 DSH 应用目录解析）
 *
 * 验证：bundle 语法正确、只注册浮层插槽、气泡/面板能渲染出预期内容、
 * 三种异常状态不白屏。拖拽与 fetch 等交互仍需在 DSH 里人工确认。
 *
 * 运行：node --test test/client.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT_FILE = path.resolve(import.meta.dirname, "../lib/client.js");

/** React 只随宿主提供，所以从几个已知位置里找 */
const REACT_DIRS = [
  process.env.DSH_REACT_DIR,
  "D:\\dsh\\DSH Desktop\\resources\\app\\node_modules",
  path.resolve(import.meta.dirname, "../node_modules"),
].filter((d) => typeof d === "string" && d.length > 0);

function findReactDir() {
  for (const d of REACT_DIRS) {
    if (existsSync(path.join(d, "react", "package.json"))) return d;
  }
  return null;
}

const reactDir = findReactDir();
const skip = reactDir === null
  ? "找不到 React（设 DSH_REACT_DIR 环境变量指向包含 react 的 node_modules）"
  : false;

/** 造一个够用的假 document（客户端 bundle 会往里插一段 <style>） */
function fakeDocument() {
  const styles = [];
  return {
    styles,
    querySelector() { return null; },
    createElement(tag) {
      return {
        tagName: tag,
        attrs: {},
        textContent: "",
        style: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        append() {},
        select() {},
        remove() {},
      };
    },
    head: { append(el) { styles.push(el); } },
    body: { append() {} },
    execCommand() { return true; },
  };
}

/** 假的 localStorage，能记住位置 */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

/** 加载客户端 bundle，返回它的 exports */
async function loadBundle(React) {
  let captured = null;
  const win = {
    __ModuleLoader__: { load(spec) { captured = spec; } },
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: fakeStorage(),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = win;
  globalThis.document = fakeDocument();
  // Node 24 里 navigator 是 global 上的只读 getter，必须用 defineProperty
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });

  // 加个 query 绕过模块缓存，保证每次都是全新执行
  await import(pathToFileURL(CLIENT_FILE).href + "?t=" + Date.now());
  assert.ok(captured !== null, "bundle 没有调用 window.__ModuleLoader__.load");

  const fakeRequire = (id) => {
    if (id === "react") return React;
    throw new Error("客户端 bundle 只应 require('react')，实际 require 了：" + id);
  };
  return { spec: captured, exports: captured.factory(fakeRequire) };
}

/** 用假的 ctx 跑 apply，返回注册表 */
function applyWith(moduleExports) {
  const registrations = [];
  const injections = [];
  const ctx = {
    slots: {
      inject(name, fn) {
        injections.push(name);
        return fn();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    bail() { return true; },
  };
  moduleExports.apply(ctx);
  return { registrations, injections, ctx };
}

async function harness() {
  const require = createRequire(import.meta.url);
  const React = require(path.join(reactDir, "react"));
  const server = require(path.join(reactDir, "react-dom/server"));
  const { spec, exports: mod } = await loadBundle(React);
  const { registrations, injections } = applyWith(mod);
  return { React, server, spec, mod, registrations, injections };
}

test("客户端 bundle 结构正确：id / inject / apply 齐全", { skip }, async () => {
  const { spec, mod } = await harness();
  assert.equal(spec.id, "dsh-meal-picker");
  assert.equal(typeof spec.factory, "function");
  assert.deepEqual(mod.inject, ["slots"]);
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.__test, "object", "应提供测试钩子");
});

test("apply 只注册浮层插槽（不再动输入框）", { skip }, async () => {
  const { registrations, injections } = await harness();
  assert.deepEqual(injections, ["shell.overlay"], "只应注入浮层插槽");
  assert.equal(registrations.length, 1);

  const opt = registrations[0].options;
  assert.equal(opt.name, "shell.overlay");
  assert.equal(opt.id, "meal-picker");
  assert.equal(typeof opt.order, "number");

  // 明确断言没有注册到输入框相关插槽
  for (const r of registrations) {
    assert.ok(!r.options.name.startsWith("conversation.input"),
      "不该再往输入框旁边塞东西");
  }
});

test("气泡渲染出图标与悬浮样式，收藏数显示为角标", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  mod.__test.set({ favorites: [], open: false });
  let html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /mp-bubble/);
  assert.match(html, /mp-bubble-icon/, "应显示图标");
  assert.match(html, /\/dsh-meal\/icon\.png/, "图标应指向宿主侧提供的 PNG");
  assert.match(html, /今天吃什么/, "应有 title/aria-label");
  assert.ok(!html.includes("mp-fav-badge"), "没有收藏时不该有角标");
  assert.match(html, /position:fixed|left:\d+px/, "应是固定定位的悬浮元素");

  mod.__test.set({ favorites: ["红烧肉", "宫保鸡丁"] });
  html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /mp-fav-badge/, "有收藏时应显示角标");
  assert.match(html, />2</, "角标数字应等于收藏数");
});

/** 两个面板共用的状态夹具 */
function panelState(extra = {}) {
  return {
    open: true,
    mode: "picks",
    loading: false,
    error: "",
    empty: false,
    toast: "",
    relax: "",
    pool: 412,
    region: "四川菜",
    mainstreamCount: 2,
    groupInfo: { mainstream: 99, favorites: 2, preferred: 101, others: 3901, total: 4002 },
    favorites: ["红烧肉"],
    favPersisted: true,
    mealNow: "lunch",
    mealLabel: { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", lateNight: "夜宵" },
    opts: {
      scene: "cook", foreign: "any", city: "成都", cuisine: "", method: "", meal: "auto",
      avoid: "", favOnly: false, favBoost: 5,
    },
    meta: {
      ok: true,
      config: { mainstreamCount: 2, favBoost: 5, meal: "auto" },
      cuisines: [{ cuisine: "家常菜", count: 475 }, { cuisine: "四川菜", count: 112 }],
      methods: [{ method: "炒", count: 506 }, { method: "蒸", count: 138 }],
      methodsTagged: 2173,
    },
    items: [{
      name: "红烧肉", cuisine: "家常菜", methods: ["烧"], star: 5, scene: "home",
      foreign: false, favorite: true,
      recipeUrl: "https://www.xiachufang.com/search/?keyword=%E7%BA%A2%E7%83%A7%E8%82%89",
      recipePrompt: "「红烧肉」怎么做？给我家常做法：主要食材、简要步骤、大概耗时。",
      nutritionPrompt: "「红烧肉」的热量：每 100 克大约多少千卡？",
    }, {
      name: "某冷门菜", cuisine: "甘肃菜", methods: [], star: 0, scene: "both",
      foreign: false, favorite: false,
      recipeUrl: "https://www.xiachufang.com/search/?keyword=x",
      recipePrompt: "x",
      nutritionPrompt: "x",
    }],
    ...extra,
  };
}

test("推荐面板只放菜品，不放筛选条件，也没有统计提示", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  mod.__test.set({ open: false });
  assert.equal(server.renderToStaticMarkup(widget({})).includes("mp-panel"), false,
    "关闭时不应出现面板");

  mod.__test.set(panelState());
  const html = server.renderToStaticMarkup(widget({}));

  assert.match(html, /mp-panel/, "应渲染面板");
  assert.match(html, /今天吃什么/, "标题");
  assert.match(html, /红烧肉/, "菜名");
  assert.match(html, /某冷门菜/, "第二道菜");
  assert.match(html, /主流/, "主流标记");
  assert.match(html, /AI 写做法/, "写做法按钮");
  assert.match(html, /AI 估热量/, "估热量按钮");
  assert.match(html, /搜食谱/, "搜食谱链接");
  assert.match(html, /xiachufang\.com/, "食谱链接应是下厨房");
  assert.ok(!html.includes("kcal"), "面板上不该再显示热量");
  assert.match(html, /换一批/, "换一批按钮");
  assert.match(html, /清空最近记录/, "清空最近");
  assert.match(html, /mp-fav/, "收藏星标");
  assert.match(html, /午餐/, "应显示当前餐次");

  // 顶部那个黑框按钮
  assert.match(html, /mp-filter-btn/, "应有「筛选条件」按钮");
  assert.match(html, /筛选条件/);

  // 筛选条件已经搬走，推荐面板里不该再出现
  assert.ok(!html.includes("mp-filters"), "推荐面板不该有筛选区");
  assert.ok(!html.includes("只出收藏"), "收藏开关应搬去筛选面板");
  assert.ok(!html.includes("主流保底"), "主流保底应搬去筛选面板");

  // 推荐面板不显示候选规模一类的统计
  assert.ok(!html.includes("候选 412 道"), "不该再显示候选规模");
  assert.ok(!html.includes("主流池 99 道"), "不该再显示主流池规模");
});

test("筛选面板装下全部条件，且不渲染任何菜品推荐", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  mod.__test.set(panelState({ mode: "filters" }));
  const html = server.renderToStaticMarkup(widget({}));

  assert.match(html, /mp-panel/, "应渲染面板");
  assert.match(html, /筛选条件/, "标题");
  assert.match(html, /mp-filters/, "筛选区");
  assert.match(html, /这一餐/, "餐次选择");
  assert.match(html, /自动/);
  assert.match(html, /早餐/);
  assert.match(html, /夜宵/);
  assert.match(html, /自己做/);
  assert.match(html, /点外卖/);
  assert.match(html, /换口味/);
  assert.match(html, /主流保底/, "主流保底选项");
  assert.match(html, /前 2 道/, "保底道数选项");
  assert.match(html, /只出收藏/, "收藏开关");
  assert.match(html, /收藏 ×5/, "收藏加权选项");
  assert.match(html, /四川菜/, "菜系下拉应含数据里的菜系");
  assert.match(html, /炒（506）/, "做法下拉应含做法与数量");
  assert.match(html, /永久保留/, "忌口要写明会永久保留");
  assert.match(html, /看看推荐/, "应能切回推荐面板");

  // 推荐是左键的事，筛选面板里不该有菜
  assert.ok(!html.includes("红烧肉"), "筛选面板不该出现菜品");
  assert.ok(!html.includes("AI 写做法"), "筛选面板不该出现 AI 按钮");
  assert.ok(!html.includes("换一批"), "筛选面板不该有换一批");
});

test("忌口以小标签列出，每条都能单独删", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  // 没有忌口时不显示标签区
  mod.__test.set(panelState({ mode: "filters", avoidSavedValue: "" }));
  let html = server.renderToStaticMarkup(widget({}));
  assert.ok(!html.includes("mp-chip"), "没有忌口时不该有标签");

  // 有忌口：每条一个标签 + 一个删除按钮
  mod.__test.set(panelState({ mode: "filters", avoidSavedValue: "香菜,内脏" }));
  html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /mp-chips/, "应有标签区");
  assert.match(html, /香菜/);
  assert.match(html, /内脏/);
  assert.equal((html.match(/mp-chip-x/g) || []).length, 2, "两条忌口各有一个删除按钮");
  assert.match(html, /不再忌口「香菜」/, "删除按钮要有说明");
  assert.match(html, /全部清空/, "多于一条时提供一键清空");

  // 只有一条时不给「全部清空」——那条自己的 × 就够了
  mod.__test.set(panelState({ mode: "filters", avoidSavedValue: "香菜" }));
  html = server.renderToStaticMarkup(widget({}));
  assert.equal((html.match(/mp-chip-x/g) || []).length, 1);
  assert.ok(!html.includes("全部清空"), "只有一条时不该有全部清空");
});


test("收藏面板：列出收藏并可取消，空收藏给提示", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  mod.__test.set(panelState({ mode: "favorites", favorites: [], favItems: [] }));
  let html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /我的收藏/, "标题");
  assert.match(html, /还没有收藏/, "空状态要给出怎么收藏的提示");
  assert.ok(!html.includes("取消收藏"), "空列表不该有取消按钮");

  mod.__test.set(panelState({
    mode: "favorites",
    favorites: ["红烧肉", "某冷门菜", "已删除的菜"],
    favItems: [
      { name: "红烧肉", inLibrary: true, cuisine: "家常菜", methods: ["烧"], meals: ["dinner"], star: 5 },
      { name: "某冷门菜", inLibrary: true, cuisine: "甘肃菜", methods: [], meals: [], star: 0 },
      { name: "已删除的菜", inLibrary: false },
    ],
  }));
  html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /红烧肉/);
  assert.match(html, /某冷门菜/);
  assert.match(html, /3 道/, "应显示收藏数量");
  assert.match(html, /取消收藏/, "每条都要能取消收藏");
  assert.match(html, /家常菜/, "应显示菜系");
  assert.match(html, /已不在菜库/, "菜库里没有的要标出来");
  assert.match(html, /去挑菜/, "应能切回推荐");
  assert.ok(!html.includes("换一批"), "收藏面板不该有换一批");
});

test("推荐面板有收藏入口；每道菜有肥鱼评价按钮", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  mod.__test.set(panelState({ favorites: ["红烧肉", "宫保鸡丁"] }));
  let html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /★ 2/, "收藏入口应带数量");
  assert.match(html, /肥鱼评价/, "每道菜应有肥鱼评价按钮");

  mod.__test.set(panelState({
    favorites: [],
    answers: { 红烧肉: { kind: "review", loading: false, text: "这个我要吃三碗饭！", error: "" } },
  }));
  html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /大肥鱼这么说/, "评价要用肥鱼的口吻标注");
  assert.match(html, /三碗饭/, "应显示模型返回的评价");
});

test("收藏星标：已收藏的显示实心 ★，未收藏显示空心 ☆", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;
  mod.__test.set({
    open: true, mode: "picks", loading: false, error: "", empty: false,
    toast: "", relax: "", favorites: ["红烧肉"], meta: null, groupInfo: null,
    items: [
      { name: "红烧肉", cuisine: "家常菜", star: 5,
        scene: "home", foreign: false, favorite: true, recipeUrl: "u", recipePrompt: "p", nutritionPrompt: "n" },
      { name: "某冷门菜", cuisine: "甘肃菜", star: 0,
        scene: "both", foreign: false, favorite: false, recipeUrl: "u", recipePrompt: "p", nutritionPrompt: "n" },
    ],
  });
  const html = server.renderToStaticMarkup(widget({}));
  const stars = html.match(/data-on="1"[^>]*>★/g) || [];
  assert.ok(html.includes("★"), "已收藏的应是实心星");
  assert.ok(html.includes("☆"), "未收藏的应是空心星");
  assert.equal(stars.length, 1, "只应有一个实心星");
});

test("加载中 / 出错 / 空结果 / 放宽提示 都能渲染，不会白屏", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  mod.__test.set({ open: true, loading: true, error: "", items: [], meta: null, relax: "" });
  assert.match(server.renderToStaticMarkup(widget({})), /正在挑/, "加载态");

  mod.__test.set({ open: true, loading: false, error: "网络炸了", items: [] });
  const errHtml = server.renderToStaticMarkup(widget({}));
  assert.match(errHtml, /出错了/);
  assert.match(errHtml, /网络炸了/);

  mod.__test.set({
    open: true, loading: false, error: "", empty: true,
    hint: "没有符合条件的菜", items: [], relax: "",
  });
  assert.match(server.renderToStaticMarkup(widget({})), /没有符合条件的菜/);

  mod.__test.set({
    open: true, loading: false, error: "", empty: false, relax: "收藏里没有符合当前条件的菜",
    items: [], meta: null,
  });
  assert.match(server.renderToStaticMarkup(widget({})), /收藏里没有符合当前条件的菜/);
});

test("收藏写盘失败时给出警告", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;
  mod.__test.set({ open: true, mode: "filters", favPersisted: false, items: [], meta: null });
  const html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /mp-warn/, "应显示警告");
  assert.match(html, /只存在内存里/);
});

test("apiUrl 拼参数：空值/假值不带，布尔转 1", { skip }, async () => {
  const { mod } = await harness();
  const url = mod.__test.apiUrl("/recommend", {
    scene: "takeout", cuisine: "四川菜", city: "", avoid: "", foreign: "any",
    favOnly: true, favBoost: 5, fav: "红烧肉,宫保鸡丁",
  });
  assert.ok(url.startsWith("/dsh-meal/recommend?"), url);
  assert.ok(url.includes("scene=takeout"));
  assert.ok(url.includes("cuisine=" + encodeURIComponent("四川菜")));
  assert.ok(url.includes("favOnly=1"), "true 应转成 1");
  assert.ok(url.includes("favBoost=5"));
  assert.ok(!url.includes("city="), "空值不该带进查询串");
  assert.ok(!url.includes("avoid="), "空值不该带进查询串");

  const off = mod.__test.apiUrl("/recommend", { favOnly: false });
  assert.ok(!off.includes("favOnly"), "false 不该带进查询串");
});

// 插件不往对话输入框里塞文字：DSH 的输入框封在会话作用域内，
// 插件拿不到那条通道。需要继续追问时直接说菜名即可。

test("AI 结果回来后显示在对应菜品下面，可收起", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  const base = {
    open: true, mode: "picks", loading: false, error: "", empty: false,
    toast: "", relax: "", meta: null, groupInfo: null,
    favorites: [],
    items: [{
      name: "红烧肉", cuisine: "家常菜", star: 5, scene: "home", foreign: false, favorite: false,
      recipeUrl: "u", recipePrompt: "p", nutritionPrompt: "n",
    }],
  };

  // 加载中
  mod.__test.set({ ...base, answers: { 红烧肉: { kind: "recipe", loading: true, text: "", error: "" } } });
  assert.match(server.renderToStaticMarkup(widget({})), /正在问 AI/, "应显示加载态");

  // 有结果
  mod.__test.set({
    ...base,
    answers: { 红烧肉: { kind: "recipe", loading: false, text: "主要食材：五花肉", error: "" } },
  });
  const html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /mp-answer/, "应显示结果区块");
  assert.match(html, /AI 给的做法/, "应有来源标注");
  assert.match(html, /五花肉/, "应显示模型返回的内容");
  assert.match(html, /收起/, "应能收起");

  // 出错
  mod.__test.set({
    ...base,
    answers: { 红烧肉: { kind: "nutrition", loading: false, text: "", error: "读不到默认模型" } },
  });
  const errHtml = server.renderToStaticMarkup(widget({}));
  assert.match(errHtml, /问 AI 失败/);
  assert.match(errHtml, /读不到默认模型/);

  // 收起后消失
  mod.__test.set({ ...base, answers: {} });
  assert.equal(server.renderToStaticMarkup(widget({})).includes("mp-answer"), false,
    "没有结果时不该有结果区块");
});

test("AI 结果里的热量标注为估算值", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;
  mod.__test.set({
    open: true, loading: false, error: "", empty: false, toast: "", relax: "",
    meta: null, groupInfo: null, favorites: [],
    items: [{
      name: "红烧肉", cuisine: "家常菜", star: 5, scene: "home", foreign: false, favorite: false,
      recipeUrl: "u", recipePrompt: "p", nutritionPrompt: "n",
    }],
    answers: { 红烧肉: { kind: "nutrition", loading: false, text: "每 100 克约 470 千卡", error: "" } },
  });
  const html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /估算的热量/, "必须标明是估算值");
  assert.match(html, /仅供参考/);
});

test("气泡位置夹在屏幕内", { skip }, async () => {
  const { mod } = await harness();
  const d = mod.__test.defaultPos();
  const size = mod.__test.bubbleSize();
  assert.ok(d.x > 0 && d.y > 0);
  assert.ok(d.x + size <= 1440, "默认位置应在屏幕内");

  const far = mod.__test.clampPos({ x: 99999, y: -500 });
  assert.ok(far.x < 1440 && far.x >= 12);
  assert.ok(far.y >= 12);
});

// 气泡尺寸可配置：默认 72px，配置里给多少就多大，越界要夹住。
test("气泡尺寸走配置，越界被夹到 40~140", { skip }, async () => {
  const { server, mod, registrations } = await harness();
  const widget = registrations[0].component;

  // 没拿到 meta 时用默认值
  mod.__test.set({ meta: null, bubble: null, favorites: [] });
  assert.equal(mod.__test.bubbleSize(), 72, "默认应为 72");
  let html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /width:72px;height:72px/, "按钮应按 72px 渲染");
  assert.match(html, /width:66px;height:66px/, "图标应比气泡小 6px");

  // 配置生效
  mod.__test.set({ meta: { config: { bubbleSize: 96 } } });
  assert.equal(mod.__test.bubbleSize(), 96);
  html = server.renderToStaticMarkup(widget({}));
  assert.match(html, /width:96px;height:96px/, "应按配置的 96px 渲染");

  // 越界夹住
  mod.__test.set({ meta: { config: { bubbleSize: 9999 } } });
  assert.equal(mod.__test.bubbleSize(), 140, "上限 140");
  mod.__test.set({ meta: { config: { bubbleSize: 5 } } });
  assert.equal(mod.__test.bubbleSize(), 40, "下限 40");
  mod.__test.set({ meta: { config: { bubbleSize: "不是数字" } } });
  assert.equal(mod.__test.bubbleSize(), 72, "非数字回落到默认值");

  // 夹住之后的位置计算也要用同一个尺寸，否则气泡会算出屏幕外
  const pos = mod.__test.clampPos({ x: 99999, y: 0 }, 140);
  assert.ok(pos.x <= 1440 - 140, "夹取要用传入的尺寸");
});

// useSyncExternalStore 只在快照引用变化时才重渲染。快照若一直返回同一个
// 可变对象，set 之后引用不变，React 会认为「没变化」，面板永远打不开、
// 拖动也不跟手 —— 静态渲染的测试看不出这个问题，只能直接断言这个不变量。
test("set 之后快照必须换新引用（否则 React 永不重渲染）", { skip }, async () => {
  const { mod } = await harness();
  const before = mod.__test.getSnapshot();
  assert.equal(before.open, false);

  mod.__test.set({ open: true, pool: 7 });
  const after = mod.__test.getSnapshot();

  assert.notEqual(after, before, "set 之后快照必须是新引用");
  assert.equal(after.open, true, "快照应反映新值");
  assert.equal(after.pool, 7);

  // 没有新写入时，引用必须稳定，否则会触发 React 的无限重渲染保护
  assert.equal(mod.__test.getSnapshot(), after, "同一状态下快照引用应稳定");

  // 组件读到的是快照，不是那个会被原地修改的对象
  const snapshotSeen = mod.__test.getSnapshot();
  assert.notEqual(snapshotSeen, mod.__test.store, "快照不该就是那个可变 store 本身");
  assert.notEqual(mod.__test.store.open, undefined);
});

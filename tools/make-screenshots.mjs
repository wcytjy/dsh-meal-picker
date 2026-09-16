/**
 * 生成 README / 插件市场用的截图。
 *
 * 做法：像 test/client.test.js 那样把客户端 bundle 加载起来，
 * 用固定的假数据把三个面板各自渲染成静态 HTML，套上插件自己的 CSS，
 * 再用无头浏览器截图（浏览器那一步由 npm run shots 之后的 edge 命令完成）。
 *
 * 不依赖正在运行的 DSH，也不会碰任何真实数据。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "tools", "shots");
const REACT_DIRS = [
  process.env.DSH_REACT_DIR,
  "D:\\dsh\\DSH Desktop\\resources\\app\\node_modules",
  path.join(ROOT, "node_modules"),
].filter((d) => typeof d === "string" && d.length > 0);

const reactDir = REACT_DIRS.find((d) => {
  try { readFileSync(path.join(d, "react", "package.json")); return true; } catch { return false; }
});
if (reactDir === undefined) {
  console.error("找不到 React：设 DSH_REACT_DIR 指向含 react 的 node_modules");
  process.exit(1);
}

// 1) bundle 里的 CSS 抽出来（它没挂在 exports 上）
const src = readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
const cssMatch = src.match(/const CSS = `([\s\S]*?)`;/);
if (cssMatch === null) {
  console.error("没能从 lib/client.js 里抽出 CSS");
  process.exit(1);
}
const CSS = cssMatch[1];

// 2) 加载 bundle
function fakeDocument() {
  return {
    querySelector() { return null; },
    createElement() {
      return {
        style: {}, attrs: {}, textContent: "",
        setAttribute(k, v) { this.attrs[k] = v; },
        append() {}, select() {}, remove() {},
      };
    },
    head: { append() {} }, body: { append() {} },
    execCommand() { return true; },
  };
}

const require = createRequire(import.meta.url);
const React = require(path.join(reactDir, "react"));
const server = require(path.join(reactDir, "react-dom/server"));

let captured = null;
globalThis.window = {
  __ModuleLoader__: { load(spec) { captured = spec; } },
  innerWidth: 900, innerHeight: 640,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = fakeDocument();
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true,
});

await import(pathToFileURL(path.join(ROOT, "lib", "client.js")).href + "?t=" + Date.now());
const mod = captured.factory((id) => {
  if (id === "react") return React;
  throw new Error("bundle 只应 require('react')，实际：" + id);
});
let Widget = null;
mod.apply({
  slots: {
    inject(name, fn) { return fn(); },
    register(options, component) { Widget = component; return null; },
  },
  bail() { return false; },
});
if (typeof Widget !== "function") {
  console.error("没能从 bundle 里拿到浮层组件");
  process.exit(1);
}

// 3) 假数据：用真实菜名与真实标签，看起来才像回事
const BASE = {
  open: true, loading: false, error: "", empty: false, toast: "", relax: "",
  favorites: ["红烧肉", "宫保鸡丁", "番茄炒蛋"],
  favPersisted: true, avoidPersisted: true, avoidSavedValue: "香菜,内脏",
  mealNow: "lunch",
  mealLabel: { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", lateNight: "夜宵" },
  pool: 4002, region: "四川菜",
  groupInfo: { mainstream: 99, favorites: 3, preferred: 102, others: 3900, total: 4002 },
  mainstreamCount: 2,
  opts: {
    scene: "cook", foreign: "any", city: "成都", cuisine: "", method: "", meal: "auto",
    avoid: "香菜,内脏", favOnly: false, favBoost: 5, mainstreamCount: 2,
  },
  meta: {
    config: { count: 3, mainstreamCount: 2, favBoost: 5, meal: "auto", bubbleSize: 72 },
    cuisines: [{ cuisine: "家常菜", count: 475 }, { cuisine: "四川菜", count: 112 }],
    methods: [{ method: "炒", count: 506 }, { method: "蒸", count: 138 }],
    methodsTagged: 2173,
    meals: [{ meal: "lunch", label: "午餐", count: 108 }],
    mealsTagged: 2361,
  },
  items: [
    { name: "热干面", cuisine: "湖北菜", methods: ["煮"], meals: ["lunch"], star: 5, scene: "both",
      foreign: false, favorite: false, recipeUrl: "#", recipePrompt: "", nutritionPrompt: "" },
    { name: "蛋炒饭", cuisine: "家常菜", methods: ["炒"], meals: ["lunch"], star: 5, scene: "both",
      foreign: false, favorite: false, recipeUrl: "#", recipePrompt: "", nutritionPrompt: "" },
    { name: "扣蒸酥鸡", cuisine: "私家菜", methods: ["蒸"], meals: ["dinner"], star: 0, scene: "home",
      foreign: false, favorite: false, recipeUrl: "#", recipePrompt: "", nutritionPrompt: "" },
  ],
  answers: {},
};

const FAV_ITEMS = [
  { name: "红烧肉", inLibrary: true, cuisine: "私家菜", methods: ["烧"], meals: ["dinner"], star: 5 },
  { name: "宫保鸡丁", inLibrary: true, cuisine: "家常菜", methods: [], meals: [], star: 5 },
  { name: "番茄炒蛋", inLibrary: true, cuisine: "家常菜", methods: ["炒"], meals: ["dinner"], star: 5 },
];

const SHOTS = [
  {
    file: "01-picks",
    title: "推荐面板",
    state: BASE,
  },
  {
    file: "02-filters",
    title: "筛选条件面板",
    state: { ...BASE, mode: "filters" },
  },
  {
    file: "03-favorites",
    title: "收藏面板",
    state: { ...BASE, mode: "favorites", favItems: FAV_ITEMS },
  },
  {
    file: "04-review",
    title: "大肥鱼评价",
    state: {
      ...BASE,
      answers: {
        热干面: {
          kind: "review", loading: false, error: "",
          text: "哇是热干面！芝麻酱香得我鼻子都要翘起来啦～拌开那一瞬间太幸福，本鱼能吃两碗！(๑´ڡ`๑)",
        },
      },
    },
  },
];

mkdirSync(OUT, { recursive: true });
let n = 0;
for (const shot of SHOTS) {
  mod.__test.set(shot.state);
  // 静态页面里 /dsh-meal/icon.png 取不到，把图标内联进去，否则气泡是个裂图标
  const iconData = "data:image/png;base64,"
    + readFileSync(path.join(ROOT, "assets", "whale-girl.png")).toString("base64");
  const body = server.renderToStaticMarkup(React.createElement(Widget, {}))
    .replace(/src="\/dsh-meal\/icon\.png"/g, `src="${iconData}"`);
  // 面板/气泡是 fixed 的，截图时改成绝对定位并在画布上摆好位置
  const page = `<!doctype html>
<meta charset="utf-8">
<title>${shot.title}</title>
<style>
${CSS}
html, body { margin: 0; padding: 0; }
body {
  width: 900px; height: 640px; overflow: hidden;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  background:
    radial-gradient(1200px 600px at 80% -10%, #eef2ff 0%, rgba(238,242,255,0) 60%),
    linear-gradient(160deg, #f7f8fc 0%, #eceff7 100%);
}
/* 模拟 DSH 界面右侧的一点内容，让气泡有落点 */
.mock { position: absolute; right: 40px; top: 60px; width: 420px; opacity: .5; }
.mock i { display: block; height: 12px; border-radius: 6px; background: #dfe4f0; margin-bottom: 14px; }
.mock i:nth-child(2) { width: 70%; }
.mock i:nth-child(3) { width: 88%; }
.mock i:nth-child(4) { width: 55%; }
.mp-mask { display: none !important; }
.mp-panel {
  position: absolute !important; left: 40px !important; top: 40px !important;
  bottom: auto !important; right: auto !important; transform: none !important;
}
.mp-bubble { position: absolute !important; left: 40px !important; top: 520px !important; }
</style>
<div class="mock"><i></i><i></i><i></i><i></i></div>
${body}
`;
  writeFileSync(path.join(OUT, shot.file + ".html"), page, "utf8");
  n += 1;
}
console.log(`已生成 ${n} 个截图页面 -> ${OUT}`);

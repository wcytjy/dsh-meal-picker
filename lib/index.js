/**
 * dsh-meal-picker 宿主侧（跑在 DSH 的 Node 进程里）。
 *
 * 职责：
 *   1. 读取插件自带的菜品索引（data/dishes.json）
 *   2. 注册 /dsh-meal/* HTTP 端点，供客户端半拉取
 *   3. 在宿主侧完成筛选与加权随机 —— 这样客户端 bundle 不用背 600KB 数据，
 *      而且整个过程**不经过模型，0 token**
 *
 * 端点：
 *   GET  /dsh-meal/meta        配置默认值 + 菜系列表 + 统计 + 收藏列表
 *   GET  /dsh-meal/recommend   抽菜（可带查询参数覆盖配置）
 *   POST /dsh-meal/recent      清空"最近推过"的记录
 *   GET  /dsh-meal/favorites   读收藏
 *   POST /dsh-meal/favorites   改收藏（toggle / add / remove / set / clear）
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_FAV_BOOST,
  DEFAULT_MAINSTREAM_COUNT,
  MEALS,
  MEAL_LABEL,
  buildNutritionPrompt,
  buildRecipePrompt,
  mealOfHour,
  normalizeOptions,
  pickMany,
  recipeSearchUrl,
} from "./core.js";

export const name = "dsh-meal-picker";

// webServer 是唯一硬依赖；fs 用 ctx.get() 软取，取不到就退回 node:fs
export const inject = ["webServer"];

const DATA_PATH = fileURLToPath(new URL("../data/dishes.json", import.meta.url));
// 气泡图标：随包自带（由 tools/cutout_icon.py 从白底原图抠成透明 PNG）
const ICON_PATH = fileURLToPath(new URL("../assets/whale-girl.png", import.meta.url));
const MAX_DATA_BYTES = 32 * 1024 * 1024;

/** 配置默认值（README 里有对照表） */
const DEFAULT_CONFIG = {
  city: "",
  scene: "cook",
  foreign: "any",
  avoid: "",
  method: "",
  meal: "auto",
  count: 3,
  recentLimit: 12,
  mainstreamCount: DEFAULT_MAINSTREAM_COUNT,   // 前几道必定主流
  favBoost: DEFAULT_FAV_BOOST,
  bubbleSize: 72,       // 气泡（含图标）直径，像素
};

let dishesCache = null;

// ---------------------------------------------------------------- 收藏持久化

/**
 * 收藏存在 DSH 自己的目录下（DSH_HOME/dsh-meal-picker/favorites.json），
 * 这样清浏览器数据也不会丢。写不进去就退回内存，并如实回报 persisted=false。
 */
function favoritesDir() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "dsh-meal-picker");
}

const FAV_FILE = join(favoritesDir(), "favorites.json");

function loadFavorites() {
  try {
    if (!existsSync(FAV_FILE)) return { list: [], persisted: true };
    const data = JSON.parse(readFileSync(FAV_FILE, "utf8"));
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data !== null && typeof data === "object" && Array.isArray(data.favorites)) {
      list = data.favorites;
    }
    return { list: list.filter((s) => typeof s === "string" && s.length > 0), persisted: true };
  } catch (e) {
    return { list: [], persisted: false, error: String(e && e.message ? e.message : e) };
  }
}

function saveFavorites(list) {
  try {
    mkdirSync(favoritesDir(), { recursive: true });
    const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), favorites: list }, null, 2);
    writeFileSync(FAV_FILE, payload + String.fromCharCode(10), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- 偏好持久化

const PREFS_FILE = join(favoritesDir(), "prefs.json");

/**
 * 使用者在面板里改过的长期偏好（目前只有忌口）。
 *
 * 与插件配置里的 avoid 的关系：**面板里设过就以面板为准**（哪怕设成空的，
 * 那也是「我把忌口清掉了」的意思）。没有这个文件时才用配置里的值。
 */
function loadPrefs() {
  try {
    if (!existsSync(PREFS_FILE)) return { prefs: null, persisted: true };
    const data = JSON.parse(readFileSync(PREFS_FILE, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { prefs: null, persisted: true };
    }
    const avoid = Array.isArray(data.avoid)
      ? data.avoid.filter((s) => typeof s === "string" && s.length > 0)
      : null;
    return { prefs: avoid === null ? null : { avoid }, persisted: true };
  } catch (e) {
    return { prefs: null, persisted: false, error: String(e && e.message ? e.message : e) };
  }
}

function savePrefs(prefs) {
  try {
    mkdirSync(favoritesDir(), { recursive: true });
    const payload = JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), avoid: prefs.avoid }, null, 2);
    writeFileSync(PREFS_FILE, payload + String.fromCharCode(10), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

/** 忌口词：把 "香菜,内脏" 这类输入拆成去重后的数组 */
function splitAvoid(input) {
  if (Array.isArray(input)) {
    const out = [];
    for (const s of input) {
      if (typeof s !== "string") continue;
      const t = s.trim();
      if (t !== "" && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }
  if (typeof input !== "string") return [];
  const out = [];
  for (const piece of input.split(/[,，、;；\s]+/)) {
    const t = piece.trim();
    if (t !== "" && out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampFloat(v, lo, hi, fallback) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function sanitizeConfig(raw) {
  const c = raw !== null && typeof raw === "object" ? raw : {};
  const str = (v, d) => (typeof v === "string" ? v : d);
  const scene = str(c.scene, DEFAULT_CONFIG.scene);
  const foreign = str(c.foreign, DEFAULT_CONFIG.foreign);
  return {
    city: str(c.city, DEFAULT_CONFIG.city).trim(),
    scene: scene === "takeout" ? "takeout" : "cook",
    foreign: ["any", "off", "only"].includes(foreign) ? foreign : "any",
    avoid: str(c.avoid, DEFAULT_CONFIG.avoid),
    method: str(c.method, DEFAULT_CONFIG.method).trim(),
    meal: MEALS.indexOf(c.meal) >= 0 ? c.meal : DEFAULT_CONFIG.meal,
    count: clampInt(c.count, 1, 12, DEFAULT_CONFIG.count),
    recentLimit: clampInt(c.recentLimit, 0, 100, DEFAULT_CONFIG.recentLimit),
    mainstreamCount: clampInt(c.mainstreamCount, 0, 20, DEFAULT_CONFIG.mainstreamCount),
    favBoost: clampInt(c.favBoost, 1, 50, DEFAULT_CONFIG.favBoost),
    bubbleSize: clampInt(c.bubbleSize, 40, 140, DEFAULT_CONFIG.bubbleSize),
  };
}

/** 读取 POST 请求体（测试里可以直接塞 req.body） */
async function readBody(req, limit = 64 * 1024) {
  if (req === null || typeof req !== "object") return {};
  if (typeof req[Symbol.asyncIterator] !== "function") {
    return req.body !== null && typeof req.body === "object" ? req.body : {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

/**
 * 读取菜品索引。优先用沙箱内的 fs 服务（和 dsh-whale-balance 一样的做法），
 * 服务不可用时退回 node:fs。
 */
async function loadDishes(ctx) {
  if (dishesCache !== null) return dishesCache;

  let text = null;
  const fs = typeof ctx.get === "function" ? ctx.get("fs") : undefined;
  if (fs !== undefined && typeof fs.resolve === "function") {
    try {
      const target = await fs.resolve(DATA_PATH);
      if (typeof fs.readText === "function") {
        text = await fs.readText(target);
      } else if (typeof fs.readBytes === "function") {
        const bytes = await fs.readBytes(target, undefined, MAX_DATA_BYTES);
        text = Buffer.from(bytes).toString("utf8");
      }
    } catch (e) {
      text = null; // 落到下面的 node:fs
    }
  }
  if (text === null) {
    text = readFileSync(DATA_PATH, "utf8");
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("dishes.json 不是数组");
  dishesCache = parsed;
  return parsed;
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** 从请求 URL 上取查询参数（只在白名单内的字段生效） */
function queryOptions(req, config) {
  let params;
  try {
    params = new URL(req.url, "http://localhost").searchParams;
  } catch (e) {
    params = new URLSearchParams();
  }
  const raw = { ...config };
  for (const key of ["scene", "foreign", "city", "cuisine", "method", "meal", "avoid",
                     "fav", "favOnly", "favBoost", "mainstreamCount"]) {
    const v = params.get(key);
    if (v !== null && v !== "") raw[key] = v;
  }
  // 客户端把自己的本地小时发过来，餐次跟着使用者的时间走
  const hh = params.get("hour");
  if (hh !== null && hh !== "") raw.hour = Number(hh);
  const mn = params.get("kcalMin");
  const mx = params.get("kcalMax");
  if (mn !== null && mn !== "") raw.kcalMin = Number(mn);
  if (mx !== null && mx !== "") raw.kcalMax = Number(mx);
  return raw;
}

// ---------------------------------------------------------------- AI 出做法 / 估热量
//
// 这是整个插件里唯一会花 token 的地方，其余全是本地计算。
// 走主机端的 llm 服务（与 DSH 自己写会话标题用的是同一个），
// 所以不需要经过输入框，结果直接回给面板显示。

const ASK_TIMEOUT_MS = 45000;

/** 两类问题的提示词。刻意限定输出格式与字数，控制 token 开销。 */
function askPrompt(kind, dish) {
  const who = "「" + dish.name + "」（" + dish.cuisine + "）";
  if (kind === "nutrition") {    return {
      system: "你是营养估算助手。只给数字和极简说明，不寒暄、不说教、不写免责声明。",
      user: who + "的热量是多少？请严格按下面的格式回答，不要有多余内容：\n"
        + "每 100 克约 XXX 千卡（范围 YYY–ZZZ）\n"
        + "蛋白质 X 克 / 脂肪 X 克 / 碳水 X 克\n"
        + "一句话说明主要热量来源。",
      maxTokens: 400,
    };
  }
  if (kind === "review") {
    // 「大肥鱼」：圆滚滚、贪吃又乖巧的鲸鱼小姑娘
    return {
      system: "你是「大肥鱼」，一只圆滚滚、超贪吃、又很乖巧的鲸鱼小姑娘。"
        + "说话可爱、口语化、第一人称，可以带一点颜文字或 emoji。"
        + "不寒暄、不说教、不写免责声明、不报营养数据。",
      user: "看到" + who + "，你想说什么？"
        + "用 1~2 句话说说想不想吃、闻着或吃着是什么感觉，就像个贪吃的小姑娘看到好吃的。"
        + "总字数控制在 60 字以内。",
      maxTokens: 260,
    };
  }
  return {
    system: "你是家常菜谱助手。回答简短直接，不寒暄、不写免责声明。",
    user: who + "怎么做？请严格按下面的格式回答：\n"
      + "主要食材：……\n步骤：1. …… 2. ……\n耗时：约 XX 分钟\n小提示：……\n"
      + "总字数控制在 260 字以内。即使这道菜不常见，也必须给出可操作的步骤，不要只列食材。",
    maxTokens: 900,
  };
}

/** 手工构造一条 user 消息。形状取自 dsh-llm 的 createUserMessage，免得依赖它在插件目录里可解析。 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "dsh-meal-picker" },
  };
}

/** 默认模型：读 DSH 设置里的 agent-default-model。 */
function defaultRoute(ctx) {
  const svc = typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : undefined;
  if (svc === undefined || svc === null || typeof svc.currentSelection !== "function") return null;
  try {
    const sel = svc.currentSelection();
    if (sel !== null && sel !== undefined
        && typeof sel.provider === "string" && typeof sel.model === "string"
        && sel.provider !== "" && sel.model !== "") {
      return { provider: sel.provider, model: sel.model };
    }
  } catch (e) {
    /* 读不到就走下面的报错 */
  }
  return null;
}

/** 把结束原因写成能读的一行。适配器给的是对象，直接 String() 只会得到 [object Object]。 */
function describeReason(reason) {
  if (reason === null || reason === undefined) return "未提供";
  if (typeof reason === "string") return reason;
  if (typeof reason === "object") {
    const t = reason.type !== undefined ? reason.type
      : (reason.reason !== undefined ? reason.reason : reason.kind);
    if (typeof t === "string") return t;
    try {
      return JSON.stringify(reason);
    } catch (e) {
      return "无法描述";
    }
  }
  return String(reason);
}

/**
 * 跑一次流式调用并取出正文。
 *
 * 正文可能走两条路：过程中增量给（text-delta），或结束时整块给（block-end）。
 * 只认前者，在部分适配器上会一个字都拿不到，所以增量流为空时回退到整块文本。
 */
async function streamOnce(llm, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let streamed = "";
  const finalized = [];
  const kinds = [];
  let reasoningChars = 0;
  let finish = null;
  try {
    for await (const chunk of llm.stream({ ...options, signal: controller.signal })) {
      if (chunk === null || chunk === undefined || typeof chunk !== "object") continue;
      if (typeof chunk.type === "string" && kinds.indexOf(chunk.type) < 0) kinds.push(chunk.type);
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        streamed += chunk.text;
      } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
        reasoningChars += chunk.text.length;
      } else if (chunk.type === "block-end"
          && chunk.block !== null && chunk.block !== undefined
          && chunk.block.type === "text" && typeof chunk.block.text === "string") {
        finalized.push(chunk.block.text);
      } else if (chunk.type === "finish") {
        finish = chunk.reason;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const text = streamed.trim() !== "" ? streamed : finalized.join("");
  return { text: text.trim(), reasoningChars, finish, kinds };
}

async function askModel(ctx, kind, dish) {
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
  if (llm === undefined || llm === null || typeof llm.stream !== "function") {
    throw new Error("这个 DSH 版本没有提供 llm 服务");
  }
  const route = defaultRoute(ctx);
  if (route === null) throw new Error("读不到默认模型，请先在 DSH 设置里选一个模型");

  const resolved = typeof llm.resolveCallConfig === "function"
    ? await llm.resolveCallConfig({ provider: route.provider, model: route.model })
    : route;

  const p = askPrompt(kind, dish);
  const base = {
    provider: resolved.provider,
    model: resolved.model,
    messages: [userMessage(p.user)],
    system: p.system,
    maxTokens: p.maxTokens,
  };

  // 关掉「思考」：这套调用只要能直接排版出来的短文本，思考既费钱又会把输出预算吃光
  // （开着 thinking 时正文会被截断，甚至一个字正文都不剩）。各家支持的档位不同，
  // 被拒就退回不指定，交给服务端默认值。
  let r;
  try {
    r = await streamOnce(llm, { ...base, reasoningEffort: "off" }, ASK_TIMEOUT_MS);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (!/reasoning/i.test(msg)) throw e;
    r = await streamOnce(llm, base, ASK_TIMEOUT_MS);
  }

  if (r.text !== "") return r.text;

  // 失败时把「到底收到了什么」一并说清楚，省得再来回猜
  const detail = "收到分片：" + (r.kinds.length === 0 ? "无" : r.kinds.join("/"))
    + (r.reasoningChars > 0 ? "（其中思考内容 " + r.reasoningChars + " 字，没有正文）" : "")
    + "；结束原因：" + describeReason(r.finish);
  throw new Error("模型没有返回正文（" + detail + "）");
}

export function apply(ctx, config) {
  const cfg = sanitizeConfig(config);
  // 「最近推过」的内存记录：只在本进程内有效，重启即清空（不写磁盘，避免碰沙箱）
  const recent = [];
  // 收藏：从磁盘读一次，之后原地改并回写
  const favLoaded = loadFavorites();
  const favorites = favLoaded.list.slice();
  let favPersisted = favLoaded.persisted;

  // 长期偏好（忌口）：面板里设过就以它为准，否则用插件配置里的
  const prefsLoaded = loadPrefs();
  let prefs = prefsLoaded.prefs === null ? { avoid: splitAvoid(cfg.avoid) } : prefsLoaded.prefs;
  let prefsPersisted = prefsLoaded.persisted;
  let avoidSaved = prefsLoaded.prefs !== null;   // 使用者是否在面板里设过

  const rememberPrefs = (nextAvoid) => {
    const list = splitAvoid(nextAvoid);
    prefs = { avoid: list };
    prefsPersisted = savePrefs(prefs);
    avoidSaved = true;
    return list;
  };

  const rememberFav = (mutate) => {
    mutate(favorites);
    while (favorites.length > 500) favorites.shift();
    favPersisted = saveFavorites(favorites);
  };

  const remember = (names) => {
    if (cfg.recentLimit <= 0) return;
    for (const n of names) {
      const i = recent.indexOf(n);
      if (i >= 0) recent.splice(i, 1);
      recent.push(n);
    }
    while (recent.length > cfg.recentLimit) recent.shift();
  };

  // ---- 元信息：默认配置、菜系列表、统计 ----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/meta",
    handler: async (req, res) => {
      try {
        const dishes = await loadDishes(ctx);
        const cuisines = {};
        const methods = {};
        const meals = {};
        for (const d of dishes) {
          cuisines[d.cuisine] = (cuisines[d.cuisine] || 0) + 1;
          if (Array.isArray(d.methods)) {
            for (const m of d.methods) methods[m] = (methods[m] || 0) + 1;
          }
          if (Array.isArray(d.meals)) {
            for (const m of d.meals) meals[m] = (meals[m] || 0) + 1;
          }
        }
        const hour = new Date().getHours();
        sendJson(res, {
          ok: true,
          config: cfg,
          total: dishes.length,
          fiveStar: dishes.filter((d) => d.star === 5).length,
          foreign: dishes.filter((d) => d.foreign === true).length,
          cuisines: Object.entries(cuisines)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => ({ cuisine: k, count: v })),
          // 餐次：宿主自己的钟点，客户端每次请求还会带上自己的小时
          hour,
          mealNow: cfg.meal === "auto" ? mealOfHour(hour) : cfg.meal,
          mealLabel: MEAL_LABEL,
          meals: Object.entries(meals)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => ({ meal: k, label: MEAL_LABEL[k] || k, count: v })),
          mealsTagged: dishes.filter((d) => Array.isArray(d.meals) && d.meals.length > 0).length,
          // 做法按命中数降序；没打上标签的菜不计入任何做法
          methods: Object.entries(methods)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => ({ method: k, count: v })),
          methodsTagged: dishes.filter((d) => Array.isArray(d.methods) && d.methods.length > 0).length,
          recent,
          favorites,
          // 忌口：面板里设过就是持久化那份（avoidSaved=true），否则是配置里的
          avoid: prefs.avoid,
          avoidSaved,
          prefsPersisted,
          prefsFile: PREFS_FILE,
          favoritesPersisted: favPersisted,
          favoritesFile: FAV_FILE,
        });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
      }
    },
  }), "meal-picker: meta route");

  // ---- 气泡图标：随包自带的 PNG，客户端拿它当气泡上的图 ----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/icon.png",
    handler: async (req, res) => {
      try {
        const png = readFileSync(ICON_PATH);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Cache-Control": "no-cache",
        });
        res.end(png);
      } catch (e) {
        // 图标读不到不该让气泡出事，客户端会退回 🍚
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 404);
      }
    },
  }), "meal-picker: icon route");

  // ---- AI 出做法 / 估热量：唯一会花 token 的端点 ----
  // 只允许问菜库里已有的菜，避免这个接口被当成任意提示词的转发口。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/ask",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, { ok: false, error: "只支持 POST" }, 405);
        return;
      }
      try {
        // readBody 已经解析成对象了（读不动时给 {}），不要再 JSON.parse 一次
        const raw = await readBody(req);
        const body = raw !== null && typeof raw === "object" ? raw : {};
        const kind = body.kind === "nutrition" ? "nutrition"
          : (body.kind === "review" ? "review" : "recipe");
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (name === "") {
          sendJson(res, { ok: false, error: "缺少菜名" }, 400);
          return;
        }
        const dishes = await loadDishes(ctx);
        const dish = dishes.find((d) => d.name === name);
        if (dish === undefined) {
          sendJson(res, { ok: false, error: "菜库里没有这道菜：" + name }, 400);
          return;
        }
        const text = await askModel(ctx, kind, dish);
        sendJson(res, { ok: true, kind, name, text });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
      }
    },
  }), "meal-picker: ask route");

  // ---- 抽菜：核心端点，全程本地计算，0 token ----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/recommend",
    handler: async (req, res) => {
      try {
        const dishes = await loadDishes(ctx);
        // 忌口默认用持久化那份（面板里设过就以面板为准），客户端传了就以客户端为准
        const raw = queryOptions(req, { ...cfg, avoid: prefs.avoid.join(",") });
        const count = clampInt(
          new URL(req.url, "http://localhost").searchParams.get("count"),
          1, 12, cfg.count);
        const opt = normalizeOptions({ ...raw, recent });
        // 收藏列表：客户端传了就用它（刚点的心形立刻生效），否则用宿主持久化那份
        if (raw.fav === undefined || raw.fav === "") opt.favorites = favorites.slice();
        opt.favoriteSet = new Set(opt.favorites);

        const result = pickMany(dishes, opt, count);
        const picks = result.items;
        if (picks.length === 0) {
          sendJson(res, {
            ok: true,
            empty: true,
            region: opt.region,
            candidates: 0,
            hint: "当前条件下没有候选菜品，放宽一下筛选试试（比如关掉「只要外国菜」、清空菜系）。",
          });
          return;
        }
        remember(picks.map((d) => d.name));

        sendJson(res, {
          ok: true,
          empty: false,
          region: opt.region,
          scene: opt.scene,
          foreign: opt.foreign,
          meal: opt.meal,
          mealNow: opt.mealNow,
          mealLabel: MEAL_LABEL[opt.mealNow] || opt.mealNow,
          hour: opt.hour,
          pool: result.poolSize,
          relaxed: result.relaxed,
          relaxReason: result.reason,
          groups: result.groups,
          mainstreamCount: opt.mainstreamCount,
          favOnly: opt.favOnly,
          favBoost: opt.favBoost,
          favorites,
          // 刻意不返回热量与营养素：插件不存这些数据，需要时由 AI 现算
          items: picks.map((d) => ({
            name: d.name,
            cuisine: d.cuisine,
            methods: Array.isArray(d.methods) ? d.methods : [],
            meals: Array.isArray(d.meals) ? d.meals : [],
            star: d.star,
            scene: d.scene,
            foreign: d.foreign,
            favorite: opt.favoriteSet.has(d.name),
            recipeUrl: recipeSearchUrl(d.name),
            recipePrompt: buildRecipePrompt(d.name, opt.scene),
            nutritionPrompt: buildNutritionPrompt(d.name),
          })),
        });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
      }
    },
  }), "meal-picker: recommend route");

  // ---- 收藏：GET 读，POST 改（toggle / add / remove / set / clear）----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/favorites",
    handler: async (req, res) => {
      try {
        const method = String(req.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const body = await readBody(req);
          const action = typeof body.action === "string" ? body.action : "toggle";
          if (action === "clear") {
            rememberFav((list) => { list.length = 0; });
          } else if (action === "set") {
            const src = Array.isArray(body.list) ? body.list : [];
            rememberFav((list) => {
              list.length = 0;
              for (const n of src) {
                if (typeof n === "string" && n.length > 0 && !list.includes(n)) list.push(n);
              }
            });
          } else {
            const name = typeof body.name === "string" ? body.name.trim() : "";
            if (name === "") {
              sendJson(res, { ok: false, error: "缺少 name" }, 400);
              return;
            }
            rememberFav((list) => {
              const i = list.indexOf(name);
              if (action === "add") {
                if (i < 0) list.push(name);
              } else if (action === "remove") {
                if (i >= 0) list.splice(i, 1);
              } else if (i >= 0) {
                list.splice(i, 1);          // toggle：有就删
              } else {
                list.push(name);            // toggle：没有就加
              }
            });
          }
        }
        // 顺手带上每道收藏菜的信息，供「收藏列表」直接展示；
        // 菜库里已经没有的收藏（改过数据）用 inLibrary:false 标出来
        const dishes = await loadDishes(ctx);
        const byName = new Map(dishes.map((d) => [d.name, d]));
        const items = favorites.map((n) => {
          const d = byName.get(n);
          if (d === undefined) return { name: n, inLibrary: false };
          return {
            name: d.name,
            inLibrary: true,
            cuisine: d.cuisine,
            methods: Array.isArray(d.methods) ? d.methods : [],
            meals: Array.isArray(d.meals) ? d.meals : [],
            star: d.star,
            scene: d.scene,
            foreign: d.foreign,
          };
        });
        sendJson(res, {
          ok: true,
          favorites,
          items,
          persisted: favPersisted,
          file: FAV_FILE,
        });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
      }
    },
  }), "meal-picker: favorites route");

  // ---- 长期偏好（忌口）：GET 读，POST 写。写了就落盘，重启不丢 ----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/prefs",
    handler: async (req, res) => {
      try {
        const method = String(req.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const body = await readBody(req);
          if (body !== null && typeof body === "object" && body.avoid !== undefined) {
            rememberPrefs(body.avoid);
          }
        }
        sendJson(res, {
          ok: true,
          avoid: prefs.avoid,
          avoidSaved,
          persisted: prefsPersisted,
          file: PREFS_FILE,
        });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
      }
    },
  }), "meal-picker: prefs route");

  // ---- 清空最近记录（想重新推同一批菜时用）----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-meal/recent",
    handler: async (req, res) => {
      try {
        if (req.method === "POST" || req.method === "DELETE") {
          recent.length = 0;
        }
        sendJson(res, { ok: true, recent });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
      }
    },
  }), "meal-picker: recent route");
}

/**
 * 宿主侧集成测试：用假的 cordis ctx 与 req/res 跑通四条路由，
 * 不需要启动 DSH。收藏会写到临时 DSH_HOME，绝不碰你真实的配置。
 * 运行：node --test test/host.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 插件之前设好：收藏文件路径是模块加载时算出来的
const TMP_HOME = mkdtempSync(join(tmpdir(), "dsh-meal-picker-test-"));
process.env.DSH_HOME = TMP_HOME;
const FAV_FILE = join(TMP_HOME, "dsh-meal-picker", "favorites.json");

const { apply, inject, name } = await import("../lib/index.js");

process.on("exit", () => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch (e) { /* 清理失败无所谓 */ }
});

/** 造一个假的 cordis ctx：捕获 webServer.register 注册的路由 */
function fakeCtx(services = {}) {
  const routes = new Map();
  const effects = [];
  return {
    routes,
    effects,
    ctx: {
      effect(fn, label) {
        effects.push(label);
        const dispose = fn();
        return typeof dispose === "function" ? dispose : () => {};
      },
      get(name) {
        // 默认什么都没有：让插件退回 node:fs 读数据，并暴露「没有 llm 服务」的路径
        return services[name];
      },
      webServer: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
}

/** 造一个假的 req/res，返回 { status, json } */
function call(routes, path, { method = "GET", query = {}, body } = {}) {
  const route = routes.get(path.split("?")[0]);
  if (route === undefined) throw new Error("没有注册路由 " + path);
  const qs = new URLSearchParams(query).toString();
  const req = {
    url: path + (qs === "" ? "" : "?" + qs),
    method,
    body: body === undefined ? {} : body,
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: null,
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(payload) {
        try {
          resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(payload) });
        } catch (e) {
          reject(e);
        }
      },
    };
    route.handler(req, res).catch(reject);
  });
}

function fresh(services) {
  const { ctx, routes, effects } = fakeCtx(services);
  apply(ctx, {});
  return { routes, effects };
}

test("插件导出符合 DSH 约定（name / inject / apply）", () => {
  assert.equal(name, "dsh-meal-picker");
  assert.deepEqual(inject, ["webServer"]);
  assert.equal(typeof apply, "function");
});

test("apply 注册七条路由，且都包在 ctx.effect 里", async () => {
  const { routes, effects } = fresh();
  assert.deepEqual([...routes.keys()].sort(),
    ["/dsh-meal/ask", "/dsh-meal/favorites", "/dsh-meal/icon.png",
     "/dsh-meal/meta", "/dsh-meal/prefs", "/dsh-meal/recent", "/dsh-meal/recommend"]);
  assert.equal(effects.length, 7);

  const meta = await call(routes, "/dsh-meal/meta");
  assert.equal(meta.status, 200);
  assert.equal(meta.json.ok, true);
  assert.ok(meta.json.total > 4000, `菜品总数 ${meta.json.total} 偏少`);
  assert.ok(meta.json.fiveStar >= 100, `主流菜 ${meta.json.fiveStar} 偏少`);
  assert.ok(meta.json.cuisines.length > 20, "菜系列表太短");
  assert.equal(meta.json.config.scene, "cook");
  assert.equal(meta.json.config.mainstreamCount, 2, "默认保底两道主流");
  assert.equal(meta.json.config.favBoost, 5);
  assert.deepEqual(meta.json.favorites, [], "一开始没有收藏");
  assert.match(meta.headers["Content-Type"], /application\/json/);
});

test("recommend 返回结构化候选，且字段齐全", async () => {
  const { routes } = fresh();
  const r = await call(routes, "/dsh-meal/recommend", { query: { count: "5" } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.empty, false);
  assert.equal(r.json.items.length, 5);
  assert.equal(new Set(r.json.items.map((i) => i.name)).size, 5, "5 道不应重复");
  assert.ok(r.json.pool > 0);
  assert.equal(r.json.mainstreamCount, 2);
  assert.equal(typeof r.json.groups.mainstream, "number");
  for (const it of r.json.items) {
    assert.ok(typeof it.name === "string" && it.name.length > 0);
    assert.ok(it.recipeUrl.startsWith("https://www.xiachufang.com/"));
    assert.ok(it.recipePrompt.length > 10 && it.recipePrompt.length < 120);
    assert.ok(it.nutritionPrompt.includes(it.name), "应带上估热量的提示词");
    assert.ok(it.nutritionPrompt.length < 120, "提示词要短，省 token");
    assert.ok(["home", "takeout", "both"].includes(it.scene));
    assert.equal(typeof it.favorite, "boolean");
    // 插件不存营养数据
    for (const k of ["kcal", "p", "f", "c", "protein", "fat", "cho"]) {
      assert.equal(it[k], undefined, `响应里不该有营养字段 ${k}`);
    }
  }
});

// 选菜规则：前 mainstreamCount 道必定五星主流，其余按原本权重随机
test("默认给三道：前两道必定主流，第三道不保底", async () => {
  const { routes } = fresh();
  const r = await call(routes, "/dsh-meal/recommend", { query: { count: "3" } });
  assert.equal(r.json.items.length, 3, "默认应给三道");
  assert.equal(r.json.items[0].star, 5, "第 1 道必定主流");
  assert.equal(r.json.items[1].star, 5, "第 2 道必定主流");
  assert.notEqual(r.json.items[0].name, r.json.items[1].name);

  // 跨多批看第三道：多数是主流菜（主流权重高），但不该像前两道那样 100%。
  // 期望值约 58%；样本量取够、下限留足余量，避免随机翻车。
  let thirdStar = 0;
  let thirdTotal = 0;
  for (let i = 0; i < 40; i += 1) {
    const batch = await call(routes, "/dsh-meal/recommend", { query: { count: "3" } });
    assert.equal(batch.json.items[0].star, 5);
    assert.equal(batch.json.items[1].star, 5);
    thirdTotal += 1;
    if (batch.json.items[2].star === 5) thirdStar += 1;
  }
  const share = thirdStar / thirdTotal;
  assert.ok(share < 1, `第三道 ${(share * 100).toFixed(0)}% 是主流菜，说明还在保底`);
  assert.ok(share > 0.2, `第三道只有 ${(share * 100).toFixed(0)}% 是主流菜，主流权重没起作用`);
});

test("mainstreamCount 可以用查询参数调（含 0 = 不保底）", async () => {
  const { routes } = fresh();

  const none = await call(routes, "/dsh-meal/recommend",
    { query: { mainstreamCount: "0", count: "3", meal: "any" } });
  assert.equal(none.json.mainstreamCount, 0);

  const all = await call(routes, "/dsh-meal/recommend",
    { query: { mainstreamCount: "3", count: "3", meal: "any" } });
  assert.ok(all.json.items.every((i) => i.star === 5), "保底 3 道时应全是主流菜");
});

test("餐次会把「当餐菜」并进优先组：早餐时段能抽到早餐菜", async () => {
  const { routes } = fresh();
  let breakfastHits = 0;
  let total = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = await call(routes, "/dsh-meal/recommend",
      { query: { count: "12", hour: "7" } });
    assert.equal(r.json.mealNow, "breakfast");
    for (const it of r.json.items) {
      total += 1;
      if (Array.isArray(it.meals) && it.meals.indexOf("breakfast") >= 0) breakfastHits += 1;
    }
  }
  const share = breakfastHits / total;
  assert.ok(share > 0.2,
    `早餐时段只有 ${(share * 100).toFixed(1)}% 是早餐菜，餐次加权没起作用`);

  // 不限餐次时，早餐菜不该被特意抬高
  const anyMeal = await call(routes, "/dsh-meal/recommend",
    { query: { count: "5", meal: "any", hour: "7" } });
  assert.equal(anyMeal.json.mealNow, "", "any 表示不限餐次");
  assert.equal(anyMeal.json.mealLabel, "");
});

// ---------------------------------------------------------------- 收藏

test("收藏：toggle 写入磁盘，GET 读回，重启后仍在", async () => {
  const { routes } = fresh();
  const added = await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "toggle", name: "红烧肉" } });
  assert.equal(added.json.ok, true);
  assert.deepEqual(added.json.favorites, ["红烧肉"]);
  assert.equal(added.json.persisted, true, "应该写盘成功");
  assert.ok(existsSync(FAV_FILE), "收藏文件应存在");

  const onDisk = JSON.parse(readFileSync(FAV_FILE, "utf8"));
  assert.deepEqual(onDisk.favorites, ["红烧肉"]);

  // 再 toggle 一次应移除
  const removed = await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "toggle", name: "红烧肉" } });
  assert.deepEqual(removed.json.favorites, []);

  // 重新 apply（模拟重启 DSH）后仍能读回
  await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "add", name: "宫保鸡丁" } });
  const restarted = fresh();
  const meta = await call(restarted.routes, "/dsh-meal/meta");
  assert.deepEqual(meta.json.favorites, ["宫保鸡丁"], "重启后收藏应保留");
});

test("收藏：add / remove / set / clear 四种操作都正常", async () => {
  const { routes } = fresh();
  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "clear" } });

  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "add", name: "红烧肉" } });
  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "add", name: "红烧肉" } });
  let r = await call(routes, "/dsh-meal/favorites");
  assert.deepEqual(r.json.favorites, ["红烧肉"], "重复 add 不该产生重复项");

  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "add", name: "宫保鸡丁" } });
  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "remove", name: "红烧肉" } });
  r = await call(routes, "/dsh-meal/favorites");
  assert.deepEqual(r.json.favorites, ["宫保鸡丁"]);

  await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "set", list: ["清蒸鱼", "麻辣烫", "清蒸鱼"] } });
  r = await call(routes, "/dsh-meal/favorites");
  assert.deepEqual(r.json.favorites, ["清蒸鱼", "麻辣烫"], "set 应去重");

  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "clear" } });
  r = await call(routes, "/dsh-meal/favorites");
  assert.deepEqual(r.json.favorites, []);
});

test("收藏：缺 name 时返回 400", async () => {
  const { routes } = fresh();
  const r = await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "add" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("收藏：favOnly 只出收藏，收藏为空时自动放宽并说明", async () => {
  const { routes } = fresh();
  await call(routes, "/dsh-meal/favorites", { method: "POST", body: { action: "clear" } });

  // 收藏为空 + favOnly -> 放宽
  const relaxed = await call(routes, "/dsh-meal/recommend",
    { query: { favOnly: "1", count: "5" } });
  assert.equal(relaxed.json.empty, false, "不该返回空");
  assert.equal(relaxed.json.relaxed, true);
  assert.match(relaxed.json.relaxReason, /还没有收藏/);

  // 收藏两道 -> 只出这两道
  await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "set", list: ["红烧肉", "宫保鸡丁"] } });
  const only = await call(routes, "/dsh-meal/recommend",
    { query: { favOnly: "1", count: "5" } });
  assert.equal(only.json.empty, false);
  assert.equal(only.json.items.length, 2, "只收藏了两道，最多给两道");
  assert.ok(only.json.items.every((i) => ["红烧肉", "宫保鸡丁"].includes(i.name)));
  assert.ok(only.json.items.every((i) => i.favorite === true));
});

test("收藏：favBoost 越大，收藏菜出现得越多", async () => {
  const { routes } = fresh();
  // 用数据里真实存在的一道冷门菜（编造的名字永远抽不到，测不出来）
  const FAV = "凤尾菇扒蛋";
  const exists = await call(routes, "/dsh-meal/recommend",
    { query: { cuisine: "家常菜", count: "1" } });
  assert.equal(exists.json.ok, true);

  const countFav = async (boost) => {
    let hit = 0;
    let total = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = await call(routes, "/dsh-meal/recommend",
        { query: { count: "10", favBoost: String(boost), fav: FAV } });
      for (const it of r.json.items) {
        total += 1;
        if (it.name === FAV) hit += 1;
      }
    }
    return { rate: hit / total, hit };
  };
  const low = await countFav(1);
  const high = await countFav(20);
  assert.ok(high.hit > 0, `favBoost=20 时至少该抽到几次（实测 ${high.hit} 次）`);
  assert.ok(high.rate > low.rate,
    `favBoost=20 (${high.rate.toFixed(4)}) 应高于 =1 (${low.rate.toFixed(4)})`);
});

test("收藏：客户端传的 fav 优先于磁盘上的那份", async () => {
  const { routes } = fresh();
  await call(routes, "/dsh-meal/favorites",
    { method: "POST", body: { action: "set", list: ["红烧肉"] } });
  // 查询里带别的收藏，应该以查询里的为准（刚点的星立刻生效）
  const r = await call(routes, "/dsh-meal/recommend",
    { query: { favOnly: "1", count: "3", fav: "宫保鸡丁" } });
  assert.equal(r.json.relaxed, false);
  assert.deepEqual(r.json.items.map((i) => i.name), ["宫保鸡丁"]);
});

// ---------------------------------------------------------------- 其它筛选

test("recommend 接受查询参数覆盖配置", async () => {
  const { routes } = fresh();
  const only = await call(routes, "/dsh-meal/recommend",
    { query: { foreign: "only", count: "3" } });
  assert.equal(only.json.empty, false, "只有外国菜时不该返回空");
  assert.ok(only.json.items.every((i) => i.foreign === true));

  const sichuan = await call(routes, "/dsh-meal/recommend",
    { query: { cuisine: "四川菜", count: "3" } });
  assert.ok(sichuan.json.items.every((i) => i.cuisine === "四川菜"));

  const city = await call(routes, "/dsh-meal/recommend",
    { query: { city: "成都", count: "2" } });
  assert.equal(city.json.region, "四川菜");
});

test("自己做模式不会推出只能点到的菜", async () => {
  const { routes } = fresh();
  const r = await call(routes, "/dsh-meal/recommend",
    { query: { scene: "cook", count: "12" } });
  assert.ok(r.json.items.every((i) => i.scene !== "takeout"),
    "自己做模式下不该出现偏外卖的菜");
});

test("忌口过滤生效", async () => {
  const { routes } = fresh();
  const r = await call(routes, "/dsh-meal/recommend",
    { query: { avoid: "鸡,鱼,肉,虾,蛋", count: "10" } });
  assert.ok(r.json.items.every((i) => !/[鸡鱼肉虾蛋]/.test(i.name)),
    "忌口词不该出现在菜名里");
});

test("候选为空时给出提示而不是报错", async () => {
  const { routes } = fresh();
  const r = await call(routes, "/dsh-meal/recommend",
    { query: { foreign: "only", cuisine: "甘肃菜" } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.empty, true);
  assert.ok(r.json.hint.length > 0);
});

test("最近推过的会被记住，因此「换一批」能换出别的菜", async () => {
  const { routes } = fresh();
  const first = await call(routes, "/dsh-meal/recommend",
    { query: { cuisine: "家常菜", count: "5" } });
  const second = await call(routes, "/dsh-meal/recommend",
    { query: { cuisine: "家常菜", count: "5" } });
  const a = new Set(first.json.items.map((i) => i.name));
  const overlap = second.json.items.filter((i) => a.has(i.name)).length;
  assert.ok(overlap <= 1, `两批重复 ${overlap} 道，去重没生效`);

  const cleared = await call(routes, "/dsh-meal/recent", { method: "POST" });
  assert.deepEqual(cleared.json.recent, []);
});

test("配置里的非法值被夹到安全范围", async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, { count: 999, recentLimit: -5, scene: "乱填", foreign: "乱填",
               mainstreamCount: 999, favBoost: 999, bubbleSize: 9999 });
  const meta = await call(routes, "/dsh-meal/meta");
  assert.ok(meta.json.config.count <= 12);
  assert.ok(meta.json.config.recentLimit >= 0);
  assert.equal(meta.json.config.scene, "cook");
  assert.equal(meta.json.config.foreign, "any");
  assert.equal(meta.json.config.mainstreamCount, 20);
  assert.equal(meta.json.config.favBoost, 50);
  assert.equal(meta.json.config.bubbleSize, 140, "气泡尺寸上限 140");
});

test("气泡尺寸：默认 72，太小也夹到 40", async () => {
  const dflt = await call(fresh().routes, "/dsh-meal/meta");
  assert.equal(dflt.json.config.bubbleSize, 72, "默认应为 72");

  const { ctx, routes } = fakeCtx();
  apply(ctx, { bubbleSize: 10 });
  const small = await call(routes, "/dsh-meal/meta");
  assert.equal(small.json.config.bubbleSize, 40, "下限 40");
});

test("数据规模合理：主流菜占比小但权重高，外国菜不占多数", async () => {
  const { routes } = fresh();
  const meta = await call(routes, "/dsh-meal/meta");
  const share = meta.json.fiveStar / meta.json.total;
  assert.ok(share < 0.1, `主流菜条目只占 ${(share * 100).toFixed(1)}%，靠权重撑起 80% 输出`);
  assert.ok(meta.json.foreign < meta.json.total / 2, "外国菜不该占多数");
});

// 菜系列表直接长成面板上的下拉框，混进「做法」当菜系会让人看不懂，
// 所以这里守住：cuisine 只能是菜系，不能是烹饪方式。
test("cuisine 字段里不该混进做法/品类，外来菜系要与 foreign 标记一致", () => {
  const raw = JSON.parse(readFileSync(new URL("../data/dishes.json", import.meta.url), "utf8"));
  const dishes = Array.isArray(raw) ? raw : raw.dishes;

  const JUNK = ["凉拌", "煎", "清蒸", "炒", "锅塌", "炖", "炸", "干煸", "烤",
    "砂锅、煮", "小吃类", "快餐食品类"];
  const bad = dishes.filter((d) => JUNK.indexOf(d.cuisine) >= 0).map((d) => `${d.name}@${d.cuisine}`);
  assert.deepEqual(bad, [], "这些是做法不是菜系，应归入真实菜系：" + bad.join("、"));

  // 两道原本被错标成做法的外来菜：菜系改对了，foreign 也必须跟着改，
  // 否则「只要中餐」会把石锅拌饭和法棍当成中餐推出来
  for (const name of ["石锅拌饭", "法棍"]) {
    const d = dishes.find((x) => x.name === name);
    assert.ok(d !== undefined, `数据里应有 ${name}`);
    assert.equal(d.foreign, true, `${name} 是外来菜，foreign 应为 true`);
  }

  // 只有 1-2 道菜的菜系必须是真的地名菜系，不能再出现做法桶
  const counts = {};
  for (const d of dishes) counts[d.cuisine] = (counts[d.cuisine] || 0) + 1;
  const tiny = Object.keys(counts).filter((c) => counts[c] <= 2);
  for (const c of tiny) {
    assert.ok(/菜$|料理$|风味$|西餐$|斋菜$/.test(c),
      `只有 ${counts[c]} 道菜的菜系「${c}」看起来不像地名菜系`);
  }

  assert.ok(Object.keys(counts).length <= 45,
    `菜系取值 ${Object.keys(counts).length} 个偏多，检查是不是又混进了新桶`);
});

// ---------------------------------------------------------------- /ask（唯一花 token 的端点）

/** 假的 llm + agentDefaultModel 服务，记录传进去的调用参数 */
function fakeLlm(chunks, sel) {
  const calls = [];
  return {
    calls,
    services: {
      agentDefaultModel: {
        currentSelection: () => sel ?? { provider: "deepseek-official", model: "deepseek-v4-flash" },
      },
      llm: {
        async resolveCallConfig(cfg) { return cfg; },
        stream(options) {
          calls.push(options);
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
}

test("/ask：把模型的 text-delta 拼起来返回，并按格式要求构造请求", async () => {
  const { calls, services } = fakeLlm([
    { type: "text-delta", index: 0, text: "主要食材：" },
    { type: "text-delta", index: 0, text: "五花肉 500 克" },
    { type: "finish", reason: "stop" },
  ]);
  const { routes } = fresh(services);

  const r = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.text, "主要食材：五花肉 500 克", "应拼接全部 text-delta");
  assert.equal(r.json.kind, "recipe");

  const opt = calls[0];
  assert.equal(opt.provider, "deepseek-official");
  assert.equal(opt.model, "deepseek-v4-flash");
  assert.equal(opt.messages.length, 1);
  assert.equal(opt.messages[0].role, "user");
  assert.equal(opt.messages[0].content[0].type, "text");
  assert.match(opt.messages[0].content[0].text, /红烧肉/, "提示词里应带菜名");
  assert.ok(typeof opt.messages[0].id === "string" && opt.messages[0].id.length > 0, "消息需要 id");
  assert.equal(opt.messages[0].source.kind, "plugin");
  assert.equal(opt.messages[0].source.plugin, "dsh-meal-picker");
  assert.match(opt.system, /菜谱/, "做法请求应带 system 提示");
  assert.ok(opt.maxTokens > 0 && opt.maxTokens <= 1000, "maxTokens 应受限");
  assert.ok(opt.signal !== undefined, "应带超时用的 signal");
});

test("/ask：估热量走另一套提示词，且不给 sessionId", async () => {
  const { calls, services } = fakeLlm([{ type: "text-delta", index: 0, text: "约 470 千卡" }]);
  const { routes } = fresh(services);

  const r = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "nutrition", name: "红烧肉" },
  });
  assert.equal(r.json.kind, "nutrition");
  assert.match(calls[0].system, /营养/);
  assert.match(calls[0].messages[0].content[0].text, /热量/);
  assert.equal(calls[0].sessionId, undefined, "不该假装属于某个会话");
  assert.equal(calls[0].purpose, undefined);
});

test("/ask：参数与菜品校验都返回可读错误，不会去调模型", async () => {
  const { calls, services } = fakeLlm([]);
  const { routes } = fresh(services);

  assert.equal((await call(routes, "/dsh-meal/ask", { method: "GET" })).status, 405);

  const noName = await call(routes, "/dsh-meal/ask", { method: "POST", body: { kind: "recipe" } });
  assert.equal(noName.status, 400);
  assert.match(noName.json.error, /菜名/);

  const unknown = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "这道菜肯定不存在xyz" },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /菜库里没有/);

  assert.equal(calls.length, 0, "校验失败时不该调用模型");
});

test("/ask：没有 llm 服务 / 模型没吐字 都给出可读错误", async () => {
  // 默认假 ctx 里 get() 一律返回 undefined
  const bare = fresh();
  const noLlm = await call(bare.routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(noLlm.status, 500);
  assert.match(noLlm.json.error, /llm 服务/);

  const empty = fakeLlm([{ type: "finish", reason: { type: "stop" } }]);
  const withEmpty = fresh(empty.services);
  const r = await call(withEmpty.routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /没有返回正文/);
  assert.match(r.json.error, /收到分片：finish/, "应报告实际收到的分片类型");
  assert.match(r.json.error, /结束原因：stop/, "结束原因是对象时也要读成人话");
  assert.ok(!r.json.error.includes("[object Object]"), "不能出现 [object Object]");
});

test("/ask：只有思考没有正文时，错误里点明思考被花掉了", async () => {
  const { services } = fakeLlm([
    { type: "reasoning-delta", index: 0, text: "让我想想这道菜……" },
    { type: "finish", reason: { type: "length" } },
  ]);
  const { routes } = fresh(services);
  const r = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /思考内容 9 字/);
  assert.match(r.json.error, /结束原因：length/);
});

test("/ask：适配器只在 block-end 给正文时也能取到", async () => {
  const { services } = fakeLlm([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "主要食材：五花肉\n步骤：1. 切块" } },
    { type: "finish", reason: { type: "stop" } },
  ]);
  const { routes } = fresh(services);
  const r = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(r.status, 200);
  assert.match(r.json.text, /步骤：1/);
});

test("/ask：默认关掉思考以省 token；服务端不认这个档位时自动退回", async () => {
  const { calls, services } = fakeLlm([{ type: "text-delta", index: 0, text: "好了" }]);
  const { routes } = fresh(services);
  await call(routes, "/dsh-meal/ask", { method: "POST", body: { kind: "recipe", name: "红烧肉" } });
  assert.equal(calls[0].reasoningEffort, "off", "应默认请求关掉思考");

  // 换一个会拒绝 reasoningEffort 的服务：必须重试一次且最终成功
  let attempts = 0;
  const picky = {
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    llm: {
      async resolveCallConfig(cfg) { return cfg; },
      stream(options) {
        attempts += 1;
        if (options.reasoningEffort !== undefined) {
          throw new Error('Picky does not support reasoning effort "off"');
        }
        return (async function* () {
          yield { type: "text-delta", index: 0, text: "退回成功" };
        })();
      },
    },
  };
  const r2 = await call(fresh(picky).routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(attempts, 2, "应重试一次");
  assert.equal(r2.status, 200);
  assert.equal(r2.json.text, "退回成功");
});

test("/ask：读不到默认模型时明确报错，而不是瞎猜一个", async () => {
  const { services } = fakeLlm([{ type: "text-delta", index: 0, text: "x" }]);
  services.agentDefaultModel = { currentSelection: () => null };
  const { routes } = fresh(services);

  const r = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "recipe", name: "红烧肉" },
  });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /默认模型/);
});

test("做法：meta 给出做法清单，recommend 只返回该做法的菜", async () => {
  const { routes } = fresh();
  const meta = await call(routes, "/dsh-meal/meta");

  assert.ok(Array.isArray(meta.json.methods), "meta 应带 methods 清单");
  assert.ok(meta.json.methods.length >= 8, `做法只有 ${meta.json.methods.length} 个，偏少`);
  assert.ok(meta.json.methodsTagged > 2000,
    `标了做法的菜只有 ${meta.json.methodsTagged} 道，覆盖率不对`);

  const chao = meta.json.methods.find((m) => m.method === "炒");
  assert.ok(chao !== undefined, "应有「炒」");
  assert.ok(chao.count > 100, `炒只有 ${chao.count} 道，偏少`);

  const r = await call(routes, "/dsh-meal/recommend", { query: { method: "炒", count: 8 } });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.items.length > 0, "按做法筛选后不该为空");
  for (const it of r.json.items) {
    assert.ok(Array.isArray(it.methods) && it.methods.indexOf("炒") >= 0,
      `${it.name} 不带炒标签却出现在结果里`);
  }

  // 多标签：一道菜能同时出现在两个做法下
  const zhu = await call(routes, "/dsh-meal/recommend",
    { query: { method: "煮", count: 12 } });
  for (const it of zhu.json.items) {
    assert.ok(it.methods.indexOf("煮") >= 0, `${it.name} 不带煮标签`);
  }
});

test("图标路由返回随包自带的透明 PNG", async () => {
  const { routes } = fresh();
  const route = routes.get("/dsh-meal/icon.png");
  assert.ok(route !== undefined, "应有图标路由");

  let headers = null;
  let body = null;
  const res = {
    statusCode: 200,
    writeHead(code, h) { this.statusCode = code; headers = h; },
    end(payload) { body = payload; },
  };
  await route.handler({ method: "GET", url: "/dsh-meal/icon.png" }, res);

  assert.equal(res.statusCode, 200);
  assert.match(headers["Content-Type"], /image\/png/);
  assert.ok(Buffer.isBuffer(body), "应以二进制返回，不能当文本读");
  assert.equal(Number(headers["Content-Length"]), body.length);

  // PNG 魔数
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    assert.equal(body[i], sig[i], `PNG 签名第 ${i} 字节不对`);
  }
  // IHDR：宽高都要是正方，且色彩类型应为带 alpha 的 6（RGBA）
  assert.equal(body.readUInt32BE(16), body.readUInt32BE(20), "图标应是正方形");
  assert.equal(body[25], 6, "应是 RGBA（带透明通道）的 PNG");
  assert.ok(body.length > 5000, `图标只有 ${body.length} 字节，太小了`);
});

test("餐次：meta 给出当前餐次与中文名，手动选择能覆盖时间", async () => {
  const { routes } = fresh();
  const meta = await call(routes, "/dsh-meal/meta");
  assert.ok(["breakfast", "lunch", "dinner", "lateNight"].indexOf(meta.json.mealNow) >= 0,
    `mealNow 不合法：${meta.json.mealNow}`);
  assert.equal(meta.json.mealLabel.lateNight, "夜宵");
  assert.equal(typeof meta.json.hour, "number");
  assert.ok(Array.isArray(meta.json.meals) && meta.json.meals.length >= 3, "应给出各餐次规模");
  assert.ok(meta.json.mealsTagged > 1000, `标了餐次的菜只有 ${meta.json.mealsTagged} 道`);

  const auto = await call(routes, "/dsh-meal/recommend", { query: { hour: "7", count: 6 } });
  assert.equal(auto.json.meal, "auto");
  assert.equal(auto.json.mealNow, "breakfast", "7 点应判为早餐");
  assert.equal(auto.json.mealLabel, "早餐");

  const manual = await call(routes, "/dsh-meal/recommend",
    { query: { meal: "lateNight", hour: "7", count: 6 } });
  assert.equal(manual.json.mealNow, "lateNight", "手动选夜宵应覆盖 7 点");
  assert.equal(manual.json.mealLabel, "夜宵");

  const noon = await call(routes, "/dsh-meal/recommend", { query: { hour: "12", count: 6 } });
  assert.equal(noon.json.mealNow, "lunch");

  const bogus = await call(routes, "/dsh-meal/recommend",
    { query: { meal: "乱填", hour: "18", count: 3 } });
  assert.equal(bogus.json.ok, true);
  assert.equal(bogus.json.meal, "auto", "非法餐次回落到 auto");
  assert.equal(bogus.json.mealNow, "dinner");
});

test("/ask：肥鱼评价用人格提示词，且要求短", async () => {
  const { calls, services } = fakeLlm([{ type: "text-delta", index: 0, text: "好香哦！" }]);
  const { routes } = fresh(services);

  const r = await call(routes, "/dsh-meal/ask", {
    method: "POST", body: { kind: "review", name: "红烧肉" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, "review");
  assert.equal(r.json.text, "好香哦！");

  const opt = calls[0];
  assert.match(opt.system, /大肥鱼/, "system 里要点名角色");
  assert.match(opt.system, /贪吃/, "人设要有贪吃");
  assert.match(opt.system, /乖/, "人设要有乖巧");
  assert.match(opt.messages[0].content[0].text, /红烧肉/, "提示词要带上菜名");
  assert.match(opt.messages[0].content[0].text, /60 字/, "要限制字数，别让评价写成长文");
  assert.ok(opt.maxTokens <= 300, `maxTokens ${opt.maxTokens} 偏大，评价要短`);
});

test("收藏列表：GET 带上每道菜的信息，取消后立刻消失", async () => {
  const { routes } = fresh();
  await call(routes, "/dsh-meal/favorites", {
    method: "POST", body: { action: "set", list: ["红烧肉", "这道菜不存在xyz"] },
  });

  const list = await call(routes, "/dsh-meal/favorites");
  assert.deepEqual(list.json.favorites, ["红烧肉", "这道菜不存在xyz"]);
  assert.equal(list.json.items.length, 2, "每道收藏都要有一条信息");

  const good = list.json.items.find((i) => i.name === "红烧肉");
  assert.equal(good.inLibrary, true);
  assert.equal(typeof good.cuisine, "string");
  assert.ok(Array.isArray(good.methods) && Array.isArray(good.meals));

  // 菜库里没有的收藏要标出来，而不是悄悄过滤掉
  const missing = list.json.items.find((i) => i.name === "这道菜不存在xyz");
  assert.equal(missing.inLibrary, false);
  assert.equal(missing.cuisine, undefined);

  const removed = await call(routes, "/dsh-meal/favorites", {
    method: "POST", body: { action: "remove", name: "红烧肉" },
  });
  assert.deepEqual(removed.json.favorites, ["这道菜不存在xyz"], "取消收藏后应消失");
  assert.equal(removed.json.items.length, 1);
});

// ---- 忌口持久化。注意顺序：先测「没设过时用配置」，再测「设过之后持久化」，
// 因为下面的测试会往 TMP_HOME 里写 prefs.json。
test("忌口：没在面板里设过时，用插件配置里的那份", async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, { avoid: "苦瓜,香菜" });
  const meta = await call(routes, "/dsh-meal/meta");
  assert.deepEqual(meta.json.avoid, ["苦瓜", "香菜"]);
  assert.equal(meta.json.avoidSaved, false, "还没在面板里设过");
});

test("忌口永久保留：写入后重启（重新 apply）仍在，并真的影响推荐", async () => {
  const first = fresh();
  const saved = await call(first.routes, "/dsh-meal/prefs", {
    method: "POST", body: { avoid: "香菜,内脏" },
  });
  assert.equal(saved.json.ok, true);
  assert.deepEqual(saved.json.avoid, ["香菜", "内脏"]);
  assert.equal(saved.json.avoidSaved, true);
  assert.equal(saved.json.persisted, true, "应写盘成功");

  // 模拟重启：重新 apply 一次，从磁盘读回
  const again = fresh();
  const meta = await call(again.routes, "/dsh-meal/meta");
  assert.deepEqual(meta.json.avoid, ["香菜", "内脏"], "重启后忌口应该还在");
  assert.equal(meta.json.avoidSaved, true);

  // 请求里不带 avoid 时，用的是持久化那份
  const r = await call(again.routes, "/dsh-meal/recommend", { query: { count: "12" } });
  assert.ok(r.json.items.length > 0);
  for (const it of r.json.items) {
    assert.ok(it.name.indexOf("香菜") < 0 && it.name.indexOf("内脏") < 0,
      `推出了忌口菜：${it.name}`);
  }

  // 清空也是一种设置：空列表要能盖住旧的列表
  const cleared = await call(again.routes, "/dsh-meal/prefs", {
    method: "POST", body: { avoid: "" },
  });
  assert.deepEqual(cleared.json.avoid, []);
  const after = await call(fresh().routes, "/dsh-meal/meta");
  assert.deepEqual(after.json.avoid, [], "清空后重启也该是空的");
});

test("做法：非法或空做法不会报错", async () => {
  const { routes } = fresh();
  const empty = await call(routes, "/dsh-meal/recommend", { query: { method: "", count: 3 } });
  assert.equal(empty.json.ok, true);
  assert.equal(empty.json.items.length, 3, "空做法等于不限");

  const none = await call(routes, "/dsh-meal/recommend",
    { query: { method: "不存在的做法xyz", count: 3 } });
  assert.equal(none.json.ok, true);
  assert.equal(none.json.empty, true, "筛不到时应给出空结果而不是报错");
});

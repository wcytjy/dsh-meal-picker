/**
 * 纯逻辑单测：筛选、权重、两段式抽样、收藏、放宽规则。
 * 运行：node --test test/core.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CITY_REGION,
  DEFAULT_FAV_BOOST,
  DEFAULT_MAINSTREAM_COUNT,
  FAVORITE_BASE_WEIGHT,
  buildRecipePrompt,
  describePool,
  filterDishes,
  mealOfHour,
  normalizeOptions,
  pickDish,
  pickMany,
  recipeSearchUrl,
  regionOfCity,
  resolvePool,
  weightOf,
} from "../lib/core.js";

const D = (name, cuisine, kcal, star, weight, extra = {}) => ({
  name, cuisine, kcal, p: 8, f: 5, c: 10, star, weight,
  scene: "both", foreign: false, ...extra,
});

const DISHES = [
  D("红烧肉", "家常菜", 513, 5, 120, { scene: "home" }),
  D("宫保鸡丁", "家常菜", 127, 5, 120, { scene: "home" }),
  D("清蒸鱼", "私家菜", 106, 5, 120, { scene: "home" }),
  D("麻辣烫", "其他菜肴", 120, 5, 120, { scene: "takeout" }),
  D("鳗鱼寿司", "日本料理", 154, 5, 120, { scene: "takeout", foreign: true }),
  D("某冷门菜", "甘肃菜", 300, 0, 2),
  D("香菜拌牛肉", "四川菜", 150, 0, 4),
];

/** 主流/冷门各 10 道，用来测两段式抽样 */
const RATIO_SET = [];
for (let i = 0; i < 10; i += 1) RATIO_SET.push(D("主流" + i, "家常菜", 150, 5, 120));
for (let i = 0; i < 10; i += 1) RATIO_SET.push(D("冷门" + i, "家常菜", 150, 0, 4));

function sample(items, opt, rounds = 3000) {
  const counts = new Map();
  for (let i = 0; i < rounds; i += 1) {
    const d = pickDish(items, opt, Math.random);
    if (d !== null) counts.set(d.name, (counts.get(d.name) || 0) + 1);
  }
  return counts;
}

const rateOf = (counts, pred, rounds) => {
  let n = 0;
  for (const [name, c] of counts) if (pred(name)) n += c;
  return n / rounds;
};

// ---------------------------------------------------------------- 选项归一化

test("normalizeOptions 给出安全默认值", () => {
  const o = normalizeOptions();
  assert.equal(o.scene, "cook");
  assert.equal(o.foreign, "any");
  assert.deepEqual(o.avoid, []);
  assert.deepEqual(o.favorites, []);
  assert.equal(o.favOnly, false);
  assert.equal(o.favBoost, DEFAULT_FAV_BOOST);
  assert.equal(o.mainstreamCount, DEFAULT_MAINSTREAM_COUNT);
  assert.equal(o.region, "");
});

test("normalizeOptions 处理非法值与各种分隔符", () => {
  const o = normalizeOptions({
    scene: "hack", foreign: "xxx", avoid: "香菜,内脏、苦瓜 芹菜",
    favorites: "红烧肉，宫保鸡丁、清蒸鱼;麻辣烫", favBoost: 999, mainstreamCount: 999,
  });
  assert.equal(o.scene, "cook");
  assert.equal(o.foreign, "any");
  assert.deepEqual(o.avoid, ["香菜", "内脏", "苦瓜", "芹菜"]);
  assert.deepEqual(o.favorites, ["红烧肉", "宫保鸡丁", "清蒸鱼", "麻辣烫"]);
  assert.equal(o.favBoost, 50, "favBoost 上限 50");
  assert.equal(o.mainstreamCount, 20, "mainstreamCount 上限 20");
  assert.equal(normalizeOptions({ favBoost: 0 }).favBoost, 1, "下限 1");
  assert.equal(normalizeOptions({ mainstreamCount: -3 }).mainstreamCount, 0, "下限 0");
});

test("normalizeOptions 接受收藏数组和 fav 别名", () => {
  assert.deepEqual(normalizeOptions({ favorites: ["红烧肉"] }).favorites, ["红烧肉"]);
  assert.deepEqual(normalizeOptions({ fav: "红烧肉,宫保鸡丁" }).favorites, ["红烧肉", "宫保鸡丁"]);
});

test("regionOfCity 认城市和省份，也认空", () => {
  assert.equal(regionOfCity("成都"), "四川菜");
  assert.equal(regionOfCity("广东省深圳市"), "广东菜");
  assert.equal(regionOfCity("沈阳"), "东北菜");
  assert.equal(regionOfCity("某个小县城"), "");
  assert.equal(regionOfCity(""), "");
});

// ---------------------------------------------------------------- 过滤

test("filterDishes 按忌口过滤（按名字包含）", () => {
  assert.deepEqual(
    filterDishes(DISHES, normalizeOptions({ avoid: "香菜,肉" })).map((d) => d.name),
    ["宫保鸡丁", "清蒸鱼", "麻辣烫", "鳗鱼寿司", "某冷门菜"]);
});

test("filterDishes 外国菜三种模式", () => {
  const names = (m) => filterDishes(DISHES, normalizeOptions({ foreign: m })).map((d) => d.name);
  assert.ok(names("any").includes("鳗鱼寿司"));
  assert.ok(!names("off").includes("鳗鱼寿司"));
  assert.deepEqual(names("only"), ["鳗鱼寿司"]);
});

test("filterDishes 只管硬条件，场景过滤交给 resolvePool", () => {
  const cook = filterDishes(DISHES, normalizeOptions({ scene: "cook" })).map((d) => d.name);
  assert.ok(cook.includes("麻辣烫"), "filterDishes 不负责排除外卖菜");
  const cooked = resolvePool(DISHES, normalizeOptions({ scene: "cook" })).pool.map((d) => d.name);
  assert.ok(!cooked.includes("麻辣烫"), "resolvePool 才排除外卖菜");
});

// ---------------------------------------------------------------- 放宽规则

test("resolvePool：自己做模式下无解时自动放宽场景并给出理由", () => {
  const r = resolvePool(DISHES, normalizeOptions({ scene: "cook", foreign: "only" }));
  assert.equal(r.pool.length, 1, "放宽后应能拿到外国菜，而不是空列表");
  assert.equal(r.relaxed, true);
  assert.match(r.reason, /自己做/);

  const normal = resolvePool(DISHES, normalizeOptions({ scene: "cook" }));
  assert.equal(normal.relaxed, false);
  assert.ok(normal.pool.every((d) => d.scene !== "takeout"));

  const impossible = resolvePool(DISHES, normalizeOptions({ avoid: "肉,鱼,鸡,烫,寿司,菜" }));
  assert.equal(impossible.pool.length, 0);
  assert.equal(impossible.relaxed, false);
});

test("resolvePool：收藏筛选与放宽", () => {
  // 只收藏不 favOnly：池子不变，只是收藏被单独分组（影响权重）
  const keep = resolvePool(DISHES, normalizeOptions({ favorites: ["红烧肉", "宫保鸡丁"] }));
  assert.equal(keep.pool.length, 5, "不开「只要收藏」时池子不该缩小");
  assert.equal(keep.groups.favorites, 2);
  assert.equal(keep.relaxed, false);

  // favOnly + 有匹配 -> 池子收敛到收藏
  const hit = resolvePool(DISHES,
    normalizeOptions({ favorites: ["红烧肉", "宫保鸡丁"], favOnly: true }));
  assert.deepEqual(hit.pool.map((d) => d.name), ["红烧肉", "宫保鸡丁"]);
  assert.equal(hit.relaxed, false);

  // 开了「只要收藏」但还没收藏任何东西 -> 放宽并说明
  const none = resolvePool(DISHES, normalizeOptions({ favOnly: true }));
  assert.equal(none.relaxed, true);
  assert.match(none.reason, /还没有收藏/);
  assert.equal(none.pool.length, 5);

  // 收藏里没有符合菜系条件的 -> 放宽（用数据里真实存在的菜系，否则是「菜系本身无匹配」）
  const mismatch = resolvePool(DISHES,
    normalizeOptions({ favOnly: true, favorites: ["红烧肉"], cuisine: "私家菜" }));
  assert.equal(mismatch.relaxed, true);
  assert.match(mismatch.reason, /收藏里没有/);
  assert.ok(mismatch.pool.length > 0, "放宽后不该是空池");

  // 硬条件本身就没有匹配 -> 保持空池、不硬编（不去无视明确指定的菜系）
  const noSuchCuisine = resolvePool(DISHES,
    normalizeOptions({ favOnly: true, favorites: ["红烧肉"], cuisine: "不存在的菜系" }));
  assert.equal(noSuchCuisine.pool.length, 0);
  assert.equal(noSuchCuisine.relaxed, false);

  // 收藏的是偏外卖的菜，又开着「自己做」-> 收藏优先，不被场景软条件筛掉
  const takeoutFav = resolvePool(DISHES,
    normalizeOptions({ favOnly: true, favorites: ["鳗鱼寿司"] }));
  assert.deepEqual(takeoutFav.pool.map((d) => d.name), ["鳗鱼寿司"],
    "收藏过的外卖菜也必须能出");
  assert.equal(takeoutFav.relaxed, true);
  assert.match(takeoutFav.reason, /收藏里有偏外卖的菜/);
});

// ---------------------------------------------------------------- 分组

test("resolvePool 的分组：收藏算进优先组", () => {
  const g = resolvePool(DISHES, normalizeOptions({ favorites: ["某冷门菜"] })).groups;
  // cook 模式排除了麻辣烫和鳗鱼寿司（都是 takeout），池子剩 5 道
  assert.equal(g.total, 5);
  assert.equal(g.mainstream, 3, "红烧肉 / 宫保鸡丁 / 清蒸鱼");
  assert.equal(g.favorites, 1);
  assert.equal(g.preferred, 4, "3 道主流 + 1 道收藏");
  assert.equal(g.others, 1, "只剩香菜拌牛肉");
});

// ---------------------------------------------------------------- 权重

test("weightOf：收藏菜至少与主流菜同档，再乘 favBoost", () => {
  const plain = normalizeOptions({});
  const fav = DISHES.find((d) => d.name === "某冷门菜");        // 原始权重 2
  const normal = weightOf(fav, plain);
  const asFav1 = weightOf(fav, normalizeOptions({ favorites: ["某冷门菜"], favBoost: 1 }));
  const asFav5 = weightOf(fav, normalizeOptions({ favorites: ["某冷门菜"], favBoost: 5 }));
  assert.equal(asFav1, FAVORITE_BASE_WEIGHT, "favBoost=1 时和主流菜同档");
  assert.ok(asFav1 > normal * 50, "收藏本身就该是巨大提升");
  assert.equal(asFav5, asFav1 * 5);
});

test("weightOf：场景偏好与城市加权仍在", () => {
  const home = DISHES.find((d) => d.name === "红烧肉");          // scene: home
  const cook = normalizeOptions({ scene: "cook" });
  const out = normalizeOptions({ scene: "takeout" });
  assert.equal(weightOf(home, cook) / weightOf(home, out), 2);

  const sichuan = DISHES.find((d) => d.cuisine === "四川菜");
  const plain = normalizeOptions({});
  const chengdu = normalizeOptions({ city: "成都" });
  assert.equal(weightOf(sichuan, chengdu) / weightOf(sichuan, plain), 2.5);
});

test("weightOf：最近推过的会被降权", () => {
  const d = DISHES[0];
  const fresh = weightOf(d, normalizeOptions({}));
  const justServed = weightOf(d, normalizeOptions({ recent: ["红烧肉"] }));
  const older = weightOf(d, normalizeOptions({ recent: ["红烧肉", "宫保鸡丁", "清蒸鱼"] }));
  assert.ok(justServed < older, "越近推过降得越狠");
  assert.ok(older < fresh);
  assert.ok(justServed > 0, "但不为零，不至于永远抽不到");
});

// ---------------------------------------------------------------- 保底主流

test("pickDish：单道一定给主流菜（优先组为空才退回全池）", () => {
  const opt = normalizeOptions({});
  for (let i = 0; i < 200; i += 1) {
    assert.equal(pickDish(RATIO_SET, opt).star, 5, "单道应总是主流菜");
  }
});

test("pickDish：优先组为空时退回全池，不会返回 null", () => {
  const onlyCold = RATIO_SET.filter((d) => d.star === 0);
  const d = pickDish(onlyCold, normalizeOptions({}), () => 0.1);
  assert.ok(d !== null);
  assert.equal(d.star, 0);
});

// ---------------------------------------------------------------- 收藏抽样

// 收藏的冷门菜不可能出现在保底名额里（那两道只给五星主流），
// 所以现在它靠随机名额出现 —— 收藏权重 120×favBoost 仍会把随机那道顶向它。
test("收藏菜的出现率随 favBoost 明显上升", () => {
  const rounds = 2000;
  const FAV = "冷门0";
  const rate = (boost) => {
    const opt = normalizeOptions({ favorites: [FAV], favBoost: boost });
    let hit = 0;
    for (let i = 0; i < rounds; i += 1) {
      if (pickMany(RATIO_SET, opt, 3).items.some((d) => d.name === FAV)) hit += 1;
    }
    return hit / rounds;
  };
  const r1 = rate(1);
  const r20 = rate(20);
  // favBoost=1 的语义是「和国民菜一样常出」：池子里有 10 道国民菜，所以它排在
  // 其中之一，批次命中率不高但稳定 > 0；倍数上去之后明显压过国民菜。
  assert.ok(r1 > 0.02 && r1 < 0.35, `favBoost=1 实测 ${r1.toFixed(3)}，应稳定但不垄断`);
  assert.ok(r20 > 0.45, `favBoost=20 时应明显压过国民菜（实测 ${r20.toFixed(3)}）`);
  assert.ok(r20 > r1 * 2, "倍数应该真的起作用");
});

test("pickDish：只出现收藏菜时，抽到的全是收藏", () => {
  const favs = ["冷门0", "冷门1", "主流3"];
  const opt = normalizeOptions({ favorites: favs, favOnly: true });
  for (let i = 0; i < 300; i += 1) {
    const d = pickDish(RATIO_SET, opt);
    assert.ok(favs.includes(d.name), `抽到了非收藏菜：${d.name}`);
  }
});

// ---------------------------------------------------------------- pickMany

test("pickMany：前两道必定五星主流，第三道随机", () => {
  const opt = normalizeOptions({});
  assert.equal(opt.mainstreamCount, 2, "默认保底两道");

  let thirdMainstream = 0;
  const rounds = 400;
  for (let i = 0; i < rounds; i += 1) {
    const items = pickMany(RATIO_SET, opt, 3).items;
    assert.equal(items.length, 3);
    assert.equal(items[0].star, 5, "第 1 道必定主流");
    assert.equal(items[1].star, 5, "第 2 道必定主流");
    assert.notEqual(items[0].name, items[1].name, "前两道不该重复");
    if (items[2].star === 5) thirdMainstream += 1;
  }
  // 第三道不保底，走原本的权重（主流 120 / 冷门 4），所以多数时候仍是主流菜，
  // 但明显少于前两道 —— 这就是「偶尔给你个没吃过的」。
  const share = thirdMainstream / rounds;
  assert.ok(share < 1, "第三道不该像前两道那样被保底");
  assert.ok(share > 0.7,
    `第三道主流占比 ${(share * 100).toFixed(0)}%，主流权重应当仍然占优`);
});

test("pickMany：mainstreamCount 可调，0 表示不保底", () => {
  // 不保底时第一道也可能是冷门菜
  const none = normalizeOptions({ mainstreamCount: 0 });
  let sawCold = false;
  for (let i = 0; i < 300 && !sawCold; i += 1) {
    if (pickMany(RATIO_SET, none, 3).items[0].star !== 5) sawCold = true;
  }
  assert.ok(sawCold, "mainstreamCount=0 时不该还锁着主流菜");

  // 保底 3 道 = 整批全主流
  const all = normalizeOptions({ mainstreamCount: 3 });
  for (let i = 0; i < 200; i += 1) {
    for (const d of pickMany(RATIO_SET, all, 3).items) {
      assert.equal(d.star, 5, "保底 3 道时整批都应是主流菜");
    }
  }

  // 保底数超过要几道菜时，夹到 count，不会翻车
  const over = normalizeOptions({ mainstreamCount: 20 });
  assert.equal(pickMany(RATIO_SET, over, 3).items.length, 3);
});

test("pickMany：要的菜数超过池子时不重复、不报错", () => {
  const got = pickMany(DISHES, normalizeOptions({}), 5);
  assert.equal(got.items.length, 5);
  assert.equal(new Set(got.items.map((d) => d.name)).size, 5);
  assert.equal(got.relaxed, false);
  assert.ok(got.poolSize >= 5);
  assert.equal(typeof got.groups.mainstream, "number");

  const tiny = pickMany(DISHES, normalizeOptions({ scene: "cook", foreign: "only" }), 5);
  assert.equal(tiny.items.length, 1);
  assert.equal(tiny.relaxed, true);

  // 放宽后不该返回空
  const noFav = pickMany(DISHES, normalizeOptions({ favOnly: true }), 5);
  assert.equal(noFav.items.length, 5);
  assert.equal(noFav.relaxed, true);
});

// ---------------------------------------------------------------- 其它

test("describePool 汇报候选规模、分组与是否放宽", () => {
  const info = describePool(DISHES, normalizeOptions({ city: "成都" }));
  assert.equal(info.region, "四川菜");
  assert.equal(info.candidates, 5, "cook 模式排除两道偏外卖的");
  assert.equal(info.relaxed, false);
  assert.equal(info.mainstream, 3);
  assert.equal(info.mainstreamCount, 2);
  assert.equal(info.favorites, 0);
});

test("食谱链接与提示词", () => {
  const url = recipeSearchUrl("红烧肉");
  assert.ok(url.startsWith("https://www.xiachufang.com/search/?keyword="));
  assert.ok(url.includes(encodeURIComponent("红烧肉")));

  const p = buildRecipePrompt("红烧肉", "cook");
  assert.ok(p.includes("红烧肉"));
  assert.ok(p.length < 120, "提示词要短，省 token");
  assert.ok(buildRecipePrompt("麻辣烫", "takeout").includes("麻辣烫"));
});

test("CITY_REGION 覆盖主要城市且没有空值", () => {
  const keys = Object.keys(CITY_REGION);
  assert.ok(keys.length >= 40, `城市数 ${keys.length} 偏少`);
  for (const k of keys) assert.ok(CITY_REGION[k].length > 0);
});

// ---------------------------------------------------------------- 餐次

test("餐次按钟点判断，边界要准", () => {
  assert.equal(mealOfHour(5), "breakfast", "5 点算早餐");
  assert.equal(mealOfHour(7), "breakfast");
  assert.equal(mealOfHour(9), "breakfast");
  assert.equal(mealOfHour(10), "lunch", "10 点转午餐");
  assert.equal(mealOfHour(12), "lunch");
  assert.equal(mealOfHour(14), "lunch");
  assert.equal(mealOfHour(15), "dinner", "15 点转晚餐");
  assert.equal(mealOfHour(18), "dinner");
  assert.equal(mealOfHour(20), "dinner");
  assert.equal(mealOfHour(21), "lateNight", "21 点转夜宵");
  assert.equal(mealOfHour(23), "lateNight");
  assert.equal(mealOfHour(0), "lateNight");
  assert.equal(mealOfHour(4), "lateNight");
  // 越界与非法值不崩：小时数按 24 回绕
  assert.equal(mealOfHour(25), "lateNight", "25 点回绕成 1 点");
  assert.equal(mealOfHour(-1), "lateNight", "-1 点回绕成 23 点");
  assert.equal(typeof mealOfHour(undefined), "string", "缺参数时给个合理默认");
});

test("餐次影响权重：命中加权、错餐降权、中立不动", () => {
  const M = (name, meals) => ({ ...D(name, "家常菜", 200, 0, 100), meals });

  const opt = normalizeOptions({ meal: "auto", hour: 7 });
  assert.equal(opt.mealNow, "breakfast", "auto 应按小时解析成早餐");

  const baozi = M("包子", ["breakfast"]);
  const grill = M("烤串", ["lateNight"]);
  const neutral = M("宫保鸡丁", []);

  const wBao = weightOf(baozi, opt);
  const wGrill = weightOf(grill, opt);
  const wNeutral = weightOf(neutral, opt);

  assert.ok(wBao > wNeutral, "早餐时段命中早餐标签应加权");
  assert.ok(wGrill < wNeutral, "早餐时段抽到夜宵类应降权");
  assert.ok(wNeutral > 0 && wNeutral < 100,
    "没标签的菜只被轻降（不确定≠不合适），不该归零也不该纹丝不动");
  assert.ok(wGrill < wNeutral * 0.6, "明确不对餐的，降得比中立更狠");

  // 手动指定时忽略小时
  const night = normalizeOptions({ meal: "lateNight", hour: 7 });
  assert.equal(night.mealNow, "lateNight", "手动选的餐次不被时间覆盖");
  assert.ok(weightOf(grill, night) > weightOf(neutral, night), "夜宵时段烤串应加权");
  assert.ok(weightOf(baozi, night) < weightOf(neutral, night), "夜宵时段包子应降权");

  // 一道菜同时属于多餐：任一命中即加权
  const both = M("豆浆油条", ["breakfast", "lateNight"]);
  assert.ok(weightOf(both, opt) > wNeutral);
  assert.ok(weightOf(both, night) > wNeutral);
});

test("餐次不参与硬筛：没标签的菜任何时段都还在池子里", () => {
  const dishes = [
    { ...D("包子", "家常菜", 200, 0, 4), meals: ["breakfast"] },
    { ...D("烤串", "其他菜肴", 300, 0, 4), meals: ["lateNight"] },
    { ...D("宫保鸡丁", "四川菜", 200, 0, 4), meals: [] },
  ];
  for (const hour of [7, 12, 18, 23]) {
    const opt = normalizeOptions({ meal: "auto", hour });
    assert.equal(filterDishes(dishes, opt).length, 3, `${hour} 点时三道菜都应保留`);
  }
});

// 做法是多标签：一道菜可以有多个做法（如爆汆鱼块 = 炒 + 煮）。
// 菜名里没写做法的菜不会带标签，选做法时会被排除 —— 这是覆盖面决定的，不是 bug。
test("做法按多标签匹配，没标签的菜在选做法时被排除", () => {
  const M = (name, methods) => ({ ...D(name, "家常菜", 100, 0, 4), methods });
  const dishes = [
    M("木耳炒鸡蛋", ["炒"]),
    M("爆汆鱼块", ["炒", "煮"]),
    M("清蒸鲈鱼", ["蒸"]),
    M("宫保鸡丁", []),        // 菜名里没写做法
  ];
  const pick = (method) =>
    filterDishes(dishes, normalizeOptions({ method })).map((d) => d.name);

  assert.deepEqual(pick("炒"), ["木耳炒鸡蛋", "爆汆鱼块"]);
  assert.deepEqual(pick("煮"), ["爆汆鱼块"], "多标签能让同一道菜出现在两个做法下");
  assert.deepEqual(pick("蒸"), ["清蒸鲈鱼"]);
  assert.ok(!pick("炒").includes("宫保鸡丁"), "没标签的菜不该被选中");
  assert.equal(pick("").length, 4, "不选做法时全部保留");

  // 数据里没有 methods 字段时不该崩
  const legacy = [D("红烧肉", "家常菜", 513, 5, 120)];
  assert.equal(filterDishes(legacy, normalizeOptions({ method: "炒" })).length, 0);
  assert.equal(filterDishes(legacy, normalizeOptions({})).length, 1);
});

test("做法与菜系、忌口可以叠加", () => {
  const M = (name, cuisine, methods) => ({
    ...D(name, cuisine, 100, 0, 4), methods,
  });
  const dishes = [
    M("川味炒肉", "四川菜", ["炒"]),
    M("粤式炒饭", "广东菜", ["炒"]),
    M("川味蒸鱼", "四川菜", ["蒸"]),
  ];
  const got = filterDishes(dishes, normalizeOptions({ method: "炒", cuisine: "四川菜" }))
    .map((d) => d.name);
  assert.deepEqual(got, ["川味炒肉"]);

  const avoided = filterDishes(dishes, normalizeOptions({ method: "炒", avoid: "粤式" }))
    .map((d) => d.name);
  assert.deepEqual(avoided, ["川味炒肉"]);
});

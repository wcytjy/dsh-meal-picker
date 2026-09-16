/**
 * dsh-meal-picker 的纯逻辑核心。
 *
 * 这个文件**不依赖 DSH、不依赖 Node、不依赖 React**，只做数据筛选和加权随机，
 * 所以可以单独跑单元测试，将来也能搬到别的宿主里用。
 */

/** 城市 -> 数据集里的菜系分类名 */
export const CITY_REGION = {
  成都: "四川菜", 重庆: "四川菜", 绵阳: "四川菜", 自贡: "四川菜",
  广州: "广州菜", 深圳: "广东菜", 珠海: "广东菜", 东莞: "广东菜", 佛山: "广东菜",
  上海: "上海菜", 杭州: "浙江菜", 宁波: "浙江菜", 温州: "浙江菜",
  南京: "江苏菜", 苏州: "江苏菜", 无锡: "江苏菜",
  北京: "北京菜", 天津: "天津菜", 石家庄: "北京菜", 保定: "北京菜",
  长沙: "湖南菜", 株洲: "湖南菜", 武汉: "湖北菜", 宜昌: "湖北菜",
  西安: "陕西菜", 兰州: "甘肃菜", 银川: "甘肃菜", 西宁: "甘肃菜",
  郑州: "河南菜", 洛阳: "河南菜", 济南: "山东菜", 青岛: "山东菜", 烟台: "山东菜",
  沈阳: "东北菜", 哈尔滨: "东北菜", 长春: "东北菜", 大连: "东北菜",
  昆明: "滇黔菜", 贵阳: "滇黔菜", 厦门: "福建菜", 福州: "福建菜", 泉州: "福建菜",
  乌鲁木齐: "新疆菜", 呼和浩特: "少数民族菜", 合肥: "安徽菜", 南昌: "江西菜",
  太原: "山西菜", 南宁: "广西菜", 桂林: "广西菜", 海口: "海南菜", 三亚: "海南菜",
  拉萨: "少数民族菜", 台北: "台湾菜", 高雄: "台湾菜",
};

/** 场景：cook=自己做，takeout=点外卖 */
export const SCENES = ["cook", "takeout"];
/** 外国菜开关：any=都行，off=只要中餐，only=只要外国菜 */
export const FOREIGN_MODES = ["any", "off", "only"];

/** 主流菜占比默认 0.8：保证「大概每 5 次里有 4 次是国民菜」 */
/**
 * 默认保底几道主流菜。
 *
 * 以前的模型是「每道都按 80% 概率出主流菜」，现在改成**前 N 道必定主流、其余随机**：
 * 一下子给三道菜时，头两道稳稳是熟悉的国民菜，第三道留给惊喜。
 */
export const DEFAULT_MAINSTREAM_COUNT = 2;
/** 收藏菜在候选组里的权重倍数 */
export const DEFAULT_FAV_BOOST = 5;
/** 收藏菜的基准权重（与五星国民菜同档，见 weightOf 的注释） */
export const FAVORITE_BASE_WEIGHT = 120;
/** 收藏列表里允许出现的分隔符（含换行，用 charCode 判定以避开转义） */
const FAV_SEP = ",，、;；";

function toNameList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw !== "string") return [];
  const parts = [];
  let buf = "";
  for (const ch of raw) {
    if (FAV_SEP.includes(ch) || ch.charCodeAt(0) === 10) {
      if (buf.trim() !== "") parts.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== "") parts.push(buf.trim());
  return parts;
}

function clampInt(v, lo, hi, fallback) {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

const AVOID_SPLIT = /[,，、;；\s]+/;

/**
 * 餐次：
 *   auto  —— 按当前时间判断
 *   any   —— 不限餐次（不做任何餐次加权，严格的「80% 主流」保证只在这种模式下成立）
 *   其余四个 —— 手动指定
 */
export const MEALS = ["auto", "any", "breakfast", "lunch", "dinner", "lateNight"];

export const MEAL_LABEL = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  lateNight: "夜宵",
};

/** 命中当前餐次的权重倍数 */
export const MEAL_BOOST = 6;
/** 有餐次标签、但都不属于当前餐次的降权倍数（早餐时段抽到烧烤的概率） */
export const MEAL_MISMATCH = 0.25;
/**
 * 没有餐次标签的菜在指定餐次时的权重倍数。
 * 不设 1 是因为中立组太大（两千多道），完全不压的话已知合适的菜会被淹掉；
 * 也不设 0，因为「不知道」不等于「不合适」。
 */
export const MEAL_NEUTRAL = 0.55;

/**
 * 小时 -> 餐次。
 *   05:00–10:00 早餐 / 10:00–15:00 午餐 / 15:00–21:00 晚餐 / 其余 夜宵
 */
export function mealOfHour(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12;
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 15) return "lunch";
  if (h >= 15 && h < 21) return "dinner";
  return "lateNight";
}

/**
 * 把任意来源的原始选项整理成规范形式。
 * @param {object} raw
 */
export function normalizeOptions(raw = {}) {
  const scene = SCENES.includes(raw.scene) ? raw.scene : "cook";
  const foreign = FOREIGN_MODES.includes(raw.foreign) ? raw.foreign : "any";
  let avoid = [];
  if (Array.isArray(raw.avoid)) avoid = raw.avoid;
  else if (typeof raw.avoid === "string") avoid = raw.avoid.split(AVOID_SPLIT);
  avoid = avoid.map((s) => String(s).trim()).filter((s) => s.length > 0);

  const city = typeof raw.city === "string" ? raw.city.trim() : "";
  const cuisine = typeof raw.cuisine === "string" ? raw.cuisine.trim() : "";
  const method = typeof raw.method === "string" ? raw.method.trim() : "";
  const meal = MEALS.indexOf(raw.meal) >= 0 ? raw.meal : "auto";
  const hour = Number.isFinite(raw.hour) ? raw.hour : new Date().getHours();
  const recent = Array.isArray(raw.recent) ? raw.recent.filter((s) => typeof s === "string") : [];

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const favorites = toNameList(raw.favorites === undefined ? raw.fav : raw.favorites);
  const favOnly = raw.favOnly === true || raw.favOnly === "1" || raw.favOnly === "true";
  const boost = Number.parseInt(
    String(raw.favBoost === undefined ? DEFAULT_FAV_BOOST : raw.favBoost), 10);

  return {
    scene,
    foreign,
    avoid,
    city,
    cuisine,
    method,
    meal,
    hour,
    // any = 不限餐次（mealNow 为空，餐次加权全部停用）
    mealNow: meal === "auto" ? mealOfHour(hour) : (meal === "any" ? "" : meal),
    recent,
    region: cuisine || regionOfCity(city),
    kcalMin: num(raw.kcalMin),
    kcalMax: num(raw.kcalMax),
    favorites,
    favoriteSet: new Set(favorites),
    favOnly,
    favBoost: Number.isFinite(boost) ? Math.min(50, Math.max(1, boost)) : DEFAULT_FAV_BOOST,
    // 前几道保底主流（0~20，实际会被这次要几道菜夹住）
    mainstreamCount: clampInt(raw.mainstreamCount, 0, 20, DEFAULT_MAINSTREAM_COUNT),
  };
}

/** 城市 -> 菜系分类（空字符串表示没有对应） */
export function regionOfCity(city) {
  const c = String(city || "").trim();
  if (c === "") return "";
  for (const key of Object.keys(CITY_REGION)) {
    if (c.includes(key)) return CITY_REGION[key];
  }
  return "";
}

/**
 * 只做「硬条件」过滤：忌口、菜系、做法、热量区间、外国菜模式。
 * 场景（自己做/外卖）是**软条件**，见 resolvePool。
 *
 * 做法按多标签匹配：一道菜可以同时是「炒」和「煮」（如爆汆鱼块），
 * 只要标签里含所选做法就算命中。没打上标签的菜（菜名里没写做法）
 * 在选了做法时会被排除，这是数据覆盖面决定的，不是逻辑问题。
 */
export function filterDishes(dishes, opt) {
  return dishes.filter((d) => {
    if (opt.avoid.length > 0 && opt.avoid.some((w) => d.name.includes(w))) return false;
    if (opt.foreign === "only" && d.foreign !== true) return false;
    if (opt.foreign === "off" && d.foreign === true) return false;
    if (opt.cuisine !== "" && d.cuisine !== opt.cuisine) return false;
    if (opt.method !== "" && !(Array.isArray(d.methods) && d.methods.indexOf(opt.method) >= 0)) return false;
    if (opt.kcalMin !== null && d.kcal < opt.kcalMin) return false;
    if (opt.kcalMax !== null && d.kcal > opt.kcalMax) return false;
    return true;
  });
}

/**
 * 决定最终候选池，并回报放宽过哪些条件。
 *
 * 两处软件条件（都是「宁可给你一道能吃的，也不给你空列表」）：
 *   1. 场景：「自己做」会排除基本只能点到的菜；排除后为空则放宽。
 *   2. 收藏：「只要收藏菜」但收藏里没有符合当前条件的菜时放宽。
 *
 * @returns {{pool: Array, relaxed: boolean, reason: string, groups: object}}
 */
export function resolvePool(dishes, opt) {
  const hard = filterDishes(dishes, opt);
  let pool = hard;
  let relaxed = false;
  let reason = "";
  let favLocked = false;

  // ---- 收藏优先 ----
  // 这一步刻意放在场景过滤**之前**：收藏是使用者明确点过星的，
  // 不该因为「自己做」这种软偏好被悄悄筛掉（否则收藏的外卖菜永远出不来）。
  if (opt.favOnly) {
    const favs = opt.favoriteSet.size > 0
      ? hard.filter((d) => opt.favoriteSet.has(d.name))
      : [];
    if (favs.length > 0) {
      pool = favs;
      favLocked = true;
      if (opt.scene === "cook" && favs.some((d) => d.scene === "takeout")) {
        relaxed = true;
        reason = "收藏里有偏外卖的菜，「只要收藏菜」优先，本次未按「自己做」过滤";
      }
    } else if (opt.favoriteSet.size === 0) {
      relaxed = true;
      reason = "还没有收藏任何菜，已忽略「只要收藏菜」";
    } else if (hard.length > 0) {
      relaxed = true;
      reason = "收藏里没有符合当前条件的菜，已放宽到全部菜品";
    }
  }

  // ---- 场景（软条件）----
  if (!favLocked && opt.scene === "cook") {
    const homeOnly = pool.filter((d) => d.scene !== "takeout");
    if (homeOnly.length > 0) {
      pool = homeOnly;
    } else if (pool.length > 0) {
      relaxed = true;
      reason = "「自己做」条件下没有合适的菜，已放宽到店里也能吃到的";
    }
  }

  // ---- 分组（供两段式抽样与统计用）----
  const favoritePool = pool.filter((d) => opt.favoriteSet.has(d.name));
  const favNames = new Set(favoritePool.map((d) => d.name));
  // 收藏菜一律算进「优先组」：这样收藏一道冷门菜也能明显提高它出现的概率
  const preferredPool = pool.filter((d) => d.star === 5 || favNames.has(d.name));
  const prefNames = new Set(preferredPool.map((d) => d.name));
  const otherPool = pool.filter((d) => !prefNames.has(d.name));

  return {
    pool,
    relaxed,
    reason,
    groups: {
      total: pool.length,
      favorites: favoritePool.length,
      mainstream: pool.filter((d) => d.star === 5).length,
      preferred: preferredPool.length,
      others: otherPool.length,
      favoritePool,
      preferredPool,
      otherPool,
    },
  };
}

/**
 * 单条菜的权重（**只在候选组内部生效**）。
 *
 * 收藏菜的基准权重会被抬到和五星国民菜同一档再乘 favBoost：
 * 否则「收藏一道冷门菜」的权重只有启发式的 4 分，乘 5 也才 20，
 * 反倒比同组里每道权重 120 的国民菜低 —— 收藏了反而更难出现，那就本末倒置了。
 * 于是 favBoost=1 表示「和国民菜一样常出」，5 表示「比每道国民菜多 5 倍」。
 *
 */
export function weightOf(d, opt) {
  let w = typeof d.weight === "number" && d.weight > 0 ? d.weight : 1;

  // 场景偏好：自己做时更偏向家里能做的，点外卖时更偏向店里才有的
  if (opt.scene === "cook") {
    if (d.scene === "home") w *= 2;
  } else if (d.scene === "takeout") {
    w *= 2;
  }

  // 城市偏好：命中当地菜系就加权
  if (opt.region !== "" && d.cuisine === opt.region) w *= 2.5;

  // 餐次偏好：打标命中的加权；打标但都不是这一餐的降权；
  // 没打标的轻降（不确定 ≠ 不合适，所以只压一点，不排除）。
  if (opt.mealNow !== "" && Array.isArray(d.meals)) {
    if (d.meals.length === 0) w *= MEAL_NEUTRAL;
    else w *= d.meals.indexOf(opt.mealNow) >= 0 ? MEAL_BOOST : MEAL_MISMATCH;
  }

  // 收藏加权
  if (opt.favoriteSet.has(d.name)) {
    w = Math.max(w, FAVORITE_BASE_WEIGHT) * opt.favBoost;
  }

  const idx = opt.recent.indexOf(d.name);
  if (idx >= 0) {
    // 越近推过降得越狠（最新一条降到 5%）
    const n = opt.recent.length;
    const freshness = n === 0 ? 0 : (idx + 1) / n;
    w *= Math.max(0.05, 1 - freshness * 1.05);
  }
  return w;
}

function weightedPick(items, opt, rand) {
  if (items.length === 0) return null;
  let total = 0;
  const weights = items.map((d) => {
    const w = weightOf(d, opt);
    total += w;
    return w;
  });
  if (total <= 0) return items[0];
  let r = rand() * total;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 保底名额：**只从五星主流菜里挑**。
 *
 * 这里是硬保证，所以不能像早先那样把「当餐菜」「收藏菜」也算进来 ——
 * 那样实测前两道只有 85% 是主流菜，等于没保底。
 * 池子里一道五星都没有时（比如筛了个只有冷门菜的菜系）才退回整池，
 * 免得直接返回 null。
 */
function pickMainstream(pool, opt, rand) {
  if (pool.length === 0) return null;
  const main = pool.filter((d) => d.star === 5);
  return weightedPick(main.length > 0 ? main : pool, opt, rand);
}

/**
 * 挑一道菜。单道永远走保底那条路 —— 只给一道时当然给熟悉的国民菜。
 */
export function pickDish(dishes, opt, rand = Math.random) {
  const { pool } = resolvePool(dishes, opt);
  return pickMainstream(pool, opt, rand);
}

/**
 * 一次抽多道不重复的菜（换一批用）。
 *
 * 规则：**前 mainstreamCount 道必定是五星主流菜**，之后的名额按原本的权重随机
 * （主流菜权重 120、冷门菜 1~6，所以那一道多数时候还是主流菜，偶尔给你个冷门的）。
 *
 * @returns {{items: Array, relaxed: boolean, reason: string, poolSize: number, groups: object}}
 */
export function pickMany(dishes, opt, count = 3, rand = Math.random) {
  const { pool, relaxed, reason, groups } = resolvePool(dishes, opt);
  const out = [];
  const used = new Set();
  const guaranteed = Math.min(opt.mainstreamCount, count);
  for (let i = 0; i < count; i += 1) {
    const sub = pool.filter((d) => !used.has(d.name));
    if (sub.length === 0) break;
    const pick = i < guaranteed
      ? pickMainstream(sub, opt, rand)
      : weightedPick(sub, opt, rand);
    if (pick === null) break;
    used.add(pick.name);
    out.push(pick);
  }
  return {
    items: out,
    relaxed,
    reason,
    poolSize: pool.length,
    groups: {
      total: groups.total,
      favorites: groups.favorites,
      mainstream: groups.mainstream,
      preferred: groups.preferred,
      others: groups.others,
    },
  };
}

/**
 * 交给模型估热量用的提示词。
 *
 * 和「写做法」是平行的两条路：插件本身**不存任何营养数据**
 * （那是第三方数据库的受版权保护内容），需要热量时由 AI 现算，
 * 想不想花这个 token 由你决定。
 */
export function buildNutritionPrompt(name) {
  return `「${name}」的热量：每 100 克大约多少千卡？蛋白质、脂肪、碳水各多少克？一份通常是多少克？直接列数字，不要客套话。`;
}

/** 下厨房搜索链接（拼 URL，零成本、不会失效） */
export function recipeSearchUrl(name) {
  return "https://www.xiachufang.com/search/?keyword=" + encodeURIComponent(name);
}

/** 交给模型写做法用的提示词（刻意写短，省 token） */
export function buildRecipePrompt(name, scene = "cook") {
  if (scene === "takeout") {
    return `「${name}」这道菜是怎么做的？给我家常做法：需要的主要食材、简要步骤、大概耗时。直接给内容，不要客套话。`;
  }
  return `「${name}」怎么做？给我家常做法：主要食材（含大概用量）、简要步骤、大概耗时。直接给内容，不要客套话。`;
}

/** 供调试/自检用：返回统计信息 */
export function describePool(dishes, opt) {
  const { pool, relaxed, groups } = resolvePool(dishes, opt);
  const byCuisine = {};
  for (const d of pool) byCuisine[d.cuisine] = (byCuisine[d.cuisine] || 0) + 1;
  return {
    total: dishes.length,
    candidates: pool.length,
    relaxed,
    region: opt.region,
    scene: opt.scene,
    foreign: opt.foreign,
    favorites: groups.favorites,
    mainstream: groups.mainstream,
    mainstreamCount: opt.mainstreamCount,
    favOnly: opt.favOnly,
    cuisines: byCuisine,
  };
}

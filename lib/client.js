/**
 * dsh-meal-picker 客户端侧（浏览器 bundle）。
 *
 * 只注册一个插槽：shell.overlay —— 里面渲染
 *   1. 一个可拖动的悬浮气泡（🍚），位置记在 localStorage
 *   2. 点开后弹出的候选面板
 * 这样完全不动对话输入框，也不受任何容器的 overflow 裁切。
 *
 * 所有推荐都由宿主侧算好，客户端只负责显示 —— 点气泡 0 token。
 */
window.__ModuleLoader__.load({
  id: "dsh-meal-picker",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const API = "/dsh-meal";
    const POS_KEY = "dsh-meal-picker:bubble";
    const DEFAULT_BUBBLE = 72;  // 气泡直径默认值；可由配置 bubbleSize 覆盖（40~140）
    const PANEL_W = 460;
    const EDGE = 12;            // 离屏幕边缘的最小距离
    const ICON_INSET = 6;       // 图标比气泡小多少（留出圆形边框）

    const CSS = `
.mp-bubble {
  position: fixed; z-index: 10000;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-elevated, #ffffff);
  border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee);
  box-shadow: 0 6px 20px rgba(18, 22, 45, 0.18);
  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  font-size: 23px; line-height: 1; padding: 0;
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
}
.mp-bubble:hover { transform: scale(1.06); box-shadow: 0 10px 26px rgba(18, 22, 45, 0.24); }
.mp-bubble-icon {
  display: block;   /* 宽高由内联样式按 bubbleSize 算，别在这里写死 */
  pointer-events: none;   /* 拖动交给按钮本身 */
  -webkit-user-drag: none;
  /* 静态图也让它有点呼吸感 */
  animation: mp-bob 3.4s ease-in-out infinite;
}
@keyframes mp-bob {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-1.5px) scale(1.03); }
}
@media (prefers-reduced-motion: reduce) {
  .mp-bubble-icon { animation: none; }
}
.mp-bubble[data-drag="1"] { cursor: grabbing; transform: scale(1.04); }
.mp-bubble[data-open="1"] { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.mp-bubble:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 3px; }
.mp-fav-badge {
  position: absolute; top: -2px; right: -2px;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: #f0a020; color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid var(--dsw-alias-bg-elevated, #fff);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
}

.mp-mask { position: fixed; inset: 0; z-index: 9998; }
.mp-panel {
  position: fixed; z-index: 9999;
  width: 460px; max-width: calc(100vw - 24px);
  max-height: min(72vh, 640px); overflow: auto;
  background: var(--dsw-alias-bg-elevated, #ffffff);
  border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(18, 22, 45, 0.2);
  font-family: var(--dsw-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif);
  color: var(--dsw-alias-text-primary, #1b1f2a);
  padding: 12px;
}
.mp-meal-chip {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
  background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff;
}
/* 已保存的忌口：小标签 + 单独的删除按钮 */
.mp-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
.mp-chip {
  display: inline-flex; align-items: center;
  font-size: 12px; padding: 2px 3px 2px 9px; border-radius: 999px;
  background: var(--dsw-alias-bg-secondary, #f2f4f9);
  border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee);
  color: var(--dsw-alias-text-secondary, #5a6376);
}
.mp-chip-x {
  border: none; background: transparent; cursor: pointer; font-family: inherit;
  font-size: 14px; line-height: 1; padding: 0 4px; margin-left: 2px;
  color: var(--dsw-alias-text-tertiary, #8b93a7); border-radius: 999px;
}
.mp-chip-x:hover { color: #d9534f; background: rgba(217, 83, 79, 0.14); }
/* 「筛选条件」按钮：黑框描边，和普通按钮区分开 */
.mp-filter-btn {
  border: 1.5px solid var(--dsw-alias-text-primary, #1b1f2a);
  background: transparent; color: var(--dsw-alias-text-primary, #1b1f2a);
  border-radius: 8px; padding: 3px 10px; font-size: 12px;
  font-family: inherit; cursor: pointer; white-space: nowrap;
}
.mp-filter-btn:hover { background: var(--dsw-alias-bg-secondary, #f2f4f9); }
.mp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mp-title { font-size: 14px; font-weight: 700; flex: 1; }
.mp-sub { font-size: 11px; color: var(--dsw-alias-text-tertiary, #8b93a7); }
.mp-x {
  border: none; background: transparent; cursor: pointer; font-size: 16px;
  color: var(--dsw-alias-text-tertiary, #8b93a7); line-height: 1; padding: 2px 6px; border-radius: 6px;
}
.mp-x:hover { background: var(--dsw-alias-bg-secondary, #f2f4f9); }

.mp-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mp-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee); border-radius: 8px; overflow: hidden; }
.mp-seg > button {
  border: none; background: transparent; cursor: pointer; padding: 5px 10px; font-size: 12px;
  color: var(--dsw-alias-text-secondary, #5a6376); font-family: inherit;
}
.mp-seg > button + button { border-left: 1px solid var(--dsw-alias-border-secondary, #e3e6ee); }
.mp-seg > button[data-on="1"] { background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; }

.mp-field { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.mp-field > label { font-size: 12px; color: var(--dsw-alias-text-tertiary, #8b93a7); min-width: 52px; }
.mp-input, .mp-select {
  flex: 1; height: 28px; padding: 0 8px; font-size: 12px; font-family: inherit;
  border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee); border-radius: 8px;
  background: var(--dsw-alias-bg-primary, #fff); color: inherit; min-width: 0;
}
.mp-toggle-filters {
  border: none; background: transparent; cursor: pointer; font-size: 12px; padding: 2px 0;
  color: var(--dsw-alias-brand-primary, #4d6bfe); font-family: inherit;
}
.mp-filters { border-bottom: 1px dashed var(--dsw-alias-border-secondary, #e3e6ee); padding-bottom: 10px; margin: 6px 0 10px; }

.mp-item { border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee); border-radius: 10px; padding: 9px 10px; margin-bottom: 7px; }
.mp-item-top { display: flex; align-items: baseline; gap: 7px; }
.mp-name { font-size: 14px; font-weight: 600; }
.mp-star { font-size: 11px; color: #f0a020; }
.mp-tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-bg-secondary, #f2f4f9); color: var(--dsw-alias-text-tertiary, #8b93a7); }
.mp-macros { font-size: 11px; color: var(--dsw-alias-text-tertiary, #8b93a7); margin-top: 3px; }
.mp-answer {
  margin-top: 9px; padding-top: 8px;
  border-top: 1px dashed var(--dsw-alias-border-secondary, #e3e6ee);
}
.mp-answer-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.mp-answer-head > .mp-sub { flex: 1; }
.mp-answer-text {
  font-size: 12.5px; line-height: 1.62; white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-text-primary, #1b1f2a);
}
.mp-acts { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
.mp-act {
  border: 1px solid var(--dsw-alias-border-secondary, #e3e6ee); background: transparent;
  border-radius: 7px; padding: 4px 9px; font-size: 12px; cursor: pointer; font-family: inherit;
  color: var(--dsw-alias-text-secondary, #5a6376); text-decoration: none; display: inline-block;
}
.mp-act:hover { background: var(--dsw-alias-bg-secondary, #f2f4f9); color: var(--dsw-alias-text-primary, #1b1f2a); }
.mp-act[data-primary="1"] { border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.mp-fav {
  border: none; background: transparent; cursor: pointer; font-size: 17px; line-height: 1;
  padding: 2px 4px; border-radius: 6px; color: #c8cedb;
}
.mp-fav[data-on="1"] { color: #f0a020; }
.mp-fav:hover { background: var(--dsw-alias-bg-secondary, #f2f4f9); }
.mp-foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.mp-note { font-size: 11px; color: var(--dsw-alias-text-tertiary, #8b93a7); flex: 1; min-width: 140px; }
.mp-err { font-size: 12px; color: #d9534f; padding: 8px 2px; }
.mp-empty { font-size: 12px; color: var(--dsw-alias-text-tertiary, #8b93a7); padding: 10px 2px; }
.mp-warn { font-size: 11px; color: #d98324; padding: 4px 2px; }
.mp-spin {
  display: inline-block; width: 11px; height: 11px; margin-right: 6px; vertical-align: -1px;
  border: 2px solid #c9d2ea; border-top-color: #4d6bfe; border-radius: 50%;
  animation: mp-spin .8s linear infinite;
}
@keyframes mp-spin { to { transform: rotate(360deg); } }
`;

    if (typeof document !== "undefined") {
      const tagId = "dsh-meal-picker/styles";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dsh-meal-picker");
        tag.setAttribute("data-plugin-css", tagId);
        tag.textContent = CSS;
        document.head.append(tag);
      }
    }

    // ---------------------------------------------------------------- store

    const store = {
      open: false,
      mode: "picks",         // "picks" 推荐面板 / "filters" 筛选条件面板
      dirty: false,          // 改过筛选条件但还没重新挑菜
      loading: false,
      error: "",
      empty: false,
      hint: "",
      relax: "",
      items: [],
      pool: 0,
      region: "",
      mainstreamCount: 2,
      groupInfo: null,
      favorites: [],
      favItems: [],          // 收藏菜的详细信息（名字/菜系/做法/餐次），供收藏面板展示
      favPersisted: true,
      avoidPersisted: true,  // 忌口是否成功写盘
      avoidSavedValue: "",   // 上次保存成功的忌口，用来判断有没有真的改动
      opts: { scene: "cook", foreign: "any", city: "", cuisine: "", method: "", meal: "auto", avoid: "", favOnly: false, favBoost: 5 },
      meta: null,
      mealNow: "",           // 当前生效的餐次（auto 时由时间推出）
      mealLabel: {},         // 餐次 -> 中文名，由宿主给出
      toast: "",
      answers: {},           // 菜名 -> { kind, loading, text, error }，AI 出做法/热量的结果
      bubble: null,          // {x, y}
    };
    const listeners = new Set();
    let pluginCtx = null;

    // useSyncExternalStore 用 Object.is 比对快照来决定要不要重渲染。
    // 若 snapshot() 始终返回同一个可变对象，原地改完引用没变，React 就认为
    // 「没有变化」而永不重渲染 —— 面板打不开、拖动发涩都是这么来的。
    // 所以每次 set 换一个新的浅拷贝，snapshot() 只返回缓存的那一份。
    let snap = { ...store };

    function set(patch) {
      Object.assign(store, patch);
      snap = { ...store };
      for (const l of listeners) l();
    }
    function subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    }
    function snapshot() {
      return snap;
    }
    function useStore() {
      return React.useSyncExternalStore(subscribe, snapshot, snapshot);
    }

    // ---------------------------------------------------------------- 气泡位置

    function loadPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (raw === null) return null;
        const p = JSON.parse(raw);
        if (p !== null && typeof p === "object"
            && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          return { x: p.x, y: p.y };
        }
      } catch (e) {
        /* 读不到就用默认位置 */
      }
      return null;
    }

    function savePos(p) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(p));
      } catch (e) {
        /* 存不进去也无所谓，只是下次回到默认位置 */
      }
    }

    /**
     * 气泡直径。默认 72，可由插件配置 bubbleSize 覆盖（夹到 40~140）。
     * meta 还没加载时先用默认值，加载完会自动按配置重画。
     */
    function bubbleSize() {
      const meta = store.meta;
      const cfg = meta !== null && meta !== undefined ? meta.config : null;
      const n = cfg !== null && cfg !== undefined ? Number(cfg.bubbleSize) : NaN;
      if (!Number.isFinite(n)) return DEFAULT_BUBBLE;
      return Math.min(140, Math.max(40, Math.round(n)));
    }

    function defaultPos(size) {
      const s = Number.isFinite(size) ? size : bubbleSize();
      const w = (typeof window !== "undefined" && window.innerWidth) || 1200;
      const h = (typeof window !== "undefined" && window.innerHeight) || 800;
      return { x: w - s - 24, y: h - s - 90 };
    }

    function clampPos(p, size) {
      const s = Number.isFinite(size) ? size : bubbleSize();
      const w = (typeof window !== "undefined" && window.innerWidth) || 1200;
      const h = (typeof window !== "undefined" && window.innerHeight) || 800;
      return {
        x: Math.min(Math.max(EDGE, p.x), Math.max(EDGE, w - s - EDGE)),
        y: Math.min(Math.max(EDGE, p.y), Math.max(EDGE, h - s - EDGE)),
      };
    }

    // ---------------------------------------------------------------- 通信

    function apiUrl(path, params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === "" || v === false) continue;
        qs.set(k, typeof v === "boolean" ? "1" : String(v));
      }
      const q = qs.toString();
      return API + path + (q === "" ? "" : "?" + q);
    }

    async function fetchJson(url, init) {
      const res = await fetch(url, init);
      const data = await res.json();
      if (data === null || typeof data !== "object") throw new Error("响应格式异常");
      if (data.ok !== true) throw new Error(data.error || "请求失败");
      return data;
    }

    /**
     * 尝试把一段文字直接送进对话输入框。
     *
     * DSH 把输入框封在会话作用域里（监听器注册在 sessions().scope(id) 上，
     * 源码注释写明这类接口 "never across a plugin boundary"），事件只向祖先
     * 冒泡，插件从自己的 ctx 送不到。所以这里只是「试一下」：
     * 只有真的被处理（bail 返回 true）才算成功，否则一律返回 false 交给上层
     * 回退到剪贴板 —— 绝不能因为「方法存在」就谎报成功。
     */
    function insertIntoComposer(text) {
      const ctx = pluginCtx;
      if (ctx === null || typeof ctx.bail !== "function") return false;
      try {
        return ctx.bail("slash/input-insert-text", { text }) === true;
      } catch (e) {
        return false;
      }
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) {
        /* 落到下面的兜底 */
      }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }

    function flashToast(text) {
      set({ toast: text });
      setTimeout(() => {
        if (store.toast === text) set({ toast: "" });
      }, 2800);
    }

    // ---------------------------------------------------------------- 数据

    async function loadMeta() {
      try {
        const data = await fetchJson(API + "/meta");
        set({
          meta: data,
          favorites: Array.isArray(data.favorites) ? data.favorites : [],
          favPersisted: data.favoritesPersisted !== false,
          mainstreamCount: typeof data.config.mainstreamCount === "number"
            ? data.config.mainstreamCount : 2,
          mealNow: typeof data.mealNow === "string" ? data.mealNow : "",
          mealLabel: data.mealLabel !== null && typeof data.mealLabel === "object" ? data.mealLabel : {},
          opts: {
            scene: data.config.scene,
            foreign: data.config.foreign,
            city: data.config.city,
            cuisine: "",
            method: "",
            meal: typeof data.config.meal === "string" ? data.config.meal : "auto",
            avoid: Array.isArray(data.avoid) ? data.avoid.join(",") : data.config.avoid,
            favOnly: false,
            favBoost: data.config.favBoost,
          },
          avoidPersisted: data.prefsPersisted !== false,
          avoidSavedValue: Array.isArray(data.avoid) ? data.avoid.join(",") : "",
        });
      } catch (e) {
        /* meta 失败不阻塞抽菜 */
      }
    }

    async function recommend() {
      set({ loading: true, error: "", empty: false, relax: "" });
      try {
        const s = store;
        const data = await fetchJson(apiUrl("/recommend", {
          ...s.opts,
          favOnly: s.opts.favOnly ? "1" : "",
          fav: s.favorites.join(","),
          // 把自己的本地小时送过去：餐次按使用者的时间判断，而不是宿主的
          hour: String(new Date().getHours()),
        }));
        set({
          loading: false,
          dirty: false,
          items: data.items || [],
          empty: data.empty === true,
          hint: data.hint || "",
          relax: data.relaxed === true ? (data.relaxReason || "条件已放宽") : "",
          pool: data.pool || 0,
          region: data.region || "",
          groupInfo: data.groups || null,
          mealNow: typeof data.mealNow === "string" ? data.mealNow : store.mealNow,
          mainstreamCount: typeof data.mainstreamCount === "number"
            ? data.mainstreamCount : store.mainstreamCount,
        });
      } catch (e) {
        set({ loading: false, error: String(e && e.message ? e.message : e) });
      }
    }

    // ---- AI 出做法 / 估热量：交给主机端调 llm 服务，结果就地显示在面板里 ----

    function setAnswer(name, value) {
      set({ answers: { ...store.answers, [name]: value } });
    }

    function clearAnswer(name) {
      const next = { ...store.answers };
      delete next[name];
      set({ answers: next });
    }

    async function askHost(kind, name) {
      const cur = store.answers[name];
      if (cur !== undefined && cur.loading === true) return;   // 正在跑就别重复发
      setAnswer(name, { kind, loading: true, text: "", error: "" });
      try {
        const data = await fetchJson(API + "/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, name }),
        });
        setAnswer(name, { kind, loading: false, text: String(data.text || ""), error: "" });
      } catch (e) {
        setAnswer(name, { kind, loading: false, text: "", error: String(e && e.message ? e.message : e) });
      }
    }

    /** 读收藏（带每道菜的信息），收藏面板用 */
    async function loadFavorites() {
      try {
        const data = await fetchJson(API + "/favorites");
        set({
          favorites: Array.isArray(data.favorites) ? data.favorites : [],
          favItems: Array.isArray(data.items) ? data.items : [],
          favPersisted: data.persisted !== false,
        });
      } catch (e) {
        flashToast("读收藏失败：" + String(e && e.message ? e.message : e));
      }
    }

    /**
     * 忌口：改完立刻落盘（宿主持久化），重启后还在。
     * 与上次保存的值相同就直接返回 —— blur 在点别处时也会触发，
     * 不做这个判断会反复写盘并刷提示。
     */
    async function saveAvoid(text) {
      const raw = String(text === undefined || text === null ? "" : text);
      const normalized = raw.split(/[,，、;；\s]+/).filter((s) => s !== "").join(",");
      set({ opts: { ...store.opts, avoid: normalized }, dirty: true });
      if (normalized === store.avoidSavedValue) return;
      try {
        const data = await fetchJson(API + "/prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avoid: normalized }),
        });
        const saved = Array.isArray(data.avoid) ? data.avoid.join(",") : normalized;
        set({
          opts: { ...store.opts, avoid: saved },
          avoidSavedValue: saved,
          avoidPersisted: data.persisted !== false,
        });
        if (data.persisted === false) {
          flashToast("忌口没能写进磁盘，重启后会丢");
        } else {
          flashToast(saved === "" ? "忌口已清空" : "忌口已永久保留：" + saved);
        }
      } catch (e) {
        set({ avoidPersisted: false });
        flashToast("忌口保存失败：" + String(e && e.message ? e.message : e));
      }
    }

    async function toggleFavorite(name) {
      try {
        const data = await fetchJson(API + "/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "toggle", name }),
        });
        set({
          favorites: Array.isArray(data.favorites) ? data.favorites : [],
          // 收藏面板开着时立刻重新拉一遍，取消收藏后列表马上少一行
          favItems: store.mode === "favorites"
            ? store.favItems
            : store.favItems.filter((x) => x.name !== name),
          favPersisted: data.persisted !== false,
        });
        if (store.mode === "favorites") await loadFavorites();
        if (data.persisted === false) {
          flashToast("收藏已生效，但写不进磁盘，重启后会丢");
        }
      } catch (e) {
        flashToast("收藏失败：" + String(e && e.message ? e.message : e));
      }
    }

    async function clearRecent() {
      try {
        await fetchJson(API + "/recent", { method: "POST" });
        flashToast("已清空「最近推过」的记录");
        recommend();
      } catch (e) {
        flashToast("清空失败：" + String(e && e.message ? e.message : e));
      }
    }

    /**
     * 打开面板。mode: "picks" 推荐 / "filters" 筛选条件。
     * 切到推荐时才请求（改条件只标脏），避免筛选时白白发请求。
     */
    function openPanel(mode, rect) {
      const m = mode === "filters" ? "filters" : (mode === "favorites" ? "favorites" : "picks");
      set({ open: true, mode: m, bubbleRect: rect || null });
      if (store.meta === null) loadMeta();
      if (m === "picks" && (store.dirty || store.items.length === 0 || store.error !== "")) {
        recommend();
      }
      if (m === "favorites") loadFavorites();
    }

    /**
     * 由气泡坐标推出它的矩形。
     *
     * 面板靠这个矩形决定贴在哪，所以拖动时也要跟着更新 —— 之前只在点击那一刻
     * 记一次 DOM 矩形，面板就会留在原地不跟手。
     */
    function rectOf(pos, size) {
      const s = Number.isFinite(size) ? size : bubbleSize();
      return {
        left: pos.x, top: pos.y,
        right: pos.x + s, bottom: pos.y + s,
        width: s, height: s,
      };
    }

    // ---------------------------------------------------------------- 组件

    function Bubble() {
      const s = useStore();
      const [drag, setDrag] = React.useState(null);
      // 拖动过程中的位置只放在本地 state 里，不写 store：
      // 这样每次移动只重渲染气泡自己，不连累面板，拖动才跟手。
      const [dragPos, setDragPos] = React.useState(null);
      const [iconOk, setIconOk] = React.useState(true);
      const posRef = React.useRef(null);

      const pos = dragPos !== null ? dragPos : clampPos(s.bubble === null ? defaultPos() : s.bubble);
      posRef.current = pos;

      React.useEffect(() => {
        const saved = loadPos();
        if (saved !== null) set({ bubble: clampPos(saved) });
        const onResize = () => {
          const next = clampPos(posRef.current);
          // 面板开着时窗口尺寸变了，面板也要跟着重新贴位
          set(store.open ? { bubble: next, bubbleRect: rectOf(next) } : { bubble: next });
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
        // 只在挂载时做一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const onPointerDown = (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;   // 右键走 contextmenu
        e.preventDefault();
        setDrag({
          id: e.pointerId,
          sx: e.clientX, sy: e.clientY,
          ox: pos.x, oy: pos.y,
          moved: false,
        });
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch (err) { /* 忽略 */ }
      };

      const onPointerMove = (e) => {
        if (drag === null || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        // 4px 以内当作点击抖动，不算拖动
        if (!drag.moved && Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;
        const next = clampPos({ x: drag.ox + dx, y: drag.oy + dy });
        posRef.current = next;
        setDragPos(next);
        // 面板开着时必须同步写 store，否则它停在原处不跟手；
        // 面板关着时只走本地 state，拖动更顺。
        if (s.open) set({ bubble: next, bubbleRect: rectOf(next) });
        if (!drag.moved) setDrag({ ...drag, moved: true });
      };

      const onPointerUp = (e) => {
        if (drag === null || drag.id !== e.pointerId) return;
        const wasMove = drag.moved;
        const finalPos = posRef.current;
        setDrag(null);
        setDragPos(null);
        if (wasMove) {
          // 拖动结束才落一次 store 与 localStorage
          set({ bubble: finalPos });
          savePos(finalPos);
          return;
        }
        // 没拖动 = 左键点击：切到推荐面板；已经在推荐面板上就关掉
        if (s.open && s.mode === "picks") set({ open: false });
        else openPanel("picks", rectOf(pos));
      };

      const onContextMenu = (e) => {
        e.preventDefault();
        // 右键：切到筛选条件面板；已经在筛选面板上就关掉
        if (s.open && s.mode === "filters") set({ open: false });
        else openPanel("filters", rectOf(pos));
      };

      const onKeyDown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (s.open && s.mode === "picks") set({ open: false });
          else openPanel("picks", rectOf(pos));
        }
        if (e.key === "Escape") set({ open: false });
      };

      const favCount = s.favorites.length;
      // 尺寸可配置：气泡与图标都由 size 推导，别在 CSS 里写死
      const size = bubbleSize();
      const iconPx = Math.max(24, size - ICON_INSET);
      return React.createElement("button", {
        type: "button",
        className: "mp-bubble",
        "data-open": s.open ? "1" : "0",
        "data-drag": drag !== null && drag.moved ? "1" : "0",
        style: {
          left: pos.x + "px", top: pos.y + "px",
          width: size + "px", height: size + "px",
          fontSize: Math.round(size * 0.46) + "px",   // 退回 emoji 时也按尺寸放大
        },
        title: "今天吃什么（左键推荐，右键改筛选条件，可拖动）",
        "aria-label": "今天吃什么",
        onPointerDown, onPointerMove, onPointerUp,
        onPointerCancel: () => { setDrag(null); setDragPos(null); },
        onContextMenu, onKeyDown,
      },
        // 图标由宿主侧提供；拿不到就退回 emoji，气泡不会变成空白
        iconOk
          ? React.createElement("img", {
              className: "mp-bubble-icon",
              src: API + "/icon.png",
              alt: "",
              draggable: false,
              style: { width: iconPx + "px", height: iconPx + "px" },
              onError: () => setIconOk(false),
            })
          : "🍚",
        favCount > 0 ? React.createElement("span", { className: "mp-fav-badge" }, String(favCount)) : null,
      );
    }

    function Segmented(props) {
      return React.createElement("span", { className: "mp-seg" },
        props.options.map((o) => React.createElement("button", {
          key: String(o.value),
          type: "button",
          "data-on": props.value === o.value ? "1" : "0",
          onClick: () => props.onChange(o.value),
        }, o.label)),
      );
    }

    function Item(props) {
      const d = props.dish;
      const s = useStore();
      const ans = s.answers[d.name];      // { kind, loading, text, error } 或 undefined
      const isFav = s.favorites.includes(d.name);
      const loading = ans !== undefined && ans.loading === true;

      return React.createElement("div", { className: "mp-item" },
        React.createElement("div", { className: "mp-item-top" },
          React.createElement("button", {
            type: "button",
            className: "mp-fav",
            "data-on": isFav ? "1" : "0",
            title: isFav ? "取消收藏" : "收藏（收藏后出现概率会提高）",
            onClick: () => toggleFavorite(d.name),
          }, isFav ? "★" : "☆"),
          React.createElement("span", { className: "mp-name" }, d.name),
          d.star === 5
            ? React.createElement("span", { className: "mp-star", title: "常见主流菜" }, "主流")
            : null,
          React.createElement("span", { className: "mp-tag" }, d.cuisine),
          Array.isArray(d.methods) && d.methods.length > 0
            ? React.createElement("span", {
                className: "mp-tag", title: "菜名里写明的做法",
              }, d.methods.join("·"))
            : null,
          Array.isArray(d.meals) && d.meals.length > 0
            ? React.createElement("span", {
                className: "mp-tag",
                title: "适合哪一餐（按菜名和做法推的）",
              }, d.meals.map((m) => {
                const lbl = s.mealLabel !== null && typeof s.mealLabel === "object" ? s.mealLabel[m] : "";
                return lbl || m;
              }).join("·"))
            : null,
          React.createElement("span", { className: "mp-tag" },
            d.scene === "takeout" ? "偏外卖" : (d.scene === "home" ? "适合自己做" : "都行")),
        ),
        React.createElement("div", { className: "mp-acts" },
          React.createElement("button", {
            type: "button", className: "mp-act", "data-primary": "1",
            disabled: loading,
            title: "让大肥鱼点评这道菜（会花一点 token）",
            onClick: () => askHost("review", d.name),
          }, "🐳 大肥鱼评价"),
          React.createElement("button", {
            type: "button", className: "mp-act",
            title: "换一批同菜系的菜",
            onClick: () => {
              set({ opts: { ...store.opts, cuisine: d.cuisine }, dirty: true });
              recommend();
            },
          }, "多来点" + d.cuisine),
          React.createElement("button", {
            type: "button", className: "mp-act",
            disabled: loading,
            title: "让 AI 直接写出做法，结果显示在下面（会花 token）",
            onClick: () => askHost("recipe", d.name),
          }, "AI 写做法"),
          React.createElement("button", {
            type: "button", className: "mp-act",
            disabled: loading,
            title: "插件不存热量数据，需要时让 AI 现算（会花 token）",
            onClick: () => askHost("nutrition", d.name),
          }, "AI 估热量"),
          React.createElement("a", {
            className: "mp-act", href: d.recipeUrl, target: "_blank", rel: "noreferrer",
            onClick: () => set({ open: false }),
          }, "搜食谱"),
        ),
        React.createElement(AnswerBlock, { name: d.name }),
      );
    }

    /**
     * 一道菜的 AI 结果块（做法 / 热量 / 肥鱼评价）。
     * 推荐面板和收藏面板都用它，省得两处各写一遍。
     */
    function AnswerBlock(props) {
      const s = useStore();
      const ans = s.answers[props.name];
      if (ans === undefined) return null;
      if (ans.loading === true) {
        return React.createElement("div", { className: "mp-answer" },
          React.createElement("div", { className: "mp-empty" },
            React.createElement("span", { className: "mp-spin" }), "正在问 AI，稍等…"));
      }
      if (ans.error !== "") {
        return React.createElement("div", { className: "mp-answer" },
          React.createElement("div", { className: "mp-err" }, "问 AI 失败：" + ans.error));
      }
      const label = ans.kind === "nutrition"
        ? "AI 估算的热量（仅供参考，非精确值）"
        : (ans.kind === "review" ? "大肥鱼这么说 🐳" : "AI 给的做法");
      return React.createElement("div", { className: "mp-answer" },
        React.createElement("div", { className: "mp-answer-head" },
          React.createElement("span", { className: "mp-sub" }, label),
          React.createElement("button", {
            type: "button", className: "mp-act",
            onClick: async () => {
              if (await copyText(ans.text)) flashToast("已复制到剪贴板");
              else flashToast("复制失败，请手动选中复制");
            },
          }, "复制"),
          React.createElement("button", {
            type: "button", className: "mp-act",
            onClick: () => clearAnswer(props.name),
          }, "收起"),
        ),
        React.createElement("div", { className: "mp-answer-text" }, ans.text),
      );
    }

    /** 面板贴着气泡放，靠近屏幕下半部分就向上展开 */
    function panelStyle(s) {
      const rect = s.bubbleRect;
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1200;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
      if (rect !== null && rect !== undefined) {
        const left = Math.max(EDGE, Math.min(rect.right - PANEL_W, vw - PANEL_W - EDGE));
        return rect.top > vh * 0.5
          ? { left: left + "px", bottom: (vh - rect.top + 10) + "px" }
          : { left: left + "px", top: (rect.bottom + 10) + "px" };
      }
      return { left: "50%", top: "16%", transform: "translateX(-50%)" };
    }

    /**
     * 筛选条件面板。
     *
     * 所有条件都搬到这里，**不放任何菜品推荐** —— 推荐是左键气泡的事。
     * 改条件只标脏（dirty），不立刻请求；点「看看推荐」才带着新条件下单。
     */
    function FiltersPanel() {
      const s = useStore();
      const meta = s.meta;
      const cuisines = meta && Array.isArray(meta.cuisines) ? meta.cuisines : [];
      const methods = meta && Array.isArray(meta.methods) ? meta.methods : [];
      const methodsTagged = meta && typeof meta.methodsTagged === "number" ? meta.methodsTagged : 0;
      const mealLabel = s.mealLabel !== null && typeof s.mealLabel === "object" ? s.mealLabel : {};

      const setOpt = (patch) => set({ opts: { ...store.opts, ...patch }, dirty: true });
      const autoOn = (s.opts.meal === undefined ? "auto" : s.opts.meal) === "auto";
      const nowLabel = mealLabel[s.mealNow] || s.mealNow || "";
      // 已保存的忌口（不是输入框里正在敲的那串），用来列成可删的小标签
      const avoidList = String(s.avoidSavedValue === undefined ? "" : s.avoidSavedValue)
        .split(",").filter((w) => w !== "");

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "mp-mask", onClick: () => set({ open: false }) }),
        React.createElement("div", { className: "mp-panel", style: panelStyle(s) },
          React.createElement("div", { className: "mp-head" },
            React.createElement("span", { className: "mp-title" }, "筛选条件"),
            React.createElement("span", { className: "mp-sub" }, "右击气泡也能直接打开"),
            React.createElement("button", {
              type: "button", className: "mp-x", title: "关闭",
              onClick: () => set({ open: false }),
            }, "✕"),
          ),

          React.createElement("div", { className: "mp-filters" },
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "这一餐"),
              React.createElement(Segmented, {
                value: s.opts.meal === undefined ? "auto" : s.opts.meal,
                options: [
                  { value: "auto", label: "自动" },
                  { value: "breakfast", label: "早餐" },
                  { value: "lunch", label: "午餐" },
                  { value: "dinner", label: "晚餐" },
                  { value: "lateNight", label: "夜宵" },
                  { value: "any", label: "不限" },
                ],
                onChange: (v) => setOpt({ meal: v }),
              }),
              autoOn && nowLabel !== ""
                ? React.createElement("span", { className: "mp-sub" }, "现在按「" + nowLabel + "」挑")
                : null,
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "做法"),
              React.createElement(Segmented, {
                value: s.opts.scene,
                options: [
                  { value: "cook", label: "🏠 自己做" },
                  { value: "takeout", label: "🛵 点外卖" },
                ],
                onChange: (v) => setOpt({ scene: v }),
              }),
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "口味"),
              React.createElement(Segmented, {
                value: s.opts.foreign,
                options: [
                  { value: "any", label: "都行" },
                  { value: "off", label: "只要中餐" },
                  { value: "only", label: "换口味" },
                ],
                onChange: (v) => setOpt({ foreign: v }),
              }),
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "主流保底"),
              React.createElement(Segmented, {
                value: String(s.opts.mainstreamCount === undefined ? s.mainstreamCount : s.opts.mainstreamCount),
                options: [
                  { value: "0", label: "不限" },
                  { value: "1", label: "前 1 道" },
                  { value: "2", label: "前 2 道" },
                  { value: "20", label: "全部" },
                ],
                onChange: (v) => setOpt({ mainstreamCount: Number(v) }),
              }),
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "收藏"),
              React.createElement(Segmented, {
                value: s.opts.favOnly ? "only" : "mix",
                options: [
                  { value: "mix", label: "混着出" },
                  { value: "only", label: "只出收藏" },
                ],
                onChange: (v) => setOpt({ favOnly: v === "only" }),
              }),
              s.opts.favOnly ? null : React.createElement("select", {
                className: "mp-select",
                style: { maxWidth: "130px" },
                value: String(s.opts.favBoost),
                onChange: (e) => setOpt({ favBoost: Number(e.target.value) }),
                title: "收藏菜相对「每道主流菜」的出现倍数",
              },
                React.createElement("option", { value: "1" }, "收藏不加权"),
                React.createElement("option", { value: "3" }, "收藏 ×3"),
                React.createElement("option", { value: "5" }, "收藏 ×5"),
                React.createElement("option", { value: "10" }, "收藏 ×10"),
                React.createElement("option", { value: "20" }, "收藏 ×20"),
              ),
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "城市"),
              React.createElement("input", {
                className: "mp-input", value: s.opts.city,
                placeholder: "填了会优先推当地菜，如：成都",
                onChange: (e) => set({ opts: { ...store.opts, city: e.target.value } }),
                onKeyDown: (e) => { if (e.key === "Enter") setOpt({ city: e.target.value }); },
                onBlur: (e) => setOpt({ city: e.target.value }),
              }),
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "菜系"),
              React.createElement("select", {
                className: "mp-select", value: s.opts.cuisine,
                onChange: (e) => setOpt({ cuisine: e.target.value }),
              },
                React.createElement("option", { value: "" }, "不限"),
                cuisines.map((c) => React.createElement("option", {
                  key: c.cuisine, value: c.cuisine,
                }, c.cuisine + "（" + c.count + "）")),
              ),
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "做法"),
              React.createElement("select", {
                className: "mp-select", value: s.opts.method || "",
                title: "按菜名里写明的做法筛；没写做法的菜不会被选中",
                onChange: (e) => setOpt({ method: e.target.value }),
              },
                React.createElement("option", { value: "" }, "不限"),
                methods.map((m) => React.createElement("option", {
                  key: m.method, value: m.method,
                }, m.method + "（" + m.count + "）")),
              ),
              methodsTagged > 0
                ? React.createElement("span", { className: "mp-sub" },
                    "共 " + methodsTagged + " 道标了做法")
                : null,
            ),
            React.createElement("div", { className: "mp-field" },
              React.createElement("label", null, "忌口"),
              React.createElement("input", {
                className: "mp-input", value: s.opts.avoid,
                placeholder: "逗号分隔，如：香菜,内脏（回车或点别处即永久保留）",
                onChange: (e) => set({ opts: { ...store.opts, avoid: e.target.value } }),
                onKeyDown: (e) => {
                  if (e.key === "Enter") { saveAvoid(e.target.value); e.target.blur(); }
                },
                onBlur: (e) => saveAvoid(e.target.value),
              }),
            ),
            // 已保存的忌口列出来，每条都能单独删——不必再去改输入框里的文字
            avoidList.length > 0
              ? React.createElement("div", { className: "mp-chips" },
                  avoidList.map((w) => React.createElement("span", {
                    className: "mp-chip", key: w,
                  },
                    w,
                    React.createElement("button", {
                      type: "button", className: "mp-chip-x",
                      title: "不再忌口「" + w + "」",
                      onClick: () => saveAvoid(avoidList.filter((x) => x !== w).join(",")),
                    }, "×"),
                  )),
                  avoidList.length > 1
                    ? React.createElement("button", {
                        type: "button", className: "mp-act",
                        onClick: () => saveAvoid(""),
                      }, "全部清空")
                    : null,
                )
              : null,
            s.avoidPersisted === false
              ? React.createElement("div", { className: "mp-warn" },
                  "⚠ 忌口没能写进磁盘（只在本进程内有效），重启后会丢")
              : null,
            s.favPersisted === false
              ? React.createElement("div", { className: "mp-warn" },
                  "⚠ 收藏只存在内存里（磁盘写不进去），重启 DSH 后会丢")
              : null,
          ),

          React.createElement("div", { className: "mp-foot" },
            React.createElement("button", {
              type: "button", className: "mp-act", "data-primary": "1",
              onClick: () => openPanel("picks", s.bubbleRect),
            }, "看看推荐"),
            React.createElement("span", { className: "mp-note" },
              s.toast !== "" ? s.toast : "选完点这里换到推荐；也可以直接左键气泡"),
          ),
        ),
      );
    }

    /**
     * 推荐面板：只有菜品，没有筛选条件。
     * 顶部的「筛选条件」按钮（黑框）切到筛选面板，右键气泡同样能到。
     */
    function PicksPanel() {
      const s = useStore();
      const mealLabel = s.mealLabel !== null && typeof s.mealLabel === "object" ? s.mealLabel : {};
      const nowLabel = mealLabel[s.mealNow] || s.mealNow || "";

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "mp-mask", onClick: () => set({ open: false }) }),
        React.createElement("div", { className: "mp-panel", style: panelStyle(s) },
          React.createElement("div", { className: "mp-head" },
            React.createElement("span", { className: "mp-title" }, "今天吃什么"),
            nowLabel !== ""
              ? React.createElement("span", {
                  className: "mp-meal-chip",
                  title: (s.opts.meal === undefined || s.opts.meal === "auto")
                    ? "按当前时间自动判断，可在筛选条件里改"
                    : "你在筛选条件里手动指定了这一餐",
                }, nowLabel)
              : null,
            React.createElement("button", {
              type: "button", className: "mp-filter-btn",
              title: "打开筛选条件（右键气泡同样可以）",
              onClick: () => openPanel("filters", s.bubbleRect),
            }, "筛选条件"),
            React.createElement("button", {
              type: "button", className: "mp-act",
              title: "看看收藏了哪些菜，也能取消收藏",
              onClick: () => openPanel("favorites", s.bubbleRect),
            }, s.favorites.length > 0 ? "★ " + s.favorites.length : "★ 收藏"),
            React.createElement("button", {
              type: "button", className: "mp-x", title: "关闭",
              onClick: () => set({ open: false }),
            }, "✕"),
          ),

          s.relax ? React.createElement("div", { className: "mp-warn" }, "· " + s.relax) : null,

          s.loading ? React.createElement("div", { className: "mp-empty" },
            React.createElement("span", { className: "mp-spin" }), "正在挑…") : null,
          s.error !== "" ? React.createElement("div", { className: "mp-err" }, "出错了：" + s.error) : null,
          s.empty ? React.createElement("div", { className: "mp-empty" }, s.hint || "没有符合条件的菜") : null,

          !s.loading && s.error === "" && !s.empty
            ? s.items.map((d) => React.createElement(Item, { key: d.name, dish: d }))
            : null,

          React.createElement("div", { className: "mp-foot" },
            React.createElement("button", {
              type: "button", className: "mp-act", "data-primary": "1",
              onClick: () => recommend(),
            }, "换一批"),
            React.createElement("button", {
              type: "button", className: "mp-act", onClick: clearRecent,
            }, "清空最近记录"),
            React.createElement("span", { className: "mp-note" },
              s.toast !== "" ? s.toast : "点气泡 0 token，只有「让 AI 写做法」才会花"),
          ),
        ),
      );
    }

    /**
     * 收藏面板：列出收藏的菜，可以逐条取消收藏。
     * 数据来自宿主（带上菜系/做法/餐次），所以这里不用自己拼信息。
     */
    function FavoritesPanel() {
      const s = useStore();
      const items = Array.isArray(s.favItems) ? s.favItems : [];
      const mealLabel = s.mealLabel !== null && typeof s.mealLabel === "object" ? s.mealLabel : {};

      const tags = (it) => {
        const out = [];
        if (it.cuisine !== undefined && it.cuisine !== "") out.push(it.cuisine);
        if (Array.isArray(it.methods) && it.methods.length > 0) out.push(it.methods.join("·"));
        if (Array.isArray(it.meals) && it.meals.length > 0) {
          out.push(it.meals.map((m) => mealLabel[m] || m).join("·"));
        }
        return out;
      };

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "mp-mask", onClick: () => set({ open: false }) }),
        React.createElement("div", { className: "mp-panel", style: panelStyle(s) },
          React.createElement("div", { className: "mp-head" },
            React.createElement("span", { className: "mp-title" }, "我的收藏"),
            React.createElement("span", { className: "mp-sub" },
              items.length > 0 ? items.length + " 道" : ""),
            React.createElement("button", {
              type: "button", className: "mp-x", title: "关闭",
              onClick: () => set({ open: false }),
            }, "✕"),
          ),

          items.length === 0
            ? React.createElement("div", { className: "mp-empty" },
                "还没有收藏。在推荐里点菜名左边的 ☆ 就能收藏，收藏的菜出现概率会明显提高。")
            : React.createElement("div", null,
                items.map((it) => React.createElement("div", {
                  className: "mp-item mp-fav-item", key: it.name,
                },
                  React.createElement("div", { className: "mp-item-top" },
                    React.createElement("span", { className: "mp-name" }, it.name),
                    it.star === 5
                      ? React.createElement("span", { className: "mp-star", title: "常见主流菜" }, "主流")
                      : null,
                    it.inLibrary === false
                      ? React.createElement("span", {
                          className: "mp-tag", title: "菜库里已经没有这道菜了（数据更新过）",
                        }, "已不在菜库")
                      : null,
                    it.inLibrary === false
                      ? null
                      : tags(it).map((t, i) => React.createElement("span", {
                          className: "mp-tag", key: String(i),
                        }, t)),
                  ),
                  React.createElement("div", { className: "mp-acts" },
                    React.createElement("button", {
                      type: "button", className: "mp-act",
                      title: "把它从收藏里去掉",
                      onClick: () => toggleFavorite(it.name),
                    }, "☆ 取消收藏"),
                    it.inLibrary === false
                      ? null
                      : React.createElement("button", {
                          type: "button", className: "mp-act",
                          title: "让大肥鱼点评这道菜（会花一点 token）",
                          onClick: () => askHost("review", it.name),
                        }, "🐳 肥鱼评价"),
                  ),
                  React.createElement(AnswerBlock, { name: it.name }),
                )),
              ),

          React.createElement("div", { className: "mp-foot" },
            React.createElement("button", {
              type: "button", className: "mp-act", "data-primary": "1",
              onClick: () => openPanel("picks", s.bubbleRect),
            }, "去挑菜"),
            React.createElement("span", { className: "mp-note" },
              s.favPersisted === false
                ? "⚠ 收藏只在内存里，重启会丢"
                : (s.toast !== "" ? s.toast : "收藏的菜出现概率更高")),
          ),
        ),
      );
    }

    /** 按 mode 决定弹出哪一个面板 */
    function Panel() {
      const s = useStore();
      if (!s.open) return null;
      if (s.mode === "filters") return React.createElement(FiltersPanel);
      if (s.mode === "favorites") return React.createElement(FavoritesPanel);
      return React.createElement(PicksPanel);
    }

    function MealWidget() {
      return React.createElement(React.Fragment, null,
        React.createElement(Bubble),
        React.createElement(Panel),
      );
    }

    // ---------------------------------------------------------------- 插件

    const inject = ["slots"];

    function apply(ctx) {
      pluginCtx = ctx;
      // 只注册一个浮层插槽：气泡和面板都在里面，
      // 这样不动输入框、也不会被任何容器裁切。
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "meal-picker", order: 150 },
        () => React.createElement(MealWidget),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    // 测试钩子：让 test/client.test.js 能在没有浏览器的情况下
    // 直接设置 store 状态并把组件渲染成静态 HTML。
    exports.__test = {
      store,
      set,
      getSnapshot: snapshot,
      recommend,
      askHost,
      clearAnswer,
      loadMeta,
      toggleFavorite,
      insertIntoComposer,
      copyText,
      openPanel,
      apiUrl,
      clampPos,
      defaultPos,
      bubbleSize,
      Bubble,
      Panel,
    };
    return module.exports;
  },
});

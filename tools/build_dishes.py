"""从任意食物库 JSON 提取菜品索引，供 dsh-meal-picker 插件使用。

本脚本是**独立**的：不依赖任何其它项目，只要求传入一个符合格式的食物库文件。
插件自带的 data/dishes.json 已经构建好并提交在仓库里，所以正常使用不需要跑它；
只有你想换一套数据源、或者从零重建时才需要。

输入格式（两种都行）：
    {"foods": [ {...}, ... ]}      或直接  [ {...}, ... ]
每条至少要有这些字段：
    name           菜名，字符串
    category       大类，只保留 菜肴 / 主食类 / 小吃 / 快餐
    sub_category   菜系，如 四川菜 / 家常菜（可为空）
    energy_kcal    每 100g 热量（千卡）—— **可选**，只用于评分
    protein / fat / cho   每 100g 的蛋白质 / 脂肪 / 碳水（克）—— **可选**，只用于评分
参考 data/source_format.example.json。

注意：本插件**刻意不保存热量与营养素**（那些是第三方数据库的测量数据，有版权风险），
所以下面那些营养字段只用来做「像不像一道正经菜」的启发式评分，不会写进产物。
热量由 AI 在你点「AI 估热量」时现算。

用法：
    python tools/build_dishes.py <食物库JSON路径>

产出：
    <包根>/data/dishes.json     插件用的精简菜品索引（4,423 道左右）
    <包根>/data/candidates.txt  启发式高分候选（供人工挑五星，可选）
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent      # 包根目录
OUT_DIR = HERE / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 只保留"可以当作一顿饭答案"的分类
WANT_CATEGORIES = {"菜肴", "主食类", "小吃", "快餐"}

# 外国菜：这些菜系分类算"换口味"
FOREIGN_CUISINES = {
    "日本料理", "韩国料理", "法国菜", "意大利菜", "其他西餐",
    "东南亚风味", "泰国菜", "越南菜",
}

# 不适合推荐的名字特征
BAD_WORDS = (
    "婴幼儿", "配方", "母乳", "调料", "底料", "酱料", "调味", "火锅底",
    "狗粮", "猫粮", "饲料", "果脯", "蜜饯", "罐头", "鱼翅", "鲨",
    "熊掌", "鹿", "蛇", "鼠", "蝙蝠", "猫", "狗", "猴", "骆驼",
    "蜂蛹", "蝉", "蝎", "蝗虫", "蚕蛹", "胎盘", "龟", "鳖", "田鸡",
)

# 「家常菜/私家菜」是最主流的两类
MAINSTREAM_CUISINES = {"家常菜": 3, "私家菜": 2}

# 常见做法词：含这些说明是一道"正经做的菜"
COOK_WORDS = (
    "炒", "烧", "炖", "蒸", "煮", "炸", "拌", "煲", "焖", "烤", "煎",
    "熘", "爆", "烩", "羹", "汤", "饭", "面", "饺", "包", "丸", "鸡", "鱼",
    "虾", "肉", "蛋", "豆腐", "菜",
)

# 零食/点心类词，降权
SNACK_WORDS = ("干", "脯", "酥", "脆", "条", "糖", "果冻", "饮料", "糕", "派", "饼干")

# ---- 自己做 / 外卖 分类 ----
# 基本只能在店里吃到的：外卖模式下加权，自己做模式下排除
TAKEOUT_ONLY_WORDS = (
    "麻辣烫", "串串", "冒菜", "汉堡", "披萨", "炸鸡", "薯条", "寿司",
    "盖浇饭", "卤肉饭", "猪脚饭", "煲仔饭", "螺蛳粉", "酸辣粉", "手抓饼",
    "肉夹馍", "煎饼", "烤冷面", "关东煮", "章鱼小丸子", "铁板鱿鱼", "炸串",
    "狼牙土豆", "锅巴土豆", "凉皮", "黄焖鸡米饭", "过桥米线", "麻辣米线",
    "紫菜包饭", "石锅拌饭", "三明治", "咖喱饭", "蛋包饭", "茶叶蛋",
)
TAKEOUT_ONLY_CUISINES = {
    "快餐", "小吃", "其他西餐", "日本料理", "韩国料理",
    "意大利菜", "法国菜", "东南亚风味",
}
# 明显是"家里能做"的：这些词命中就不算外卖专属
HOME_OK_WORDS = ("炒", "炖", "烧", "蒸", "煮", "煲", "焖", "拌", "煎", "汤")


def scene_of(name: str, cuisine: str) -> str:
    """home = 适合自己做；takeout = 基本只能点；both = 都行。"""
    if any(w in name for w in TAKEOUT_ONLY_WORDS):
        return "takeout"
    if cuisine in TAKEOUT_ONLY_CUISINES:
        return "takeout"
    if cuisine in ("其他菜肴",):
        # 「其他菜肴」里麻辣香锅/冒菜这类偏外卖，但也有一些家常做法
        return "both"
    if any(w in name for w in HOME_OK_WORDS):
        return "home"
    return "both"


def score(name: str, cuisine: str, kcal: float | None, same_name_count: int) -> int:
    s = 0
    n = len(name)
    if 3 <= n <= 6:
        s += 3
    elif n == 2 or n == 7:
        s += 1
    elif n >= 9:
        s -= 2
    s += MAINSTREAM_CUISINES.get(cuisine, 0)
    if any(w in name for w in COOK_WORDS):
        s += 2
    if any(w in name for w in SNACK_WORDS):
        s -= 2
    if kcal is not None and 82 <= kcal <= 320:
        s += 1                      # 一道菜的正常热量密度（数据源没有热量就跳过这项）
    if same_name_count >= 2:       # 多个菜系都有 → 说明是大众菜
        s += 1
    if re.search(r"[A-Za-z]{2,}", name):
        s -= 4
    return s


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        print()
        print("✗ 缺少参数：请把食物库 JSON 的路径传进来。")
        return 2
    src = Path(sys.argv[1]).expanduser()
    if not src.exists():
        print(f"✗ 找不到文件：{src}")
        return 2
    # 用 utf-8-sig：Windows 记事本 / PowerShell 生成的 JSON 常带 BOM，
    # 按 utf-8 读会直接抛 "Unexpected UTF-8 BOM"
    try:
        text = src.read_text(encoding="utf-8-sig")
    except OSError as e:
        print(f"✗ 读取失败：{e}")
        return 2
    try:
        raw = json.loads(text)
    except ValueError as e:
        print(f"✗ 不是合法的 JSON：{e}")
        return 2
    seed = raw.get("foods") if isinstance(raw, dict) else raw
    if not isinstance(seed, list):
        print("✗ 输入格式不对：应为数组，或带 foods 数组的对象。")
        return 2
    print(f"从 {src} 读入 {len(seed)} 条")

    # 同名统计（不同菜系的同名菜 = 大众菜）
    name_count: dict[str, int] = {}
    for f in seed:
        name_count[f["name"]] = name_count.get(f["name"], 0) + 1

    dishes = []
    for f in seed:
        if f.get("category") not in WANT_CATEGORIES:
            continue
        name = f["name"]
        if any(w in name for w in BAD_WORDS):
            continue
        raw_kcal = f.get("energy_kcal")
        kcal = None
        if raw_kcal is not None:
            try:
                kcal = float(raw_kcal)
            except (TypeError, ValueError):
                kcal = None
        if kcal is not None and (kcal < 20 or kcal > 600):
            continue                          # 明显不是一道菜
        cuisine = (f.get("sub_category") or "").strip() or "其他菜肴"
        # 刻意不输出热量与营养素：那些是第三方数据库的测量数据，有版权风险。
        # 热量交给 AI 现算（见 core.js 的 buildNutritionPrompt）。
        dishes.append({
            "name": name,
            "cuisine": cuisine,
            "sub_category": cuisine,
            "foreign": cuisine in FOREIGN_CUISINES,
            "scene": scene_of(name, cuisine),
            "score": score(name, cuisine, kcal, name_count[name]),
        })

    # 同名取分最高的那条
    best: dict[str, dict] = {}
    for d in dishes:
        cur = best.get(d["name"])
        if cur is None or d["score"] > cur["score"]:
            best[d["name"]] = d
    out = sorted(best.values(), key=lambda d: (-d["score"], d["name"]))
    print(f"菜品 {len(out)} 道（去重前 {len(dishes)}）")

    (OUT_DIR / "dishes.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_kb = (OUT_DIR / "dishes.json").stat().st_size / 1024
    print(f"dishes.json {size_kb:.0f} KB")

    foreign = sum(1 for d in out if d["foreign"])
    print(f"外国菜 {foreign} 道")
    scenes: dict[str, int] = {}
    for d in out:
        scenes[d["scene"]] = scenes.get(d["scene"], 0) + 1
    print(f"场景分布 {scenes}")

    # 候选清单：分数 >= 5 的，供人工挑五星
    top = [d for d in out if d["score"] >= 5]
    lines = [f"分数>=5 的共 {len(top)} 道（按分数降序）", ""]
    for d in top:
        lines.append(f"{d['score']:>3}  {d['name']:<16} {d['cuisine']}")
    (OUT_DIR / "candidates.txt").write_text("\n".join(lines), encoding="utf-8")
    print(f"候选清单 {len(top)} 道 -> candidates.txt")

    # 菜系分布
    cuis: dict[str, int] = {}
    for d in out:
        cuis[d["cuisine"]] = cuis.get(d["cuisine"], 0) + 1
    print("菜系 top15:", dict(sorted(cuis.items(), key=lambda x: -x[1])[:15]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

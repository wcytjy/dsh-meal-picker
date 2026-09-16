#!/usr/bin/env python3
"""
给每道菜标注「适合哪一餐」，写进 data/dishes.json 的 meals 字段（数组）。

标签是**软偏好**，不是硬筛：没打上标签的菜保持中立，任何时段都能出；
打错时段标签的（例如早餐时段抽到烧烤）会被降权。

规则分两类：
  · 早餐 / 午餐 / 夜宵 —— 菜名里有明确线索（粥、油条、炒饭、烧烤…）
  · 晚餐 —— 按做法推：带炒/蒸/炖等做法的「菜」且不属于午餐主食
一道菜可以同时属于多餐（炸鸡既是晚餐也是夜宵；豆浆油条是早餐）。

用法：
    python tools/tag_meals.py            # 预演
    python tools/tag_meals.py --write    # 写入
"""

import json
import sys
from collections import Counter
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dishes.json"

BREAKFAST = [
    "粥", "豆浆", "油条", "包子", "肉包", "菜包", "豆沙包", "叉烧包", "馒头", "花卷",
    "烧饼", "煎饼", "肠粉", "小笼", "馄饨", "抄手", "蒸饺", "烧麦", "豆腐脑", "豆花",
    "米糊", "麦片", "吐司", "面包", "三明治", "煮蛋", "煎蛋", "荷包蛋", "鸡蛋羹",
    "蒸蛋", "卤蛋", "茶叶蛋", "牛奶", "酸奶", "油茶", "面茶", "窝头", "发糕",
    "糯米鸡", "蛋挞", "酥饼", "银耳", "疙瘩汤",
]

LUNCH = [
    "炒饭", "盖饭", "拌饭", "煲仔饭", "咖喱饭", "卤肉饭", "蒸饭", "焖饭", "手抓饭",
    "炒面", "拌面", "拉面", "刀削面", "热干面", "凉面", "汤面", "捞面", "烩面",
    "米粉", "米线", "河粉", "螺蛳粉", "酸辣粉", "粉丝", "粉条",
    "饺子", "水饺", "汉堡", "披萨", "意面", "便当", "套餐", "卷饼", "肉夹馍",
]

# 夜宵：重口、街头、下酒那一类
# 刻意不收「毛豆」「花生米」「啤酒」：它们是食材或饮品，
# 「丝瓜炒毛豆」这种家常菜会被误标成夜宵（实测踩过）。
LATENIGHT = [
    "烧烤", "烤串", "肉串", "羊肉串", "串", "小龙虾", "麻辣烫", "麻辣香锅",
    "炸鸡", "炸串", "卤味", "鸭脖", "泡面", "方便面", "砂锅", "铁板", "关东煮",
    "烤鱼", "烤翅", "烤鱿鱼", "烤肠", "炸臭豆腐", "臭豆腐",
    "鸭头", "鸡爪", "凤爪", "卤煮", "烤冷面", "煎饼果子",
]

# 晚餐：带这些做法的「菜」算正餐（主食另有午餐标签，不重复计）
DINNER_METHODS = {"炒", "蒸", "炖", "焖", "烧", "煎", "拌", "汤", "卤", "烤", "炸"}

ORDER = ["breakfast", "lunch", "dinner", "lateNight"]
LABEL = {"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "lateNight": "夜宵"}


def meals_of(dish: dict):
    name = dish.get("name", "")
    tags = set()
    if any(k in name for k in BREAKFAST):
        tags.add("breakfast")
    lunch = any(k in name for k in LUNCH)
    if lunch:
        tags.add("lunch")
    if any(k in name for k in LATENIGHT):
        tags.add("lateNight")
    methods = dish.get("methods") or []
    if not lunch and any(m in DINNER_METHODS for m in methods):
        tags.add("dinner")
    return [t for t in ORDER if t in tags]


def main() -> int:
    write = "--write" in sys.argv
    if not DATA.exists():
        print(f"找不到数据文件：{DATA}", file=sys.stderr)
        return 1
    raw = json.loads(DATA.read_text(encoding="utf-8-sig"))
    dishes = raw if isinstance(raw, list) else raw.get("dishes")
    if not isinstance(dishes, list):
        print("数据文件结构不对", file=sys.stderr)
        return 1

    counts = Counter()
    changed = 0
    for d in dishes:
        if not isinstance(d, dict):
            continue
        tags = meals_of(d)
        if d.get("meals") != tags:
            changed += 1
        d["meals"] = tags
        for t in tags:
            counts[t] += 1

    tagged = sum(1 for d in dishes if d.get("meals"))
    print(f"菜品总数：{len(dishes)}    需要更新：{changed} 条")
    print(f"至少属于一餐：{tagged} 道（{tagged / len(dishes) * 100:.1f}%）"
          f"    中立（未标注）：{len(dishes) - tagged} 道")
    for t in ORDER:
        print(f"  {LABEL[t]:<3} {counts[t]:>4} 道")

    multi = [d for d in dishes if len(d.get("meals") or []) > 1]
    print(f"\n同时属于两餐以上：{len(multi)} 道")
    for d in multi[:10]:
        print(f"  · {d['name']} -> {'+'.join(LABEL[t] for t in d['meals'])}")

    print("\n每餐抽样（用来肉眼查误标）：")
    for t in ORDER:
        sample = [d["name"] for d in dishes if t in (d.get("meals") or [])][:12]
        print(f"  [{LABEL[t]}] {'、'.join(sample)}")

    if write:
        DATA.write_text(
            json.dumps(raw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"\n已写入 {DATA}（{DATA.stat().st_size} 字节）")
    else:
        print("\n（预演结束，没有写入。加 --write 才真正保存）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
清理 data/dishes.json 里抓取阶段留下的重复条目。

背景：原始菜谱站上同一道菜常收录多份，抓下来后名字被加上 `(一)` `(二)` 后缀。
这两个后缀本身不带任何信息 —— `爆肚(一)` 和 `爆肚(二)` 是同菜同菜系同权重 ——
所以它们属于噪音，不该出现在推荐结果里（使用者会看到两道一模一样的菜）。

处理方式分两种，都是逐条写死、不用正则批量猜：

1. DELETE：删掉多余的条目。要么是成对出现的克隆（留一条就够），
   要么是库里已经有同名正菜系的正牌条目（如 `醋溜白菜(二)` 之于五星的 `醋溜白菜`）。
2. RENAME：只有一条、且去掉后缀不与任何现有菜名冲突的，属于「孤儿」——
   后缀纯属噪音，但菜本身是好的，所以去后缀保留，而不是连菜一起删掉。

刻意不处理带语义的括号变体（`饺子(三鲜馅)`、`煎饼果子(加薄脆)`、`粽子(肉)` 等），
那是不同做法/口味的独立条目，删掉就是丢数据。

用法：
    python tools/dedupe_dishes.py            # 预演，只打印将要改什么
    python tools/dedupe_dishes.py --write    # 真正写入 data/dishes.json

可重复运行：处理过的条目会被识别并跳过，再跑一次只会打印「没有要改的」。
"""

import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dishes.json"

# 要删除的条目：成对克隆里被留下的那一条之外的部分，以及被正牌条目覆盖的重复项。
DELETE = [
    # 成对克隆，留一条（保留的那条见 RENAME）
    "爆肚(二)",
    "烤猪肉(一)",
    "焦熘里脊(二)",
    "家制腊肉(二)",
    "酱芥菜丝(二)",
    # 库里已有同名正牌条目，这几条是同一道菜的重复收录
    "白切羊肉(一)",
    "醋溜白菜(二)",
    # 错字 + 旧营养字段，库里已有正确的「螺蛳粉」
    "螺狮粉(干重，均值)",
    # 只有一条但去后缀会与现有菜名撞车，故整条删除
    "炸牛排(二)",
    "咸肉(二)",
    "熏肉(一)",
    "腊肉(一)",
]

# 要改名的条目：菜名 -> 去掉（一）/（二）后缀后的名字
RENAME = {
    "爆肚(一)": "爆肚",
    "烤猪肉(二)": "烤猪肉",
    "焦熘里脊(一)": "焦熘里脊",
    "家制腊肉(一)": "家制腊肉",
    "酱芥菜丝(一)": "酱芥菜丝",
    "软熘豆腐(一)": "软熘豆腐",
    "醋熘白菜(一)": "醋熘白菜",
    "干烧鸭条(一)": "干烧鸭条",
    "灯影牛肉(二)": "灯影牛肉",
    "脆皮鸭(一)": "脆皮鸭",
}

SUFFIX = re.compile(r"[（(][一二][）)]$")


def main() -> int:
    write = "--write" in sys.argv[1:]

    raw = json.loads(DATA.read_text(encoding="utf-8"))
    dishes = raw if isinstance(raw, list) else raw.get("dishes", [])

    names = {str(d.get("name", "")) for d in dishes}
    before = len(dishes)

    # ---------------------------------------------------------------- 复核
    print("[1] 待删条目")
    for n in DELETE:
        print(f"    · {n}" + ("" if n in names else "  （已不存在，跳过）"))

    print("\n[2] 待改名条目")
    for old, new in RENAME.items():
        if old not in names:
            print(f"    · {old} -> {new}  （已不存在，跳过）")
        elif new in names:
            print(f"    · {old} -> {new}  ！！跳过：目标名已存在，会撞车")
        else:
            print(f"    · {old} -> {new}")

    # 改名目标不能与待删条目重合，否则先删后改会丢菜
    clash = [n for n in RENAME.values() if n in DELETE]
    if clash:
        print(f"\n！！名单自相矛盾：{clash} 既是改名目标又在待删列表里")
        return 1

    # ---------------------------------------------------------------- 执行
    kept = []
    removed = []
    renamed = []
    for d in dishes:
        n = str(d.get("name", ""))
        if n in DELETE:
            removed.append(n)
            continue
        if n in RENAME and RENAME[n] not in names:
            d["name"] = RENAME[n]
            renamed.append((n, RENAME[n]))
        kept.append(d)

    # ---------------------------------------------------------------- 结果
    print("\n[3] 结果")
    print(f"    删除 {len(removed)} 条")
    print(f"    改名 {len(renamed)} 条")
    print(f"    菜库 {before} -> {len(kept)} 道")

    left = [str(d.get("name", "")) for d in kept if SUFFIX.search(str(d.get("name", "")))]
    print(f"    仍带 (一)/(二) 后缀的：{len(left)} 条" + ("" if not left else " -> " + "、".join(left)))

    star5 = sum(1 for d in kept if d.get("star") == 5)
    methods = sum(1 for d in kept if d.get("methods"))
    meals = sum(1 for d in kept if d.get("meals"))
    print(f"    五星菜 {star5} 道、做法标签 {methods} 道、餐次标签 {meals} 道")

    if not removed and not renamed:
        print("\n没有要改的（已经清理过）。")
        return 0

    if write:
        # 与其它数据工具保持一致：单行压缩 JSON，不加缩进与换行。
        # 带缩进会让文件从 ~579KB 涨到 700KB+ 并被 git 判成二进制。
        DATA.write_text(
            json.dumps(kept, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"\n已写入 {DATA}（单行压缩格式，{DATA.stat().st_size} 字节）")
    else:
        print("\n（预演结束，没有写入任何文件。加 --write 才真正保存）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

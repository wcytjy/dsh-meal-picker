#!/usr/bin/env python3
"""
给每道菜标注「做法」，写进 data/dishes.json 的 methods 字段（数组）。

为什么从菜名规则化而不是靠模型：这是一次性、可复核、零 token 的工作，
规则表就在下面，命中什么一目了然。代价是只覆盖菜名里写了做法的菜
（约六成），没写做法的（如「宫保鸡丁」其实是炒）留在空数组里。

一个菜可以带多个做法标签：爆汆鱼块 = 炒 + 煮。

用法：
    python tools/tag_methods.py            # 预演，只打印统计与抽样
    python tools/tag_methods.py --write    # 真正写入
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dishes.json"

# 规范做法 -> 触发词。键的顺序无关，同义词折叠到同一个规范名。
# 刻意不收的触发词及原因：
#   泡  —— 「泡椒焖鸡翅」里的泡椒是调料，不是腌制
#   酱  —— 「酱汁油菜」「麻酱拌面」里的酱是酱汁，不是卤酱
#   酥  —— 「酥皮」「桃酥」是口感或点心名
#   腌 只收「腌」本字，不收「泡/酸」
RULES = {
    "炒": ["炒", "爆", "煸", "熘"],
    "蒸": ["蒸"],
    "煮": ["煮", "汆", "焯", "涮", "烫"],
    "炖": ["炖", "煨", "煲", "砂锅"],
    "焖": ["焖"],
    "烧": ["烧", "扒", "烩", "扣"],
    "炸": ["炸", "拔丝"],
    "煎": ["煎", "锅贴", "贴饼"],
    "烤": ["烤", "烘", "熏", "焗"],
    "卤": ["卤"],
    "拌": ["拌", "炝", "沙拉", "色拉"],
    "汤": ["汤", "羹"],
    "腌": ["腌"],
}

# 展示顺序：常见做法在前
ORDER = ["炒", "蒸", "煮", "炖", "焖", "烧", "炸", "煎", "烤", "卤", "拌", "汤", "腌"]

# 触发词在下列语境里不是做法，要排除掉。
# 「牛扒/猪扒/鸡扒」里的扒是牛排的意思（名词），不是烹饪法「扒」。
EXCLUDE = {
    "扒": [r".{0,2}(牛|猪|鸡|羊|鱼|虾|鹅|鸭)扒"],
}


def triggers(name: str, word: str) -> bool:
    if word not in name:
        return False
    for pat in EXCLUDE.get(word, []):
        if re.search(pat, name):
            return False
    return True


def methods_of(name: str):
    hit = []
    for canon, words in RULES.items():
        if any(triggers(name, w) for w in words):
            hit.append(canon)
    return [m for m in ORDER if m in hit]


def main() -> int:
    write = "--write" in sys.argv
    if not DATA.exists():
        print(f"找不到数据文件：{DATA}", file=sys.stderr)
        return 1
    try:
        raw = json.loads(DATA.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        print(f"数据文件不是合法 JSON：{e}", file=sys.stderr)
        return 1

    dishes = raw if isinstance(raw, list) else raw.get("dishes")
    if not isinstance(dishes, list):
        print("数据文件结构不对", file=sys.stderr)
        return 1

    before = Counter()
    changed = 0
    for d in dishes:
        if not isinstance(d, dict) or not isinstance(d.get("name"), str):
            continue
        ms = methods_of(d["name"])
        if d.get("methods") != ms:
            changed += 1
        d["methods"] = ms
        for m in ms:
            before[m] += 1

    tagged = sum(1 for d in dishes if d.get("methods"))
    print(f"数据文件：{DATA}")
    print(f"菜品总数：{len(dishes)}    需要更新：{changed} 条")
    print(f"有做法标签：{tagged} 道（{tagged / len(dishes) * 100:.1f}%）"
          f"    无标签：{len(dishes) - tagged} 道")

    print("\n各做法命中道数：")
    for m in ORDER:
        print(f"  {m:<3} {before[m]:>4} 道")

    multi = [d for d in dishes if len(d.get("methods", [])) > 1]
    print(f"\n带两个以上做法标签：{len(multi)} 道")
    for d in multi[:12]:
        print(f"  · {d['name']} -> {'+'.join(d['methods'])}")

    print("\n每个做法的抽样（用来肉眼查假阳性）：")
    for m in ORDER:
        sample = [d["name"] for d in dishes if m in d.get("methods", [])][:8]
        print(f"  [{m}] {'、'.join(sample)}")

    print("\n没打上标签的抽样：")
    none = [d["name"] for d in dishes if not d.get("methods")]
    print("  " + "、".join(none[:24]))

    if write:
        DATA.write_text(
            json.dumps(raw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"\n已写入 {DATA}（单行压缩格式，{DATA.stat().st_size} 字节）")
    else:
        print("\n（预演结束，没有写入。加 --write 才真正保存）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

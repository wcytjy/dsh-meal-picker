#!/usr/bin/env python3
"""
清理 data/dishes.json 里的两处历史遗留：

1. cuisine 字段里混进了「做法 / 品类」桶，它们本不该作为菜系存在。
   之所以逐条写死而不是按桶批量改：这批桶本身就是错标的 ——
   薄荷把肠粉标成「凉拌」、把石锅拌饭标成「锅塌」——
   所以归到哪里只能看菜名，不能看原来的桶。
2. 菜名里残留的旧营养数据痕迹（如「螺狮粉(干重，均值)」）。

用法：
    python tools/clean_dishes.py            # 预演，只打印将要改什么
    python tools/clean_dishes.py --write    # 真正写入 data/dishes.json

可重复运行：已经处理过的条目会被识别并跳过，不会重复改。
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "dishes.json"

# 菜名 -> (目标菜系, 目标 foreign)。foreign 只在需要一并改的时候写出来。
FOLD = {
    # 广东
    "叉烧肠粉": ("广东菜", None),
    "煎肠粉": ("广东菜", None),
    "肠粉": ("广东菜", None),
    # 湖北
    "热干面": ("湖北菜", None),
    "鱼面": ("湖北菜", None),
    # 广西
    "螺狮粉(干重，均值)": ("广西菜", None),
    # 云南
    "过桥米线": ("滇黔菜", None),
    # 山东
    "煎饼": ("山东菜", None),
    # 青藏
    "青稞炒面": ("青海菜", None),
    # 确实外来的：菜系改过去，foreign 标记也跟着改，否则「只要中餐」会混进它们
    "石锅拌饭": ("韩国料理", True),
    "法棍": ("法国菜", True),
    # 没有地缘线索的家常菜
    "粉皮": ("家常菜", None),
    "韭菜合子": ("家常菜", None),
    "全料蒸肉粉": ("家常菜", None),
    "馄饨(素馅)": ("家常菜", None),
    "香油炒面": ("家常菜", None),
    "开口笑": ("家常菜", None),
    "凉面": ("家常菜", None),
    "饺子(三鲜馅)": ("家常菜", None),
    "饺子(猪肉芹菜馅)": ("家常菜", None),
    "饺子(猪肉韭菜馅)": ("家常菜", None),
    "黑芝麻糊": ("家常菜", None),
}

# 旧名 -> 新名。数据里若已存在新名字，就不动，转由下面的重复项核查报出来。
RENAME = {
    "螺狮粉(干重，均值)": "螺蛳粉",   # 「狮」是错字，括号里是营养数据时代的字段
}

# 归完之后这些桶不该再存在；还剩就说明有漏网的
JUNK_BUCKETS = [
    "凉拌", "煎", "清蒸", "炒", "锅塌", "炖", "炸", "干煸", "烤",
    "砂锅、煮", "小吃类", "快餐食品类",
]

# 名称里不该有的旧字段痕迹（只报告，是否处理由 RENAME 决定）
SUSPICIOUS = ["(干重", "（干重", "均值", "每100", "每 100"]


def load():
    if not DATA.exists():
        print(f"找不到数据文件：{DATA}", file=sys.stderr)
        return None
    try:
        raw = json.loads(DATA.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        print(f"数据文件不是合法 JSON：{e}", file=sys.stderr)
        return None
    dishes = raw if isinstance(raw, list) else raw.get("dishes")
    if not isinstance(dishes, list):
        print("数据文件结构不对：既不是数组，也没有 dishes 数组", file=sys.stderr)
        return None
    return raw, dishes


def main() -> int:
    write = "--write" in sys.argv
    loaded = load()
    if loaded is None:
        return 1
    raw, dishes = loaded

    by_name = {}
    for d in dishes:
        if isinstance(d, dict) and isinstance(d.get("name"), str):
            by_name.setdefault(d["name"], []).append(d)

    print(f"数据文件：{DATA}")
    print(f"菜品总数：{len(dishes)}")

    # ---------------------------------------------------------------- 改菜系
    changed, already, missing = [], [], []
    for name, (target, foreign) in FOLD.items():
        rows = by_name.get(name)
        if rows is None:
            missing.append(name)
            continue
        for d in rows:
            if d.get("cuisine") == target and (foreign is None or d.get("foreign") is foreign):
                already.append(name)
                continue
            old_c, old_f = d.get("cuisine"), d.get("foreign")
            d["cuisine"] = target
            if foreign is not None:
                d["foreign"] = foreign
            changed.append((name, old_c, target, old_f, d.get("foreign")))

    print(f"\n[1] 归入真实菜系：{len(changed)} 条待改，{len(already)} 条已处理")
    for name, oc, tc, of, nf in changed:
        note = "" if (nf is None or of == nf) else f"   foreign {of} -> {nf}"
        print(f"  · {name}：{oc} -> {tc}{note}")
    if missing:
        print("  表里有、数据里没有的菜名（需核对）：")
        for name in missing:
            print(f"    ! {name}")

    # ---------------------------------------------------------------- 改菜名
    renames = []
    for old, new in RENAME.items():
        rows = by_name.get(old)
        if rows is None:
            continue
        if new in by_name:
            print(f"  ! 跳过重命名 {old} -> {new}：新名字已被占用")
            continue
        for d in rows:
            d["name"] = new
            renames.append((old, new))
    print(f"\n[2] 清理菜名：{len(renames)} 条")
    for old, new in renames:
        print(f"  · {old} -> {new}")

    # ---------------------------------------------------------------- 复核
    left = Counter(d.get("cuisine") for d in dishes if d.get("cuisine") in JUNK_BUCKETS)
    print("\n[3] 复核")
    print("  残留的做法/品类桶：", "无" if not left else dict(left))

    sus = [d["name"] for d in dishes
           if isinstance(d.get("name"), str) and any(s in d["name"] for s in SUSPICIOUS)]
    print(f"  名称仍含旧营养字段痕迹的：{len(sus)} 道")
    for n in sus[:10]:
        print(f"    · {n}")

    dist = Counter(d.get("cuisine") for d in dishes)
    small = sorted((n, c) for c, n in dist.items() if n <= 2)
    print(f"  菜系取值：{len(dist)} 个；其中只有 1-2 道菜的：{len(small)} 个")
    for n, c in small:
        print(f"    {n}  {c}")

    names = [d.get("name") for d in dishes]
    dup = [n for n, c in Counter(names).items() if c > 1]
    print(f"  重名菜：{len(dup)} 个" + ("" if not dup else " -> " + "、".join(dup[:8])))

    # ---------------------------------------------------------------- 只报告：重复条目
    # 这些要删条目，不属于「改字段」，所以只报出来等人确认，不自动动
    print("\n[4] 重复条目的核查（本工具不处理）")

    seq = [d["name"] for d in dishes if re.search(r"[（(][一二][）)]$", str(d.get("name", "")))]
    print(f"  名字以 (一)/(二) 结尾的抓取重复项：{len(seq)} 条")
    for n in seq:
        print(f"    · {n}")

    def base_name(s):
        return re.sub(r"[（(][^）)]*[）)]", "", s).replace(" ", "")

    groups = {}
    for d in dishes:
        n = str(d.get("name", ""))
        groups.setdefault(base_name(n), []).append(n)
    multi = {b: v for b, v in groups.items() if len(v) > 1}
    print(f"  去括号后同名的组：{len(multi)} 组（其中一部分是同菜不同做法，属正常）")

    if write:
        # 与 build_dishes.py 保持一致：单行压缩 JSON，不加缩进与换行。
        # 这个文件的格式是刻意的（.gitattributes 里标了 -diff），别改成带缩进。
        DATA.write_text(
            json.dumps(raw, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"\n已写入 {DATA}（单行压缩格式，{DATA.stat().st_size} 字节）")
    else:
        print("\n（预演结束，没有写入任何文件。加 --write 才真正保存）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

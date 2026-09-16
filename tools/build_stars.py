"""把五星表 + 启发式分数合并进 dishes.json，并校验每个五星菜名都存在。

产出：
    data/dishes.json  增加 star(0/5) 与 weight(1~20) 字段
运行：python tools/build_stars.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
DISHES = DATA / "dishes.json"
STARS = DATA / "stars.json"

WEIGHT_5STAR = 120
"""五星菜权重。

取值依据：五星 132 道 vs 其余 4303 道（平均启发式权重 ≈3.9）。
权重 120 时五星约占结果的 48%，也就是「大概一半是熟悉的国民菜，一半是别的」。
这个值可以在插件配置里用 fiveStarWeight 覆盖（需要的话改 build 脚本重跑）。
"""


def weight_from_score(score: int) -> int:
    """启发式分数 -> 权重（1~6）。五星菜另有 20。"""
    if score >= 9:
        return 6
    if score >= 7:
        return 5
    if score >= 5:
        return 4
    if score >= 3:
        return 3
    if score >= 1:
        return 2
    return 1


def main() -> int:
    dishes = json.loads(DISHES.read_text(encoding="utf-8-sig"))
    stars = json.loads(STARS.read_text(encoding="utf-8-sig"))

    want: list[str] = []
    for group in stars["groups"].values():
        want.extend(group)
    want = list(dict.fromkeys(want))

    by_name = {d["name"]: d for d in dishes}
    missing = [n for n in want if n not in by_name]
    if missing:
        print(f"✗ 五星表里有 {len(missing)} 个名字在菜品库中不存在：")
        for n in missing:
            print(f"    {n}")
        print("\n请改 stars.json（换成数据集中真实存在的写法），或用 "
              "tools/lookup_missing.py 找近似名。")
        return 1

    star_set = set(want)
    for d in dishes:
        d["star"] = 5 if d["name"] in star_set else 0
        d["weight"] = WEIGHT_5STAR if d["star"] == 5 else weight_from_score(d["score"])

    DISHES.write_text(json.dumps(dishes, ensure_ascii=False, separators=(",", ":")),
                      encoding="utf-8")

    n5 = sum(1 for d in dishes if d["star"] == 5)
    dist: dict[int, int] = {}
    for d in dishes:
        dist[d["weight"]] = dist.get(d["weight"], 0) + 1
    print(f"✓ 五星菜 {n5} 道（全部校验通过）")
    print(f"✓ 菜品总数 {len(dishes)} 道，{DISHES.stat().st_size/1024:.0f} KB")
    print(f"✓ 权重分布（权重:条数）{dict(sorted(dist.items()))}")
    foreign = sum(1 for d in dishes if d["foreign"])
    print(f"✓ 外国菜 {foreign} 道")
    return 0


if __name__ == "__main__":
    sys.exit(main())

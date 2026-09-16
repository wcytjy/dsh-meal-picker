"""为未命中的菜名找数据集中真实存在的写法。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DISHES = Path(__file__).resolve().parent.parent / "data" / "dishes.json"

# 未命中的名字 -> 用来搜索的关键词
LOOKUP: dict[str, list[str]] = {
    "京酱肉丝": ["酱肉丝", "京酱"],
    "糖醋排骨": ["排骨"],
    "排骨炖豆角": ["豆角"],
    "玉米排骨汤": ["排骨汤"],
    "可乐鸡翅": ["鸡翅"],
    "香菇滑鸡": ["滑鸡"],
    "黄焖鸡": ["黄焖"],
    "奥尔良烤翅": ["烤翅"],
    "啤酒鸭": ["鸭"],
    "香酥鸡": ["酥鸡"],
    "宫爆鸡丁": ["鸡丁"],
    "红烧鱼": ["红烧鱼"],
    "清蒸鲈鱼": ["鲈鱼", "清蒸鱼"],
    "香煎带鱼": ["带鱼"],
    "干锅虾": ["虾"],
    "糖醋鲤鱼": ["鲤鱼"],
    "西红柿炒蛋": ["番茄", "西红柿"],
    "手撕包菜": ["包菜", "圆白菜"],
    "拍黄瓜": ["黄瓜"],
    "蚝油生菜": ["生菜"],
    "干煸豆角": ["四季豆", "豆角"],
    "饺子": ["饺"],
    "包子": ["包"],
    "米线": ["米线"],
    "白菜豆腐汤": ["豆腐汤"],
    "罗宋汤": ["罗宋", "番茄汤"],
    "酸辣汤": ["酸辣汤"],
    "胡辣汤": ["胡辣汤"],
    "海带豆腐汤": ["海带"],
    "臭豆腐": ["臭豆腐"],
    "烤红薯": ["红薯", "甘薯"],
    "煲仔饭": ["煲仔"],
    "汉堡": ["汉堡"],
    "三明治": ["三明治"],
    "寿司": ["寿司"],
    "蛋挞": ["挞"],
    "蒜泥黄瓜": ["黄瓜"],
    "拌木耳": ["木耳"],
}


def main() -> int:
    dishes = json.loads(DISHES.read_text(encoding="utf-8-sig"))
    names = {d["name"]: d for d in dishes}
    all_names = list(names)

    out = []
    for target, keys in LOOKUP.items():
        hits: list[str] = []
        for k in keys:
            for n in all_names:
                if k in n and n not in hits:
                    hits.append(n)
        # 按名字长度升序（短的通常更接近通用写法）
        hits.sort(key=len)
        out.append(f"\n### 找「{target}」（关键词 {'/'.join(keys)}）")
        for h in hits[:14]:
            d = names[h]
            out.append(f"    {h:<20} {d['cuisine']:<7} {d['kcal']:>3}kcal P{d['p']}/F{d['f']}/C{d['c']}")
        if not hits:
            out.append("    （无匹配）")

    text = "\n".join(out)
    Path(__file__).resolve().parent.parent / "data" / "lookup.txt".write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""核对手工列的"国民菜"名单在菜品库里是否存在。

用法：python tools/check_stars.py
把 WA NT 里不存在的名字挑出来，好人工换成数据集中真实存在的写法。
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

DISHES = Path(__file__).resolve().parent.parent / "data" / "dishes.json"

# 手工列的国民菜（按类别分组，方便核对漏了什么）
WANT: dict[str, list[str]] = {
    "猪肉": ["红烧肉", "回锅肉", "鱼香肉丝", "糖醋里脊", "京酱肉丝", "木须肉",
             "肉末茄子", "蚂蚁上树", "红烧排骨", "糖醋排骨", "粉蒸肉", "梅菜扣肉",
             "狮子头", "青椒炒肉", "小炒肉", "辣椒炒肉", "蒜泥白肉", "水煮肉片",
             "锅包肉", "溜肉段", "土豆炖牛肉", "番茄牛腩", "红烧牛肉", "红烧猪蹄",
             "排骨炖豆角", "冬瓜排骨汤", "玉米排骨汤"],
    "鸡鸭": ["宫保鸡丁", "辣子鸡", "可乐鸡翅", "大盘鸡", "白切鸡", "口水鸡",
             "香菇滑鸡", "黄焖鸡", "三杯鸡", "盐焗鸡", "咖喱鸡", "小鸡炖蘑菇",
             "奥尔良烤翅", "啤酒鸭", "烤鸭", "香酥鸡", "宫爆鸡丁"],
    "鱼虾": ["酸菜鱼", "水煮鱼", "清蒸鱼", "红烧鱼", "糖醋鱼", "剁椒鱼头",
             "烤鱼", "清蒸鲈鱼", "香煎带鱼", "白灼虾", "油焖大虾",
             "蒜蓉粉丝蒸扇贝", "干锅虾", "红烧带鱼", "糖醋鲤鱼"],
    "蛋豆": ["西红柿炒蛋", "番茄炒蛋", "韭菜炒蛋", "蒸蛋羹", "麻婆豆腐",
             "家常豆腐", "皮蛋豆腐", "小葱拌豆腐", "铁板豆腐", "蛋炒饭",
             "洋葱炒蛋", "苦瓜炒蛋", "日本豆腐"],
    "素菜": ["酸辣土豆丝", "地三鲜", "干煸四季豆", "蒜蓉西兰花", "清炒时蔬",
             "手撕包菜", "醋溜白菜", "凉拌黄瓜", "凉拌木耳", "拍黄瓜",
             "蚝油生菜", "上汤娃娃菜", "干锅花菜", "红烧茄子", "虎皮青椒",
             "干煸豆角", "清炒油麦菜", "香菇青菜", "番茄炒蛋"],
    "主食面点": ["饺子", "小笼包", "包子", "馄饨", "扬州炒饭", "炒面", "炒河粉",
                 "兰州牛肉拉面", "热干面", "炸酱面", "阳春面", "刀削面",
                 "重庆小面", "肉夹馍", "煎饼果子", "手抓饼", "生煎包", "烧麦",
                 "葱油饼", "锅贴", "凉皮", "螺蛳粉", "酸辣粉", "米线"],
    "汤羹": ["紫菜蛋花汤", "西红柿鸡蛋汤", "白菜豆腐汤", "罗宋汤", "酸辣汤",
             "胡辣汤", "海带豆腐汤"],
    "小吃火锅": ["麻辣烫", "麻辣香锅", "串串香", "冒菜", "烤羊肉串", "烤冷面",
                 "臭豆腐", "关东煮", "章鱼小丸子", "锅巴土豆", "狼牙土豆",
                 "铁板鱿鱼", "炸串", "烤红薯", "茶叶蛋"],
    "米饭快餐": ["黄焖鸡米饭", "卤肉饭", "猪脚饭", "咖喱饭", "盖浇饭", "煲仔饭",
                 "石锅拌饭", "蛋包饭", "汉堡", "炸鸡", "薯条", "披萨",
                 "三明治", "寿司", "紫菜包饭", "蛋挞"],
    "凉菜": ["夫妻肺片", "凉拌海带丝", "蒜泥黄瓜", "拌木耳", "凉拌粉丝"],
}


def main() -> int:
    dishes = json.loads(DISHES.read_text(encoding="utf-8-sig"))
    by_name = {d["name"]: d for d in dishes}
    # 也建立"名字包含"索引，方便找近似写法
    all_names = list(by_name)

    print(f"菜品库 {len(all_names)} 道\n")
    hit, miss = [], []
    for group, names in WANT.items():
        print(f"== {group} ==")
        for n in names:
            if n in by_name:
                d = by_name[n]
                hit.append(n)
                print(f"  ✓ {n:<14} {d['cuisine']:<7} {d['kcal']:>3}kcal")
            else:
                # 找近似
                like = [x for x in all_names if n[:2] in x][:4]
                miss.append(n)
                print(f"  ✗ {n:<14} 不存在   近似: {like}")

    uniq_hit = list(dict.fromkeys(hit))
    uniq_miss = list(dict.fromkeys(miss))
    print(f"\n命中 {len(uniq_hit)} 个，未命中 {len(uniq_miss)} 个")
    print("未命中清单：")
    print("  " + "、".join(uniq_miss))

    Path(__file__).resolve().parent.parent / "data" / "stars_check.txt".write_text(
        "\n".join(uniq_hit) + "\n\n--- 未命中 ---\n" + "\n".join(uniq_miss),
        encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

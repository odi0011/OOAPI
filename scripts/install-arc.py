#!/usr/bin/env python3
"""
从 Arc UI registry 拉取组件及其全部依赖，写入项目 src/components/arc/。

Arc UI 是 shadcn 风格的 registry：每个组件是一个 JSON，内含文件内容与
registryDependencies（指向其它组件）。这里递归解析，避免漏装依赖导致
import 报错。target 里的 @components/ 对应项目的 src/components/。
"""
import json
import os
import sys
import urllib.request

REGISTRY = "https://uiarc.dev/r"
PROJECT = "/opt/ooapi/web"
TARGET_PREFIX = "@components/"
DEST_PREFIX = "src/components/"

installed = set()
npm_deps = set()
npm_dev_deps = set()


def fetch(name):
    url = name if name.startswith("http") else f"{REGISTRY}/{name}.json"
    req = urllib.request.Request(url, headers={"User-Agent": "ooapi-setup"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def install(name):
    if name in installed:
        return
    installed.add(name)

    try:
        item = fetch(name)
    except Exception as e:
        print(f"  !! 拉取 {name} 失败: {e}", file=sys.stderr)
        return

    for dep in item.get("registryDependencies", []):
        # 依赖可能是完整 URL 或短名，统一成短名做去重
        short = dep.rstrip("/").split("/")[-1].replace(".json", "")
        install(short)

    for d in item.get("dependencies", []):
        npm_deps.add(d)
    for d in item.get("devDependencies", []):
        npm_dev_deps.add(d)

    for f in item.get("files", []):
        target = f.get("target") or ""
        content = f.get("content", "")

        if target.startswith(TARGET_PREFIX):
            rel = target[len(TARGET_PREFIX):]
        else:
            rel = f["path"]

        dest = os.path.join(PROJECT, DEST_PREFIX, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write(content)
        print(f"  + {DEST_PREFIX}{rel}")


def main():
    names = sys.argv[1:]
    if not names:
        print("用法: install-arc.py <组件名...>", file=sys.stderr)
        sys.exit(1)

    print(f"== 安装 {len(names)} 个组件及其依赖 ==")
    for n in names:
        install(n)

    print(f"\n共写入 {len(installed)} 个 registry 条目:")
    for n in sorted(installed):
        print(f"  - {n}")

    if npm_deps:
        print("\n需要安装的 npm 依赖:")
        print(" ".join(sorted(npm_deps)))
    if npm_dev_deps:
        print("\n需要安装的 npm devDependencies:")
        print(" ".join(sorted(npm_dev_deps)))

    # 输出给 shell 用
    with open("/tmp/arc-deps.txt", "w") as fh:
        fh.write(" ".join(sorted(npm_deps)))
    with open("/tmp/arc-dev-deps.txt", "w") as fh:
        fh.write(" ".join(sorted(npm_dev_deps)))


if __name__ == "__main__":
    main()

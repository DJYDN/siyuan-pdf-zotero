#!/usr/bin/env python3
"""Build a pruned portable Python runtime for one OCR engine from a source runtime + import trace.

Usage:
    build-runtime.py <source_runtime> <dest_runtime> <trace.json>

Only the distributions that own an imported top-level module are kept, plus the
Python core, the DLL folder and the stdlib (minus test/tk/venv/...).
"""
from __future__ import annotations

import csv
import json
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

CORE_FILES = ["python.exe", "pythonw.exe", "python3.dll", "python313.dll", "vcruntime140.dll", "vcruntime140_1.dll"]
STDLIB_SKIP = {
    "site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip",
    "venv", "__pycache__", "lib2to3", "pydoc_data", "Doc", "docs",
}


def read_top_levels(dist_info: str) -> set[str]:
    top = os.path.join(dist_info, "top_level.txt")
    if os.path.isfile(top):
        with open(top, encoding="utf-8", errors="ignore") as handle:
            names = {line.strip() for line in handle if line.strip()}
        if names:
            return names
    record = os.path.join(dist_info, "RECORD")
    names: set[str] = set()
    if os.path.isfile(record):
        with open(record, encoding="utf-8", errors="ignore", newline="") as handle:
            for row in csv.reader(handle):
                if not row:
                    continue
                path = row[0].replace("\\", "/")
                head = path.split("/")[0]
                if head.endswith(".dist-info") or head.endswith(".data") or not head or head in (".", ".."):
                    continue
                if head.endswith(".py"):
                    names.add(head[:-3])
                else:
                    names.add(head)
    return names


def dir_size(path: str) -> int:
    total = 0
    for current, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(current, name))
            except OSError:
                pass
    return total


def build(source: str, dest: str, trace_json: str) -> int:
    site_packages = os.path.join(source, "Lib", "site-packages")
    with open(trace_json, encoding="utf-8") as handle:
        toplevels = set(json.load(handle).get("toplevels") or [])

    name_to_dist: dict[str, str] = {}
    dist_modules: dict[str, set[str]] = {}
    dist_info_dirs: dict[str, str] = {}
    for entry in sorted(os.listdir(site_packages)):
        full = os.path.join(site_packages, entry)
        if not (entry.endswith(".dist-info") and os.path.isdir(full)):
            continue
        dist = entry[: -len(".dist-info")]
        dist_info_dirs[dist] = full
        modules = read_top_levels(full)
        dist_modules[dist] = modules
        for module in modules:
            name_to_dist.setdefault(module, dist)

    needed_dists: set[str] = set()
    needed_names: set[str] = set()
    for name in toplevels:
        if not name or name.startswith("_"):
            continue
        dist = name_to_dist.get(name)
        if dist:
            needed_dists.add(dist)
        elif os.path.isdir(os.path.join(site_packages, name)) or os.path.isfile(os.path.join(site_packages, name + ".py")):
            needed_names.add(name)
    for dist in needed_dists:
        needed_names.update(dist_modules[dist])

    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    print(f"needed dists: {len(needed_dists)}, top-level names: {len(needed_names)}", flush=True)

    for name in CORE_FILES:
        source_file = os.path.join(source, name)
        if os.path.isfile(source_file):
            shutil.copy2(source_file, os.path.join(dest, name))
        else:
            print(f"WARN missing core file {name}")

    shutil.copytree(os.path.join(source, "DLLs"), os.path.join(dest, "DLLs"))

    stdlib_src = os.path.join(source, "Lib")
    stdlib_dst = os.path.join(dest, "Lib")
    os.makedirs(stdlib_dst)
    for entry in os.listdir(stdlib_src):
        if entry in STDLIB_SKIP:
            continue
        full = os.path.join(stdlib_src, entry)
        target = os.path.join(stdlib_dst, entry)
        if os.path.isdir(full):
            shutil.copytree(full, target)
        elif entry.endswith((".py", ".pyd", ".dll")):
            shutil.copy2(full, target)

    dest_sp = os.path.join(stdlib_dst, "site-packages")

    def ignore_site_packages(directory, names):
        if os.path.normcase(directory) != os.path.normcase(site_packages):
            return []
        ignored = []
        for name in names:
            base = name[:-3] if name.endswith(".py") else name
            if name in needed_names or base in needed_names:
                continue
            if name.endswith(".dist-info"):
                dist = name[: -len(".dist-info")]
                if dist in needed_dists:
                    continue
            elif name.endswith(".pth"):
                # .pth hooks point at optional tooling and break offline runtimes
                continue
            ignored.append(name)
        return ignored

    print("copying site-packages...", flush=True)
    shutil.copytree(site_packages, dest_sp, ignore=ignore_site_packages)
    print("done copying", flush=True)

    total = dir_size(dest)
    print(f"runtime size: {total/1e6:.0f} MB -> {dest}")
    print("dists:", ", ".join(sorted(needed_dists)))
    return 0


if __name__ == "__main__":
    sys.exit(build(sys.argv[1], sys.argv[2], sys.argv[3]))

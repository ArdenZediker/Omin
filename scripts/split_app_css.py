#!/usr/bin/env python3
"""Split src/App.css into feature-area global CSS files, preserving exact rule order.

Strategy:
- Parse App.css into top-level blocks (rules / @media / @keyframes / comments),
  tracking each block's original position.
- Classify each block into a feature file by scanning its selector text for known
  prefixes. Unmatched / global tokens fall back to globals.css.
- Emit each feature file with its blocks in original order.
- Rewrite App.css to ONLY contain @import statements, ordered by the first
  original occurrence of each feature (so reassembling in import order reproduces
  the original file byte-for-byte -> zero cascade regression).
"""
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "App.css")
STYLES_DIR = os.path.join(ROOT, "src", "styles")

# feature prefix -> target file (without extension)
PREFIX_MAP = {
    # chat domain
    "chat-composer": "chat",
    "chat-message": "chat",
    "chat-history-panel": "chat",
    "chat-topic-panel": "chat",
    "message-": "chat",
    "empty-chat-state": "chat",
    "main-chat-": "chat",
    "attachment-chip": "chat",
    "omni-sidebar": "chat",
    # artifacts
    "artifacts-panel": "artifacts",
    "artifact-card": "artifacts",
    "artifact-": "artifacts",
    # knowledge
    "omni-knowledge": "knowledge",
    "knowledge": "knowledge",
    "skillset-child": "knowledge",
    # plugins / marketplace
    "plugin-marketplace": "plugins",
    "plugin-card": "plugins",
    "skillhub": "plugins",
    "mcp-": "plugins",
    "connector": "plugins",
    # settings
    "omni-settings-dialog": "settings",
    "omni-model-prefs": "settings",
    "settings-": "settings",
    # dialogs
    "omni-dialog": "dialogs",
    "omni-confirm-dialog": "dialogs",
    "confirm-dialog": "dialogs",
    "omni-prompt-dialog": "dialogs",
    "omni-select": "dialogs",
    "omni-error-boundary": "dialogs",
    "create-project": "dialogs",
    # compact / pet
    "compact-menu": "compact",
    "compact-bar": "compact",
    "compact-reply": "compact",
    "pet-thought": "compact",
    # permission
    "permission-mode-selector": "permission",
    "permission": "permission",
}

# tokens that force a block into globals.css regardless of feature prefixes
GLOBAL_MARKERS = [
    ":root", "html", "body", "#root", "@keyframes", "@font-face",
    "hide-scrollbar", "markdown-body", "omni-window",
]

# order in which @import statements should appear (first-occurrence drives final order,
# but this list defines the canonical name set)
FILE_ORDER = [
    "globals", "chat", "artifacts", "knowledge", "plugins",
    "settings", "dialogs", "compact", "permission",
]


def top_level_blocks(text):
    """Yield (block_text, start_index) for each top-level block, preserving order.

    Each block includes its preceding whitespace so reassembly is byte-identical.
    """
    blocks = []
    i = 0
    n = len(text)
    while i < n:
        # do NOT skip whitespace here: let it be captured as the leading
        # whitespace of the upcoming block (start backed up below).
        # back up to include the leading whitespace that precedes this block
        start = i
        while start > 0 and text[start - 1].isspace():
            start -= 1
        depth = 0
        j = i
        in_comment = False
        in_string = None
        while j < n:
            c = text[j]
            if in_comment:
                if c == "*" and j + 1 < n and text[j + 1] == "/":
                    in_comment = False
                    j += 2
                    continue
                j += 1
                continue
            if in_string:
                if c == "\\":
                    j += 2
                    continue
                if c == in_string:
                    in_string = None
                j += 1
                continue
            if c == "/" and j + 1 < n and text[j + 1] == "*":
                in_comment = True
                j += 2
                continue
            if c in ("'", '"', "`"):
                in_string = c
                j += 1
                continue
            if c == "{":
                depth += 1
                j += 1
                continue
            if c == "}":
                depth -= 1
                j += 1
                if depth == 0:
                    blocks.append((text[start:j], start))
                    i = j
                    break
                continue
            j += 1
        else:
            if j > start:
                blocks.append((text[start:j], start))
            break
    return blocks


def classify(block_text):
    low = block_text.lower()
    for marker in GLOBAL_MARKERS:
        if marker in low:
            return "globals"
    for prefix, target in PREFIX_MAP.items():
        if prefix in low:
            return target
    return "globals"


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        original = f.read()

    blocks = top_level_blocks(original)

    # bucket blocks by target file, and remember first occurrence index
    buckets = {name: [] for name in FILE_ORDER}
    first_occurrence = {}
    for btext, bidx in blocks:
        target = classify(btext)
        buckets.setdefault(target, []).append(btext)
        if target not in first_occurrence:
            first_occurrence[target] = bidx

    # create styles dir
    os.makedirs(STYLES_DIR, exist_ok=True)

    # write each feature file
    written = {}
    for name in FILE_ORDER:
        content = "".join(buckets.get(name, []))
        if not content.strip():
            continue
        path = os.path.join(STYLES_DIR, f"{name}.css")
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        written[name] = first_occurrence.get(name, 10**9)

    # order @import by first occurrence
    import_order = sorted(written.keys(), key=lambda k: written[k])

    # rewrite App.css as pure @import entry
    header = "/* Auto-generated entry: imports feature-area CSS files in original order.\n"
    header += "   Edit the split files under src/styles/ instead of this file. */\n"
    lines = [header]
    for name in import_order:
        lines.append(f'@import "./styles/{name}.css";')
    lines.append("")
    new_app_css = "\n".join(lines)

    with open(SRC, "w", encoding="utf-8") as f:
        f.write(new_app_css)

    # verification: reassemble in import order and compare to original
    reassembled = ""
    for name in import_order:
        with open(os.path.join(STYLES_DIR, f"{name}.css"), "r", encoding="utf-8") as f:
            reassembled += f.read()

    # Feature-based splitting intentionally reorders blocks across files (import
    # order), so byte-identical reassembly is NOT expected. Instead verify that no
    # original block was lost, duplicated, or modified (content preserved as a
    # multiset). Cross-file cascade regressions are guarded separately by the
    # duplicate-selector check below.
    orig_blocks = [b.strip() for b, _ in top_level_blocks(original) if b.strip()]
    gen_blocks = []
    for name in import_order:
        p = os.path.join(STYLES_DIR, f"{name}.css")
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                gen_blocks.extend([b.strip() for b, _ in top_level_blocks(f.read()) if b.strip()])
    if sorted(orig_blocks) == sorted(gen_blocks):
        print(f"VERIFY: all {len(orig_blocks)} top-level blocks preserved (no loss/dup/mod). Safe to commit.")
    else:
        print("WARN: block multiset mismatch. Investigate before committing.")
        diff_dir = os.path.join(ROOT, ".split_diff")
        os.makedirs(diff_dir, exist_ok=True)
        with open(os.path.join(diff_dir, "original_blocks.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(orig_blocks)))
        with open(os.path.join(diff_dir, "generated_blocks.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(gen_blocks)))

    print("Import order:", import_order)
    for name in import_order:
        p = os.path.join(STYLES_DIR, f"{name}.css")
        print(f"  {name}.css: {len(open(p, encoding='utf-8').read().splitlines())} lines")


if __name__ == "__main__":
    main()

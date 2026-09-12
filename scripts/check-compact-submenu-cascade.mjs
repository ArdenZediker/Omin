/**
 * 级联顺序校验：确认 .compact-submenu--left / --right 的 `left` 声明
 * 在打包后的 CSS 里位于 .compact-submenu 基础规则之后。
 *
 * 背景：两者选择器权重相同（0,1,0）。若基础规则的 `left: calc(100% + 4px)`
 * 后置，就会覆盖 --left 的 `left: auto`，同时 left/right/width 三者齐全时
 * LTR 会丢弃 right —— 二级菜单便永远只往右展开并被右缘裁切。
 *
 * 用法：node scripts/check-compact-submenu-cascade.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postcss from "postcss";

const ENTRY = resolve(process.cwd(), "src/App.css");

function flatten(file, seen = new Set()) {
  const absolute = resolve(file);
  if (seen.has(absolute)) return [];
  seen.add(absolute);

  const root = postcss.parse(readFileSync(absolute, "utf8"), { from: absolute });
  const out = [];
  for (const node of root.nodes) {
    if (node.type === "atrule" && node.name === "import") {
      const target = /["']([^"']+)["']/.exec(node.params)?.[1];
      // 跳过包导入（tailwindcss 等），只内联相对路径。
      if (target && target.startsWith(".")) {
        out.push(...flatten(resolve(dirname(absolute), target), seen));
      }
      continue;
    }
    out.push({ file: absolute, node });
  }
  return out;
}

const flat = flatten(ENTRY);
const tracked = new Set([".compact-submenu", ".compact-submenu--left", ".compact-submenu--right", ".compact-submenu--appearance", ".compact-submenu--fit"]);
const hits = [];

flat.forEach((entry, index) => {
  if (entry.node.type !== "rule") return;
  const selectors = entry.node.selectors ?? [];
  if (!selectors.some((selector) => tracked.has(selector.trim()))) return;
  entry.node.walkDecls("left", (decl) => {
    hits.push({ index, selector: selectors.join(", "), value: decl.value, from: entry.file });
  });
});

if (hits.length === 0) {
  console.error("FAIL: 没找到任何 .compact-submenu* 的 left 声明。");
  process.exit(1);
}

const lastBase = [...hits].reverse().find((hit) => hit.selector.includes(".compact-submenu:") === false && hit.selector.trim() === ".compact-submenu");
const lastLeft = [...hits].reverse().find((hit) => hit.selector.includes("--left"));
const lastRight = [...hits].reverse().find((hit) => hit.selector.includes("--right"));

const problems = [];
if (!lastLeft) problems.push(".compact-submenu--left 没有 left 声明");
if (!lastRight) problems.push(".compact-submenu--right 没有 left 声明");
if (lastBase && lastLeft && lastBase.index > lastLeft.index) {
  problems.push(`.compact-submenu 的 left 声明（第 ${lastBase.index} 条）排在 .compact-submenu--left 之后，会覆盖翻边`);
}
if (lastLeft && lastLeft.value.trim() !== "auto") {
  problems.push(`.compact-submenu--left 的 left 应为 auto，实际为 ${lastLeft.value}`);
}
if (lastRight && lastRight.value.trim() !== "calc(100% + 4px)") {
  problems.push(`.compact-submenu--right 的 left 应为 calc(100% + 4px)，实际为 ${lastRight.value}`);
}

const describe = (hit) => (hit ? `第 ${hit.index} 条 ${hit.selector} { left: ${hit.value} }  <- ${hit.from.replace(process.cwd(), ".")}` : "(缺失)");
console.log("最后一条 .compact-submenu      的 left：", describe(lastBase));
console.log("最后一条 .compact-submenu--left  的 left：", describe(lastLeft));
console.log("最后一条 .compact-submenu--right 的 left：", describe(lastRight));

if (problems.length > 0) {
  console.error("\nFAIL:");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log("\nPASS: 二级菜单展开方向修饰符在级联中生效。");

#!/usr/bin/env bash
# M0-1 机械验收（独立验收用，不采信 NPC 自述）
# 用法：bash scripts/verify-m0.sh   （在项目根目录执行）
set -uo pipefail
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
no(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=========== M0-1 机械验收 ==========="
echo "[1] 目录结构"
for d in src/core src/adapters src/plugin test; do
  [ -d "$d" ] && ok "$d 存在" || no "$d 缺失"
done

echo "[2] 关键文件"
for f in package.json tsconfig.json src/core/types.ts src/core/registry.ts; do
  [ -f "$f" ] && ok "$f 存在" || no "$f 缺失"
done

echo "[3] 内核无平台依赖（跑机器铁律，不再单条 grep）"
if NO_COLOR=1 FORCE_COLOR=0 npx vitest run test/architecture.test.ts >/tmp/.m0_arch.log 2>&1; then
  ok "architecture.test.ts 全绿（含 16 条逃检测试）"
else
  no "architecture.test.ts 失败（内核可能绕过铁律）"; tail -15 /tmp/.m0_arch.log | sed 's/^/      /'
fi

echo "[4] 内核数据结构三件"
if [ -f src/core/types.ts ]; then
  for pair in "CapabilityEntry|ModelEntry" "StagePlan|StagePlan" "LedgerEntry|LedgerEvent"; do
    a="${pair%%|*}"; b="${pair##*|}"
    if grep -q "$a" src/core/types.ts || grep -q "$b" src/core/types.ts; then
      ok "types.ts 含 $a（或 $b）"
    else
      no "types.ts 缺 $a/$b"
    fi
  done
else no "types.ts 不存在"; fi

echo "[5] ESM 声明"
grep -q '"type": *"module"' package.json 2>/dev/null && ok "package.json 为 ESM" || no "package.json 非 ESM"

echo "[6] npm test（真实执行）"
if NO_COLOR=1 FORCE_COLOR=0 npm test >/tmp/.m0_test.log 2>&1; then
  ok "npm test 通过（$(grep -oE 'Tests +[0-9]+ passed' /tmp/.m0_test.log 2>/dev/null | head -1)）"
else
  no "npm test 失败（详见 /tmp/.m0_test.log 末尾）"; tail -5 /tmp/.m0_test.log | sed 's/^/      /'
fi

echo "[7] npm run build（真实执行，M-8：构建只在这里跑，不塞进 npm test）"
if npm run build >/tmp/.m0_build.log 2>&1; then
  ok "npm run build 通过"
else
  # M-8: tsc 的真实错误必须打出来，别吞
  no "npm run build 失败"; grep -E "error TS|error" /tmp/.m0_build.log | head -10 | sed 's/^/      /'
fi
# M-8：构建根目录里不许有任何测试探针（历史上架构测试把探针写进 src/core，
# 该文件存在时 tsc 确定性失败 TS2307，于是"闸门偶发误红"）
if find src -name '__escape_probe.ts' -o -name '.probe' | grep -q .; then
  no "src/ 里残留测试探针（会破坏 tsc 构建）"
else
  ok "src/ 无测试探针残留（构建根干净）"
fi

echo "[8] 包入口可被 Node 解析（A-1）"
if [ -f dist/index.js ] && node --input-type=module -e "await import('./dist/index.js')" >/tmp/.m0_entry.log 2>&1; then
  ok "dist/index.js 存在且可 import"
else
  no "dist/index.js 缺失或不可 import"; tail -3 /tmp/.m0_entry.log 2>/dev/null | sed 's/^/      /'
fi

echo "[9] npm run typecheck（A-3：vitest 不做类型检查，必须独立成闸）"
if npm run typecheck >/tmp/.m0_typecheck.log 2>&1; then
  ok "typecheck 0 error"
else
  no "typecheck 有错"; grep -E "error TS" /tmp/.m0_typecheck.log | head -5 | sed 's/^/      /'
fi

echo "======================================"
echo "结果：PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { echo "判定：✅ 机械验收通过"; exit 0; } || { echo "判定：❌ 不通过"; exit 1; }

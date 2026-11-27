#!/usr/bin/env bash
# =============================================================================
# run-tests.sh — 我方（灰狼侧）网关回归入口 v1.0.0（2026-11-16 融入 r4 套件）
#
# 由来：
#   - 测试套件来自对侧「配置无关」版（tests/*.py 与参考包逐字节一致）；
#   - 与我方差异：我方是**完整版**（main.py + admin_ui / api_keys / router_plan /
#     router_strategies 共 7 个 py 模块），所以临时树要复制全部模块（r4 原脚本只拷 3 件）；
#   - r4 原脚本里「main.py sha256 必须等于包内 MANIFEST」的硬闸门不适用：我方 main.py 已
#     融入 r4 三处默认值，与任何一方的包指纹都不再逐字节相同。此处只做**语法/存在性**闸门。
#
# 用法：
#   ./run-tests.sh                      # 用我方现行配置（config/routing.json + upstreams.json）
#   ./run-tests.sh --config-dir DIR     # 用指定配置（DIR 内需有 routing.json + upstreams.json）
#   ./run-tests.sh --clean              # 跑完删临时树（默认保留，便于排查）
#   ./run-tests.sh --log-dir DIR        # 日志目录（默认 /tmp/router-tests-logs）
#
# 判据：两段 Ran 数一致 / OK（0 失败 0 错误）/ 失败集合一致；**不核对固定用例数**（用例数随配置用例展开而变）
#   （＝2026-11-20 的 439 ＋ L5 单源化新增 17 例 tests/test_price_attest.py）。
#   439 的构成：较旧期待值多出的 21 例＝ tests/test_price_sync.py(8) + tests/test_price_resolver.py(13)；
#   原注释 367 与旧期待值口径均已过期，以本条为准。
#   ⚠️ 已知：我方配置价目表未填时，`test_capabilities_occupancy.py::
#      test_priced_models_filled_and_unpriced_null` 会因「没有已填价模型」红 1 条
#      （用例夹具自检；已与对侧确认，属配置待补，非代码问题）。
#
# 🔭 两段口径（2026-11-20 起，P1b）——两者应给出**同一失败集合**：
#   ① 主段「配置无关判据」＝临时树（只拷 routing.json + upstreams.json，**不拷 pricebook.json**）。
#      对侧交付包走的就是这一段（包里没有内部价目件），所以它必须保持"配置无关"；
#   ② 第二段「生产等价」＝树内 `discover`（用 $SRC_ROOT 的真实 config/，**含 config/pricebook.json**）。
#      差别在于：meta 无有效价时，main 会用 pricebook 的有效报价补价（main.py:1486-1528，
#      用户 2026-11-19 授权 ⇒ 单一真源＝pricebook，不猜价）。于是同一个用例可能在两段给出不同结论。
#      **两段失败集合/Ran 数不一致本身就是告警**——那正是 L5「价格双源一致性」要暴露的东西。
#      第二段固定用 $SRC_ROOT 的现行配置，不受 --config-dir 影响（--config-dir 只作用于主段）。
#      第二段只读：只跑用例，不写 config/数据/upstreams（2026-11-20 实测 mtime 全程未变）。
#
# ⚠️ 负向对照（canary）不并入任何一段的计数：
#   `tests/guardrail_price_assertions.py` 是**故意红**的负向对照——它把构造的坏输入
#   直接喂给判据（`tests/price_assertions.py`）且不捕获 AssertionError。
#   它的**文件名不带 `test` 前缀** ⇒ `discover -s tests`（默认 `-p 'test*.py'`）天然跳过，
#   两段因此都不收它，也不需要"从临时树摘除"的额外机制。两段跑完后本脚本单独跑它，
#   并**要求它非 0 退出**：它若变绿，说明判据被放水成恒真，本脚本当场判红
#   （对应 task-4「转绿不能靠把负向用例改绿」）。
#
# 退出码：0＝两段全绿、失败集合一致、且负向对照按预期红；否则非 0（见文末汇总）：
#   1＝有失败且两段一致；4＝负向对照变绿（判据可能被放水）；5＝两段不一致（L5 双源告警）。
# =============================================================================
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC_ROOT="$SCRIPT_DIR"
CONFIG_SRC=""
LOG_DIR="/tmp/router-tests-logs"
CLEAN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) CONFIG_SRC="${2:-}"; shift 2 ;;
    --log-dir)    LOG_DIR="${2:-}"; shift 2 ;;
    --clean)      CLEAN=1; shift ;;
    -h|--help)    sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

# 我方完整版模块清单（缺一即 import 失败）
# [2026-11-21 T1] 新增 router_live.py：admin_ui.py 顶层 import 它（/admin/live 路由），
#   临时树缺此文件会让 admin_ui import 失败 ⇒ 必须一并拷进临时树。
MODULES="main.py price_state.py local_unavailable.py occupancy_host.py admin_ui.py api_keys.py router_plan.py router_strategies.py router_deciders.py router_shadow.py price_resolver.py router_live.py"
for m in $MODULES; do
  [ -f "$SRC_ROOT/$m" ] || { echo "❌ 缺模块：$SRC_ROOT/$m" >&2; exit 2; }
done

# 负向对照（canary）：**故意红**，文件名不带 test 前缀 ⇒ discover 天然不收；
# 主回归跑完后本脚本单独跑它并要求非 0 退出（见文末「负向对照」段）。
GUARDRAIL="guardrail_price_assertions.py"
[ -f "$SRC_ROOT/tests/$GUARDRAIL" ] || { echo "❌ 缺负向对照：$SRC_ROOT/tests/$GUARDRAIL" >&2; exit 2; }

TMP=$(mktemp -d /tmp/router-tests-hulang-XXXXXXXX) || exit 3
mkdir -p "$TMP/config" "$TMP/tests" "$LOG_DIR"

mkdir -p "$TMP/scripts"
cp $MODULES "$TMP/" || exit 3
cp "$SRC_ROOT/scripts/price_sync.py" "$TMP/scripts/" || exit 3
cp -a "$SRC_ROOT/tests"/*.py "$TMP/tests/" || exit 3

if [ -n "$CONFIG_SRC" ]; then
  CONFIG_DIR=$(cd "$CONFIG_SRC" && pwd) || { echo "❌ --config-dir 不存在：$CONFIG_SRC" >&2; exit 2; }
  [ -f "$CONFIG_DIR/routing.json" ]  || { echo "❌ $CONFIG_DIR/routing.json 缺失" >&2; exit 2; }
  [ -f "$CONFIG_DIR/upstreams.json" ] || { echo "❌ $CONFIG_DIR/upstreams.json 缺失" >&2; exit 2; }
  cp "$CONFIG_DIR/routing.json"  "$TMP/config/routing.json"
  cp "$CONFIG_DIR/upstreams.json" "$TMP/upstreams.json"
  CONFIG_DESC="自定义配置：$CONFIG_DIR"
else
  [ -f "$SRC_ROOT/config/routing.json" ] || { echo "❌ 缺 $SRC_ROOT/config/routing.json" >&2; exit 2; }
  [ -f "$SRC_ROOT/upstreams.json" ]     || { echo "❌ 缺 $SRC_ROOT/upstreams.json" >&2; exit 2; }
  cp "$SRC_ROOT/config/routing.json" "$TMP/config/routing.json"
  cp "$SRC_ROOT/upstreams.json"      "$TMP/upstreams.json"
  CONFIG_DESC="我方现行配置：$SRC_ROOT/config/routing.json + upstreams.json"
fi

STAMP=$(date +%Y%m%d-%H%M%S)-$$
LOG="$LOG_DIR/run-${STAMP}.log"

{
  echo "===== 网关回归（完整版 + r4 配置无关套件）====="
  echo "时间    : $(date -Iseconds)"
  echo "代码树  : $SRC_ROOT"
  echo "main.py : $(sha256sum "$SRC_ROOT/main.py" | awk '{print $1}')"
  echo "配置    : $CONFIG_DESC"
  echo "临时树  : $TMP"
  echo "期望    : 两段 Ran 数一致 / 全绿 / 失败集合一致（用例数随配置不同，不核固定数）"
  echo "python  : $(python3 -V 2>&1)"
  echo "=============================================="
} | tee "$LOG"

# 失败集合 / Ran 数提取（两段判据比对用；Ran 行**只取计数**，耗时不同不算不一致）
_failset() { grep -hE '^(FAIL|ERROR): ' "$1" | sed -E 's/^[A-Z]+: //' | sort -u; }
_ranline() { grep -oE '^Ran [0-9]+ tests' "$1" | tail -1; }

cd "$TMP" || exit 3
python3 -m unittest discover -s tests -v 2>&1 | tee -a "$LOG"
TMP_RC=${PIPESTATUS[0]}
TMP_RAN=$(_ranline "$LOG")
TMP_FAILS=$(_failset "$LOG")
TMP_N=$(printf '%s\n' "$TMP_FAILS" | grep -c . || true)

# ---- 第二段：生产等价（树内 discover，含 config/pricebook.json）---------------
INTREE_LOG="$LOG_DIR/run-${STAMP}-intree.log"
( cd "$SRC_ROOT" && python3 -m unittest discover -s tests -v ) >"$INTREE_LOG" 2>&1
INTREE_RC=$?
INTREE_RAN=$(_ranline "$INTREE_LOG")
INTREE_FAILS=$(_failset "$INTREE_LOG")
INTREE_N=$(printf '%s\n' "$INTREE_FAILS" | grep -c . || true)

INCONSISTENT=0
if [ "$TMP_RAN" != "$INTREE_RAN" ] || [ "$TMP_FAILS" != "$INTREE_FAILS" ]; then
  INCONSISTENT=1
fi

{
  echo "----------------------------------------------"
  echo "① 主段 配置无关（临时树，不拷 pricebook）：$TMP_RAN"
  echo "   临时树 红 = $TMP_N ；树内 红 = $INTREE_N （不一致即告警）"
  echo "② 第二段 生产等价（树内，含 pricebook）：$INTREE_RAN"
  echo "   退出码   : 临时树=$TMP_RC 树内=$INTREE_RC"
  if [ "$INCONSISTENT" = "1" ]; then
    echo "   ⚠️ 两段失败集合不一致："
    diff <(printf '%s\n' "$TMP_FAILS") <(printf '%s\n' "$INTREE_FAILS") | sed 's/^/      /'
  else
    echo "   失败集合 : 两段一致"
  fi
  echo "   日志     : $INTREE_LOG"
} | tee -a "$LOG"

if [ "$INCONSISTENT" = "1" ]; then
  echo "❌ 双源不一致：临时树与树内的失败集合/Ran 数不同（L5 价格双源告警，见上文 diff）" | tee -a "$LOG"
fi

# ---- 负向对照（canary）：期望**非 0 退出**，证明判据仍有约束力 ----------------
NEG_LOG="$LOG_DIR/run-${STAMP}-negative.log"
( cd "$SRC_ROOT" && python3 -m unittest "tests.${GUARDRAIL%.py}" -v ) >"$NEG_LOG" 2>&1
NEG_RC=$?
{
  echo "----------------------------------------------"
  echo "负向对照 : tests/$GUARDRAIL（故意红；不带 test 前缀，两段都不收）"
  echo "退出码   : $NEG_RC（判据：非 0 ⇒ 判据有约束力；0 ⇒ 已被放水）"
  echo "日志     : $NEG_LOG"
} | tee -a "$LOG"

# ---- 汇总退出码（优先级 4 > 5 > 1 > 0）--------------------------------------
#   0＝两段全绿、失败集合一致、canary 按预期红；1＝有失败但两段一致；
#   5＝两段失败集合/Ran 不一致（双源告警，即使同时有失败也优先报 5）；
#   4＝负向对照变绿（判据可能被放水，最高优先）。
RC=0
if [ "$TMP_RC" != "0" ] || [ "$INTREE_RC" != "0" ]; then RC=1; fi
if [ "$INCONSISTENT" = "1" ]; then RC=5; fi
if [ "$NEG_RC" = "0" ]; then
  echo "❌ 负向对照未按预期红：判据可能已被放宽成恒真（见 $NEG_LOG）" | tee -a "$LOG"
  RC=4
fi

{
  echo "=============================================="
  echo "退出码 : $RC（0=两段全绿且集合一致；1=有失败；4=canary 变绿；5=两段不一致）"
  echo "日志   : $LOG"
  echo "树内   : $INTREE_LOG"
  echo "临时树 : $TMP"
} | tee -a "$LOG"

if [ "$CLEAN" = "1" ]; then
  case "$TMP" in
    /tmp/router-tests-hulang-*) rm -rf "$TMP" ;;
    *) echo "⚠️ 跳过清理（路径不在预期前缀内）：$TMP" >&2 ;;
  esac
fi

exit "$RC"

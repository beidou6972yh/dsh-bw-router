#!/usr/bin/env bash
# 把 dsh-bw-router 装进本机 DSH（默认 dry-run，只打印步骤；--yes 才真做）
# ⚠️ 安装需要重启 `dsh web`，会断开当前会话——请在老大在场、且你知道如何恢复时执行。
#
# 2026-10-25 修正（灰狼异环境试装反馈，两处都已在真实宿主验证）：
#   1. patch 条目的缩进必须跟随目标文件（顶层数组=0 缩进），写死 2 空格会把配置弄坏、网页起不来；
#   2. 入口名必须是子路径 `dsh-bw-router/dsh`，写包名会打到只做 re-export 的库入口，装上等于没装。
#   追加后用 `dsh --dump-config` 自检：合成失败就还原备份、不重启，绝不把坏配置留在盘上。
#
# 2026-10-26 升级/幂等修正（灰狼机器装着旧版，升级会被追加重复条目）：
#   1. 追加前判重 `id: dsh-bw-router`，命中就跳过追加（不报错、不重写 patch）；
#   2. `--yes` 下软链指向别处时用 `ln -sfn` 覆盖并明示「覆盖旧装软链：旧 → 新」；
#      patch 已有旧条目时只换软链、不重写 patch。
#   3. 升级路径（patch 未改、无备份）自检失败时**不删软链**：还原安装前目标（原先
#      没有软链才撤），文案按有无备份分支说明；旧版在这条路径上撤链 + 谎称「已还原
#      patch」，比装之前更坏（灰狼回执 P2-5）。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-/opt/dsh-home}"
PROFILE="${PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
LINK="$PROFILE_DIR/node_modules/dsh-bw-router"
ENTRY="dsh-bw-router/dsh"
MODE="${1:-}"

say(){ printf '%s\n' "$*"; }
step(){ printf '\n== %s ==\n' "$*"; }

# 目标 patch 文件用的缩进（0 或 2 空格）。判不出来就按顶层 0 缩进。
patch_indent(){
  if grep -qE '^- insert:' "$PATCH" 2>/dev/null; then printf ''
  elif grep -qE '^  - insert:' "$PATCH" 2>/dev/null; then printf '  '
  else printf ''; fi
}

# patch 里是否已有本插件条目（升级幂等的判重口径，与 dry-run 文案一致）。
patch_has_entry(){
  grep -qE 'id: dsh-bw-router' "$PATCH" 2>/dev/null
}

# 把 insert 条目追加到 patch 末尾；缩进跟随文件。已有条目则跳过（不报错、不重复写）。
append_entry(){
  if patch_has_entry; then
    say '  ℹ️ patch 已有 dsh-bw-router 条目，跳过追加'
    return 0
  fi
  local indent
  indent="$(patch_indent)"
  printf '\n%s- insert:\n%s    - id: dsh-bw-router\n%s      name: %s\n' "$indent" "$indent" "$indent" "$ENTRY" >> "$PATCH"
}

# 安装前的软链状态，供失败还原使用：none=原本没有 / symlink=指向 PREV_LINK / other=实体
PREV_LINK=''
PREV_LINK_KIND='none'

# 软链插件到 profile node_modules；旧装指向别处就覆盖，并明示旧 → 新。
link_plugin(){
  local old=''
  PREV_LINK=''
  PREV_LINK_KIND='none'
  if [ -L "$LINK" ]; then
    old="$(readlink "$LINK" 2>/dev/null || true)"
    if [ -n "$old" ]; then PREV_LINK="$old"; PREV_LINK_KIND='symlink'; fi
  elif [ -e "$LINK" ]; then
    old='(实体文件/目录，非软链)'
    PREV_LINK="$old"; PREV_LINK_KIND='other'
  fi
  mkdir -p "$(dirname "$LINK")" 2>/dev/null || true
  ln -sfn "$ROOT" "$LINK" || return 3
  if [ -n "$old" ] && [ "$old" != "$ROOT" ]; then
    say "  🔁 覆盖旧装软链：$old → $ROOT"
  elif [ -n "$old" ]; then
    say "  ✅ 软链已就位（目标未变）：$LINK -> $ROOT"
  else
    say "  ✅ 已建软链：$LINK -> $ROOT"
  fi
  return 0
}

# 自检失败时把软链恢复到安装前状态：原目标→指回去；原本没有→撤掉；实体→不动。
restore_link(){
  case "$PREV_LINK_KIND" in
    symlink)
      if ln -sfn "$PREV_LINK" "$LINK"; then
        say "  ↩️ 软链已还原到安装前目标：$PREV_LINK"
      else
        say "  ⚠️ 软链还原失败，请手工执行：ln -sfn $PREV_LINK $LINK"
      fi
      ;;
    other)
      say "  ⏸️ 安装前该路径是实体文件/目录，未删除也未改动：$LINK"
      ;;
    *)
      if rm -f "$LINK"; then say "  ↩️ 撤掉本次新建的软链：$LINK"; fi
      ;;
  esac
}

# 配置合成自检：能跑 dsh 就真跑，跑不了就明确说"未自检"，不假装通过。
dump_config_ok(){
  if ! command -v dsh >/dev/null 2>&1; then
    say '  ⚠️ 本机无 dsh 命令，跳过 dump-config 自检（重启前请手工验一次）'
    return 0
  fi
  dsh --profile "$PROFILE" --dump-config >/dev/null 2>&1
}

step "0. 前置检查"
for f in "$PATCH" "$PROFILE_DIR"; do
  [ -e "$f" ] && say "  ✅ 存在: $f" || { say "  ❌ 缺失: $f"; exit 2; }
done
say "  项目根: $ROOT"
say "  带 DSH 字段: $(grep -c '"dsh"' "$ROOT/package.json" 2>/dev/null || echo 0)（应为 1）"
say "  patch 缩进判定: '$(patch_indent)'（空=顶层 0 缩进）"

step "1. 构建"
say "  cd $ROOT && npm ci && npm run build"

step "2. 软链插件到 profile node_modules"
say "  ln -sfn $ROOT $LINK"
say "  旧软链指向别处则覆盖，并打印「覆盖旧装软链：<旧目标> → <新目标>」"

step "3. 在 cordis.patch.yml 末尾追加 insert 条目（缩进跟随文件）"
say "  - insert:"
say "      - id: dsh-bw-router"
say "        name: $ENTRY"
say "  判重: grep -qE 'id: dsh-bw-router' $PATCH 命中 → 打印「patch 已有 dsh-bw-router 条目，跳过追加」，不重复写"
say "  升级语义: patch 已有旧条目时只换软链、不重写 patch（可反复执行）"
say "  追加后自检: dsh --profile $PROFILE --dump-config >/dev/null"

step "4. 重启 dsh web（会断当前会话！）"
say "  重启前先备份: cp $PATCH $PATCH.bak-\$(date +%Y%m%d-%H%M)-装路由插件前"
say "  验证: curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/router/state（期望 200）"

step "5. 回滚（任何一步不对就执行）"
say "  rm -f $LINK"
say "  cp $PATCH.bak-… $PATCH（还原到安装前）"
say "  重启 dsh web"

if [ "$MODE" = "--yes" ] && [ "${I_KNOW_IT_RESTARTS:-0}" = "1" ]; then
  step "真执行（用户已确认 I_KNOW_IT_RESTARTS=1）"
  cd "$ROOT" && npm ci && npm run build || exit 3
  link_plugin || exit 3
  BACKUP=""
  if patch_has_entry; then
    say '  ℹ️ patch 已有 dsh-bw-router 条目，跳过追加（升级只换软链、不重写 patch）'
  else
    BACKUP="$PATCH.bak-$(date +%Y%m%d-%H%M)-装路由插件前-xiaobang"
    cp "$PATCH" "$BACKUP" || exit 3
    append_entry
  fi
  if ! dump_config_ok; then
    if [ -n "$BACKUP" ]; then
      if cp "$BACKUP" "$PATCH"; then
        say "  ❌ 配置合成失败：已还原 patch（备份 $BACKUP）并恢复软链，未重启"
      else
        say "  ❌ 配置合成失败：且 patch 还原失败！请手工执行 cp $BACKUP $PATCH，未重启"
      fi
    else
      # 升级路径：patch 从未被写（备份为空），所以既不该删软链、也不该说「已还原 patch」。
      say '  ❌ 配置合成失败：本次未写 patch（升级路径，patch 逐字节未改），软链按安装前状态恢复，未重启'
    fi
    restore_link
    exit 4
  fi
  if [ -n "$BACKUP" ]; then
    say "  ✅ 软链与 patch 已写入并通过合成自检（备份在 $BACKUP）"
  else
    say '  ✅ 仅更新软链（patch 未改）并通过合成自检'
  fi
  say "  ▶ 现在请重启 dsh web，刷新页面看输入框下方是否出现计划卡；随后 curl /router/state 应为 200"
else
  say "  （dry-run：未做任何改动。真执行请加 --yes 并设 I_KNOW_IT_RESTARTS=1）"
fi

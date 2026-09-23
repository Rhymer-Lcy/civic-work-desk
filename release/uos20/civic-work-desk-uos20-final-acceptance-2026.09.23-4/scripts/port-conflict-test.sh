#!/bin/sh
# 端口冲突验收脚本 — 安全地验证「8765 被占用时启动器怎么做」
#
#   sh port-conflict-test.sh
#
# ## 为什么要用脚本，而不是手工造冲突
#
# 手工造冲突的风险在于收尾：测试完之后要结束的那个进程，得确保就是刚才自己起的那个。本脚本
# 自己启动占位进程、自己记住它的 PID、结束前再核对一次它的命令行，所以**不会碰到任何无关进程**。
#
# ## 它检验启动器的四个行为
#
#   1. 明确报出端口被占用；
#   2. 不结束占用端口的进程（脚本随后验证占位进程仍然存活）；
#   3. 不改用别的端口；
#   4. 不打开浏览器 —— 用一个假的 xdg-open 来验证，真浏览器不会被启动。

set -eu

HOST="127.0.0.1"
PORT="8765"
ORIGIN="http://127.0.0.1:8765/"

PASS=0
FAIL=0

check() {
  if [ "$1" = yes ]; then
    printf '  [PASS] %s\n' "$2"
    PASS=$((PASS + 1))
  else
    printf '  [FAIL] %s\n' "$2"
    FAIL=$((FAIL + 1))
  fi
}

printf '端口冲突验收 — CivicWorkDesk\n'
printf '======================================================\n\n'

command -v busybox >/dev/null 2>&1 || {
  printf '错误：未找到 busybox，无法执行本测试。\n' >&2
  exit 2
}
# 用绝对路径调用，避免 PATH 里没有 ~/.local/bin 时测的是别的东西。
LAUNCHER="$HOME/.local/bin/civic-work-desk"
STATUS_CMD="$HOME/.local/bin/civic-work-desk-status"
STOP_CMD="$HOME/.local/bin/civic-work-desk-stop"
[ -x "$LAUNCHER" ] || {
  printf '错误：未找到 %s，请先安装。\n' "$LAUNCHER" >&2
  exit 2
}

WORK="$(mktemp -d 2>/dev/null || echo "/tmp/civic-portconflict-$$")"
mkdir -p "$WORK/decoy-root" "$WORK/fakebin"
printf 'decoy\n' >"$WORK/decoy-root/index.html"

DECOY_PID=""

# 只结束本脚本自己启动的占位进程，并且在结束前再核对一次它的命令行。
stop_decoy() {
  if [ -n "$DECOY_PID" ] && kill -0 "$DECOY_PID" 2>/dev/null; then
    cmd=""
    if [ -r "/proc/$DECOY_PID/cmdline" ]; then
      cmd="$(tr '\0' ' ' <"/proc/$DECOY_PID/cmdline" 2>/dev/null || true)"
    fi
    case "$cmd" in
      *"$WORK/decoy-root"*)
        kill "$DECOY_PID" 2>/dev/null || true
        i=0
        while [ "$i" -lt 10 ]; do
          kill -0 "$DECOY_PID" 2>/dev/null || break
          sleep 1
          i=$((i + 1))
        done
        printf '已结束占位进程（PID %s）。\n' "$DECOY_PID"
        ;;
      *)
        printf '注意：PID %s 的命令行已不是本脚本的占位进程，未做任何处理。\n' "$DECOY_PID"
        ;;
    esac
  fi
  DECOY_PID=""
}

cleanup() {
  stop_decoy
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- 1. 先让端口空出来
printf '第 1 步：停止本程序自己的服务，让端口空出来\n'
if [ -x "$STOP_CMD" ]; then
  "$STOP_CMD" >/dev/null 2>&1 || true
fi

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[.:]$PORT " && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q "[.:]$PORT " && return 0
    return 1
  fi
  return 1
}

if port_busy; then
  printf '错误：端口 %s 仍被占用，且不是本程序的服务。\n' "$PORT" >&2
  printf '为避免影响无关进程，测试中止。请先自行确认占用者：\n' >&2
  printf '    ss -ltnp | grep %s\n' "$PORT" >&2
  exit 2
fi
printf '  端口 %s 已空闲。\n\n' "$PORT"

# ---------------------------------------------------------------- 2. 起一个占位进程
printf '第 2 步：启动一个本脚本自己的占位进程占住 %s\n' "$PORT"
busybox httpd -f -p "$HOST:$PORT" -h "$WORK/decoy-root" >"$WORK/decoy.log" 2>&1 &
DECOY_PID=$!
sleep 2

if ! kill -0 "$DECOY_PID" 2>/dev/null; then
  printf '错误：占位进程未能启动，测试无法继续。输出：\n' >&2
  sed 's/^/    /' "$WORK/decoy.log" >&2
  exit 2
fi
printf '  占位进程 PID %s（文档根目录 %s）\n\n' "$DECOY_PID" "$WORK/decoy-root"

# ---------------------------------------------------------------- 3. status 怎么说
printf '第 3 步：civic-work-desk-status 的判断\n'
STATUS_OUT="$("$STATUS_CMD" 2>&1 || true)"
printf '%s\n' "$STATUS_OUT" | sed 's/^/    /'
if printf '%s' "$STATUS_OUT" | grep -q "占用"; then
  check yes "status 报告端口被其他进程占用"
else
  check no "status 应当报告端口被其他进程占用"
fi
if printf '%s' "$STATUS_OUT" | grep -q "未运行"; then
  check yes "status 没有把占位进程误认成本程序的服务"
else
  check no "status 不应把占位进程当成本程序的服务"
fi
printf '\n'

# ---------------------------------------------------------------- 4. 启动器怎么做
printf '第 4 步：调用启动器（带一个假的 xdg-open，真浏览器不会被打开）\n'

# 假 xdg-open：被调用就留下一个标记文件。用它来证明「没有打开浏览器」，
# 而不是靠 --no-browser 参数绕过这一步。
cat >"$WORK/fakebin/xdg-open" <<'FAKE'
#!/bin/sh
printf '%s\n' "$1" >>"$CIVIC_FAKE_XDG_MARKER"
FAKE
chmod 755 "$WORK/fakebin/xdg-open"

CIVIC_FAKE_XDG_MARKER="$WORK/xdg-open-was-called"
export CIVIC_FAKE_XDG_MARKER

set +e
LAUNCH_OUT="$(PATH="$WORK/fakebin:$PATH" "$LAUNCHER" 2>&1)"
LAUNCH_RC=$?
set -e

printf '%s\n' "$LAUNCH_OUT" | sed 's/^/    /'
printf '    （退出码 %s）\n\n' "$LAUNCH_RC"

printf '第 5 步：判定\n'

if [ "$LAUNCH_RC" -ne 0 ]; then
  check yes "启动器以非零退出码失败（而不是假装成功）"
else
  check no "启动器应当以非零退出码失败"
fi

if printf '%s' "$LAUNCH_OUT" | grep -q "$PORT"; then
  check yes "错误信息里指名了端口 $PORT"
else
  check no "错误信息应当指名端口 $PORT"
fi

if printf '%s' "$LAUNCH_OUT" | grep -q "占用"; then
  check yes "错误信息说明了端口被占用"
else
  check no "错误信息应当说明端口被占用"
fi

# 最要紧的一条：占位进程必须还活着。
if kill -0 "$DECOY_PID" 2>/dev/null; then
  check yes "占用端口的进程仍然存活（启动器没有结束它）"
else
  check no "占用端口的进程被结束了 —— 这是严重缺陷，请立即记录"
fi

if [ -f "$CIVIC_FAKE_XDG_MARKER" ]; then
  check no "启动器打开了浏览器（不应该）：$(cat "$CIVIC_FAKE_XDG_MARKER")"
else
  check yes "启动器没有打开浏览器"
fi

# 没有改用别的端口：占位进程还在 8765 上，而启动器不应留下一个属于自己的、正在运行的服务。
# 两个候选位置都查，因为运行状态目录取决于 XDG_RUNTIME_DIR 是否可用。
LEFTOVER=no
for candidate in \
  "${XDG_RUNTIME_DIR:-/nonexistent}/civic-work-desk/httpd.pid" \
  "$HOME/.local/state/civic-work-desk/run/httpd.pid"; do
  [ -s "$candidate" ] || continue
  recorded="$(cat "$candidate" 2>/dev/null || true)"
  [ -n "$recorded" ] || continue
  if kill -0 "$recorded" 2>/dev/null; then
    LEFTOVER=yes
    printf '  [note] %s 记录了存活进程 %s\n' "$candidate" "$recorded"
  fi
done
if [ "$LEFTOVER" = no ]; then
  check yes "没有遗留正在运行的服务（也就没有改用别的端口）"
else
  check no "启动器留下了一个正在运行的服务（可能改用了别的端口）"
fi

if printf '%s' "$LAUNCH_OUT" | grep -q "$ORIGIN"; then
  printf '  [note] 输出中出现了规范地址，属正常提示。\n'
fi

# ---------------------------------------------------------------- 6. 恢复正常服务
#
# 本测试一开始停掉了 CivicWorkDesk 自己的服务，好让占位进程能占住端口。测完必须把它恢复，
# 否则后面「状态与停止命令」那一节就无从测起——停止一个本来就没在运行的服务，什么也证明不了。
printf '\n第 6 步：移除占位进程，恢复 CivicWorkDesk 正常服务\n'
stop_decoy
sleep 1

set +e
RESTORE_OUT="$("$LAUNCHER" --no-browser 2>&1)"
RESTORE_RC=$?
set -e
printf '%s\n' "$RESTORE_OUT" | sed 's/^/    /'

if [ "$RESTORE_RC" -eq 0 ]; then
  check yes "CivicWorkDesk 服务已恢复（--no-browser，未打开浏览器）"
else
  check no "未能恢复 CivicWorkDesk 服务" "退出码 $RESTORE_RC"
fi

set +e
"$STATUS_CMD" >/dev/null 2>&1
RESTORE_STATUS_RC=$?
set -e
if [ "$RESTORE_STATUS_RC" -eq 0 ]; then
  check yes "恢复后健康检查通过（后续可以正常测试 status / stop）"
else
  check no "恢复后健康检查未通过" "status 退出码 $RESTORE_STATUS_RC"
fi

printf '\n======================================================\n'
printf '通过 %s 项，失败 %s 项。\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf 'RESULT: PASS\n'
  printf '\n本地服务现在处于运行状态，请继续做「状态与停止命令」一节。\n'
  exit 0
fi
printf 'RESULT: FAIL —— 请把上面整段输出回传。\n'
exit 1

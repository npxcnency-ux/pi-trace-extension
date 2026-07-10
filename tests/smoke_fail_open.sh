#!/usr/bin/env bash
# Fail-open 冒烟测试：验证 pi-trace-extension 在恶劣条件下不会崩 pi。
#
# 前提：pi ≥ 0.79.x 装好，能非交互跑（cat prompt | pi ...）
# 修复姿态：
#   1. 正常路径：session 结束后 events.jsonl 有内容
#   2. 只读目录：pi 不崩，扩展进 disabled 静默丢事件
#
# 用法：
#     bash tests/smoke_fail_open.sh
#
# 退出码：0 = 全过；非 0 = 至少一项失败
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACES="$HOME/.pi/agent/traces"
STDOUT=/tmp/pi-smoke-stdout
PROMPT="ping"

# macOS 没有 timeout，用 perl 兜底
tmout() { perl -e '$SIG{ALRM}=sub{kill 9,$$;exit 124}; alarm shift; exec @ARGV' "$@"; }

pass=0
fail=0
check() {
    local name="$1"; local ok="$2"; local detail="${3:-}"
    if [[ "$ok" == "1" ]]; then
        echo "  ✓ $name"
        pass=$((pass + 1))
    else
        echo "  ✗ $name  $detail" >&2
        fail=$((fail + 1))
    fi
}
latest_session() { ls -td "$TRACES"/*/ 2>/dev/null | head -1; }
run_pi() {
    (cd "$REPO" && printf '%s\n/exit\n' "$PROMPT" | tmout 60 pi -e .) >"$STDOUT" 2>&1
    echo $?
}

echo "== Test 1: 正常路径 =="
before=$(latest_session)
rc=$(run_pi)
after=$(latest_session)
check "pi exit 0" "$([[ $rc == 0 ]] && echo 1 || echo 0)" "rc=$rc"
check "新 session 目录出现" "$([[ "$before" != "$after" ]] && echo 1 || echo 0)"
if [[ -n "$after" && "$before" != "$after" ]]; then
    ev="${after}events.jsonl"
    check "events.jsonl 存在" "$([[ -f "$ev" ]] && echo 1 || echo 0)"
    if [[ -f "$ev" ]]; then
        lines=$(wc -l < "$ev" | tr -d ' ')
        check "events.jsonl 有内容 (lines>3)" "$([[ $lines -gt 3 ]] && echo 1 || echo 0)" "lines=$lines"
    fi
fi
echo

echo "== Test 2: traces 目录只读 (触发 C2 mkdir 失败路径) =="
orig_mode=$(stat -f '%p' "$TRACES" 2>/dev/null | tail -c 4)
chmod 555 "$TRACES"
rc=$(run_pi)
chmod "$orig_mode" "$TRACES"
check "pi 未崩溃 (rc in {0,124})" "$([[ $rc == 0 || $rc == 124 ]] && echo 1 || echo 0)" "rc=$rc"
if grep -qE 'uncaughtException|UnhandledPromiseRejection' "$STDOUT"; then
    check "stderr 无未捕获异常" 0 "见 $STDOUT"
else
    check "stderr 无未捕获异常" 1
fi
echo

echo "----"
echo "通过: $pass  失败: $fail"
[[ $fail -eq 0 ]]

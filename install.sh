#!/bin/bash
# 一键安装 qqbot-music-share 到本机 DSH + qq-bridge
# 用法: bash install.sh [qq-bridge目录]
set -euo pipefail
QB=${1:-/root/workspace/qq-bridge}
PROFILE=/root/.dsh/profiles/web
RESTRICT="$QB/plugins/qq-agent-presets/qq-tool-restrict.mjs"
NODE_BIN=${NODE_BIN:-/usr/local/lib/nodejs/node-v24.22.1-linux-x64/bin/node}

[ -d "$QB" ] || { echo "找不到 qq-bridge 目录: $QB"; exit 1; }
[ -d "$PROFILE" ] || { echo "找不到 DSH profile: $PROFILE"; exit 1; }

echo "=== 1. 复制 MCP server"
cp src/mcp-music.js "$QB/src/mcp-music.js"

echo "=== 2. 注册到 DSH"
python3 - "$PROFILE/cordis.patch.yml" "$QB/src/mcp-music.js" "$NODE_BIN" <<'PY'
import sys
cfg, src, node = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(cfg).read()
if 'mcp-music' in s:
    print('  已注册，跳过')
else:
    s += f"""

# === music MCP BEGIN（qqbot-music-share）===
- insert:
    - id: mcp-music
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: music
        transport: stdio
        command: '{node}'
        args:
          - '{src}'
        toolCallTimeoutMs: 60000
# === music MCP END ===
"""
    open(cfg, 'w').write(s)
    print('  已注册 mcp-music')
PY

echo "=== 3. 放行工具前缀（QQ 里才不会被白名单拒绝）"
if [ -f "$RESTRICT" ]; then
  python3 - "$RESTRICT" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if "mcp__music__" in s:
    print('  已放行，跳过')
else:
    a = 'const SAFE_PREFIXES = ['
    i = s.index(a) + len(a)
    s = s[:i] + "\n  'mcp__music__'," + s[i:]
    open(p, 'w').write(s)
    print('  已加入 SAFE_PREFIXES')
PY
else
  echo "  ⚠️ 没找到 qq-agent-presets，跳过白名单（非 qq-bridge 环境可忽略）"
fi

echo "=== 4. 语法检查"
"$NODE_BIN" --check "$QB/src/mcp-music.js" && echo "  ok"

echo "=== 5. 重启 DSH"
systemctl restart dsh-web
sleep 10
systemctl is-active dsh-web

echo
echo "✅ 安装完成。在 QQ 里试："
echo "   结衣，放首歌 稻香"
echo "   结衣，搜一下 周杰伦 晴天"

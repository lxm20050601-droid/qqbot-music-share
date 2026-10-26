# qqbot-music-share 🎵

让 **DeepSeek Harness（DSH）+ qq-bridge 的 QQ 机器人**能分享音乐：AI 搜歌 → 发一张**可点开播放的网易云音乐卡片**（OneBot `music` 段）。

> 实测环境：Ubuntu 22.04 + SnowLuma（Docker）+ qq-bridge + DSH 0.2.1

## 效果

```
你：结衣，放首歌 稻香
结衣：（发来一张网易云音乐卡片，点开就能听）
```

```
你：搜一下 周杰伦 晴天
结衣：找到 3 首：
     1. 晴天 — 周杰伦《叶惠美》4分29秒
     ...
```

## 原理

```
AI (DSH)
  └─ MCP 工具 qq_share_music / qq_search_music
       ├─ 搜索：网易云 cloudsearch API（无需登录）
       └─ 发送：OneBot HTTP /send_private_msg|send_group_msg
                message = [{type:"music", data:{type:"163", id:"<songId>"}}]
```

- 不需要 API Key（搜索接口公开）
- 不需要桥接改动：直接走 SnowLuma 的 OneBot HTTP
- 卡片发不出去时**自动降级为文字 + 链接**

## 安装（3 步，1 分钟）

```bash
git clone https://github.com/lxm20050601-droid/qqbot-music-share.git
cd qqbot-music-share
bash install.sh /root/workspace/qq-bridge
```

`install.sh` 会：
1. 复制 `src/mcp-music.js` 到 `qq-bridge/src/`
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 注册 MCP（`mcp-music`）
3. 在 `qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 里放行 `mcp__music__`
4. `node --check` + 重启 `dsh-web`

> ⚠️ 第 3 步很关键：qq-bridge 有工具白名单，不放行的话 AI 调用会被拒（`不在 QQ 桥接白名单内`）。

## 配置（环境变量，都有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SNOWLUMA_HTTP_URL` | `http://127.0.0.1:3000` | SnowLuma OneBot HTTP 地址 |
| `SNOWLUMA_TOKEN` | 从 `qq-bridge/config.json` 读 | OneBot accessToken |
| `BRIDGE_CONFIG` | `/root/workspace/qq-bridge/config.json` | 读取 token 的路径 |
| `MUSIC_API` | `https://music.163.com/api/cloudsearch/pc` | 搜索接口 |

## 工具说明

### `qq_search_music`

| 参数 | 说明 |
|---|---|
| `query` | 歌名，或 `歌名 歌手` |
| `count` | 1~10，默认 5 |

返回：`id / name / artists / album / durationSec / url`

### `qq_share_music`

| 参数 | 说明 |
|---|---|
| `key` | `group:群号` 或 `private:QQ号`（AI 从唤醒提示里拿到） |
| `query` | 要分享的歌 |

### `qq_music_taste`（v1.1+）

查看**当前角色**的音乐口味（来自 `src/music-taste.json`）。
返回：`role / desc / keywords / moods`

### `qq_share_favorite_music`（v1.1+）

按**角色人设**挑一首"自己喜欢的歌"发出去。

| 参数 | 说明 |
|---|---|
| `key` | 会话 key |
| `mood` | 可选：`happy` / `sad` / `calm` |
| `dryRun` | 只返回候选、不发送 |

它会：
1. 读 `state/current-role.json` 拿到当前角色（如 `caster`）
2. 从该角色的品味关键词里随机选 2~3 个去搜
3. 过滤掉伴奏/翻唱/remix（`avoid` 正则）
4. 在候选里**随机**挑一首（像真的"自己选的"）
5. 发音乐卡片；失败降级文字

## 角色口味配置（`src/music-taste.json`）

```json
{
  "avoid": "伴奏|翻唱|cover|remix|dj版|深情版",
  "profiles": {
    "caster": {
      "desc": "由比滨结衣：温柔日常感，偏日系女声",
      "keywords": ["やなぎなぎ 春擬き", "ClariS コネクト", "日系 女声 温柔"],
      "moods": {
        "happy": ["元气 日系 女声"],
        "sad":   ["安静 钢琴 日语"],
        "calm":  ["治愈 轻音乐"]
      }
    }
  }
}
```

- `key` = `qq-bridge/roles/<角色名>.md` 的文件名（也是 `current-role.json` 里的 `role`）
- 没配的角色自动用 `default`
- 想给新角色加口味：加一条 profile 即可，**不用改代码**

## 验证

```bash
# 直接手测 MCP（不需要 AI）
cd /root/workspace/qq-bridge
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"qq_search_music","arguments":{"query":"稻香"}}}' \
| /usr/local/lib/nodejs/node-v24.22.1-linux-x64/bin/node src/mcp-music.js
```

## 卸载

```bash
rm /root/workspace/qq-bridge/src/mcp-music.js
# 删掉 cordis.patch.yml 里的 mcp-music 块、以及白名单里的 'mcp__music__',
systemctl restart dsh-web
```

## 已知限制

- **网易云搜索接口是非官方的**，返回结构可能变化；接口挂了会自动报错但不会崩
- 只能搜到**网易云有版权**的曲子；QQ 音乐独家的搜不到
- 卡片能否播放取决于对方 QQ 客户端（部分版本会显示为链接卡片）
- 版权：只做分享链接/卡片，不下载、不转存音频

## License

MIT

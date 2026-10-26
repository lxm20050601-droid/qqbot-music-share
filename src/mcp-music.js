// qqbot-music-share — 让 AI 在 QQ 里分享音乐（网易云音乐卡片）
// MCP server（stdio）：qq_search_music / qq_share_music
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'

const ONEBOT = (process.env.SNOWLUMA_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const BRIDGE_CONFIG = process.env.BRIDGE_CONFIG || '/root/workspace/qq-bridge/config.json'
const MUSIC_API = process.env.MUSIC_API || 'https://music.163.com/api/cloudsearch/pc'

function snowlumaToken() {
  if (process.env.SNOWLUMA_TOKEN) return process.env.SNOWLUMA_TOKEN
  try {
    const cfg = JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf8'))
    return cfg?.snowluma?.accessToken || ''
  } catch {
    return ''
  }
}

async function searchMusic(query, limit = 5) {
  const url = `${MUSIC_API}?s=${encodeURIComponent(query)}&type=1&limit=${Math.min(10, Math.max(1, limit))}`
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      referer: 'https://music.163.com/',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`音乐搜索失败 HTTP ${res.status}`)
  const j = await res.json()
  const songs = (j?.result?.songs || []).map((s) => ({
    id: String(s.id),
    name: s.name,
    artists: (s.ar || []).map((a) => a.name).join(' / '),
    album: s.al?.name || '',
    durationSec: Math.round((s.dt || 0) / 1000),
    url: `https://music.163.com/song?id=${s.id}`,
  }))
  return rankSongs(songs, query)
}

// 相关性排序：歌手命中 > 歌名命中；翻唱/伴奏降权
function rankSongs(songs, query) {
  const toks = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const score = (s) => {
    const name = String(s.name || '').toLowerCase()
    const artists = String(s.artists || '').toLowerCase()
    let n = 0
    for (const t of toks) {
      if (name === t) n += 10
      else if (name.includes(t)) n += 4
      if (artists.includes(t)) n += 8
    }
    if (/原唱|深情版|cover|翻唱|伴奏|remix|dj/i.test(s.name + ' ' + s.album)) n -= 6
    return n
  }
  return songs
    .map((s, i) => ({ s, i, v: score(s) }))
    .sort((a, b) => (b.v - a.v) || (a.i - b.i))
    .map((x) => x.s)
}

async function onebot(action, params) {
  const tok = snowlumaToken()
  const res = await fetch(`${ONEBOT}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.status !== 'ok') {
    throw new Error(body?.wording || body?.retcode || `HTTP ${res.status}`)
  }
  return body
}

function parseKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key || '').trim())
  if (!m) throw new Error('key 格式应为 group:群号 或 private:QQ号')
  return { kind: m[1], id: Number(m[2]) }
}

async function sendMusic(key, song) {
  const { kind, id } = parseKey(key)
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const target = kind === 'group' ? { group_id: id } : { user_id: id }
  // QQ 音乐卡片（163 类型，id 为网易云歌曲 ID）
  return onebot(action, { ...target, message: [{ type: 'music', data: { type: '163', id: song.id } }] })
}

async function sendTextFallback(key, text) {
  const { kind, id } = parseKey(key)
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const target = kind === 'group' ? { group_id: id } : { user_id: id }
  return onebot(action, { ...target, message: [{ type: 'text', data: { text } }] })
}

const server = new McpServer({ name: 'music-share', version: '1.0.0' })

server.tool(
  'qq_search_music',
  '在网易云音乐里搜索歌曲，返回歌名/歌手/专辑/时长/链接。用户说“搜首歌/找某首歌”时用。',
  {
    query: z.string().describe('歌名，或“歌名 歌手”'),
    count: z.number().int().min(1).max(10).optional().describe('返回数量，默认 5'),
  },
  async ({ query, count = 5 }) => {
    try {
      const songs = await searchMusic(query, count)
      if (!songs.length) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, songs: [], note: '没搜到，换个关键词试试' }) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, songs }, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `搜索失败：${e?.message ?? e}` }], isError: true }
    }
  },
)

server.tool(
  'qq_share_music',
  '在 QQ 里分享一首歌（发网易云音乐卡片，对方可以直接点开听）。用户说“放首歌/分享首歌/来一首XX”时用。会自动搜第一首匹配结果。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    query: z.string().describe('歌名，或“歌名 歌手”'),
  },
  async ({ key, query }) => {
    try {
      const songs = await searchMusic(query, 3)
      if (!songs.length) {
        return { content: [{ type: 'text', text: `没搜到「${query}」，换个关键词再试。` }], isError: true }
      }
      const song = songs[0]
      try {
        const r = await sendMusic(key, song)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              sent: 'music-card',
              song,
              messageId: r?.data?.message_id ?? null,
              note: '已发出音乐卡片；只有 messageId 非空才算真发出去',
            }, null, 2),
          }],
        }
      } catch (cardErr) {
        // 卡片发不出去时退化成文字链接
        const text = `分享一首歌：${song.name} — ${song.artists}《${song.album}》\n${song.url}`
        const r2 = await sendTextFallback(key, text)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              sent: 'text-fallback',
              song,
              cardError: String(cardErr?.message ?? cardErr),
              messageId: r2?.data?.message_id ?? null,
            }, null, 2),
          }],
        }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `分享失败：${e?.message ?? e}` }], isError: true }
    }
  },
)

await server.connect(new StdioServerTransport())

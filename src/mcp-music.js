// qqbot-music-share — 让 AI 在 QQ 里分享音乐（网易云音乐卡片）
// MCP server（stdio）：qq_search_music / qq_share_music
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'

const ONEBOT = (process.env.SNOWLUMA_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const BRIDGE_CONFIG = process.env.BRIDGE_CONFIG || '/root/workspace/qq-bridge/config.json'
const ROLE_STATE = process.env.ROLE_STATE || '/root/workspace/qq-bridge/state/current-role.json'
const MUSIC_API = process.env.MUSIC_API || 'https://music.163.com/api/cloudsearch/pc'

function currentRole() {
  try {
    const j = JSON.parse(fs.readFileSync(ROLE_STATE, 'utf8'))
    return j?.role || null
  } catch {
    return null
  }
}

function loadTaste() {
  try {
    return JSON.parse(fs.readFileSync(new URL('./music-taste.json', import.meta.url), 'utf8'))
  } catch {
    return { avoid: '', profiles: { default: { desc: '', keywords: ['轻音乐'], moods: {} } } }
  }
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

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

server.tool(
  'qq_music_taste',
  '查看当前角色（人设）的音乐口味：喜欢什么风格、什么心情听什么。用户问“你喜欢听什么歌/你的歌单”时用。',
  {},
  async () => {
    const role = currentRole()
    const taste = loadTaste()
    const p = taste.profiles?.[role] || taste.profiles?.default || { desc: '', keywords: [], moods: {} }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          role: role || '(未设置，使用默认)',
          desc: p.desc,
          keywords: p.keywords || [],
          moods: p.moods || {},
          hint: '想让我推荐/分享时用 qq_share_favorite_music；想先看看候选就传 dryRun=true',
        }, null, 2),
      }],
    }
  },
)

server.tool(
  'qq_share_favorite_music',
  '按当前角色人设分享一首“自己喜欢的歌”（从角色口味里挑，发网易云音乐卡片）。用户说“来首你喜欢的歌/分享首你爱听的/放首歌吧”时用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    mood: z.enum(['happy', 'sad', 'calm']).optional().describe('可选心情：开心/难过/安静'),
    dryRun: z.boolean().optional().describe('只返回候选、不发送（想先确认时用）'),
  },
  async ({ key, mood, dryRun }) => {
    try {
      const role = currentRole()
      const taste = loadTaste()
      const profile = taste.profiles?.[role] || taste.profiles?.default
      if (!profile) return { content: [{ type: 'text', text: '没有可用的音乐口味配置' }], isError: true }
      const pool = (mood && profile.moods?.[mood]?.length ? profile.moods[mood] : profile.keywords) || []
      if (!pool.length) return { content: [{ type: 'text', text: '这个角色还没配置音乐口味' }], isError: true }
      const avoid = taste.avoid ? new RegExp(taste.avoid, 'i') : null

      // 从几个关键词里取候选，挑质量最好的几首
      let candidates = []
      for (const q of shuffle(pool).slice(0, 3)) {
        try {
          const songs = await searchMusic(q, 6)
          candidates.push(...songs.filter((s) => !avoid || !avoid.test(s.name + ' ' + s.album)))
        } catch { /* 单个关键词失败不影响 */ }
        if (candidates.length >= 6) break
      }
      if (!candidates.length) return { content: [{ type: 'text', text: '这几首没搜到合适的，换个心情或稍后再试。' }], isError: true }

      // 去重后随机挑一首（像真的“自己选的”）
      const seen = new Set()
      const uniq = candidates.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
      const pick = uniq[Math.floor(Math.random() * Math.min(3, uniq.length))]

      if (dryRun) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, dryRun: true, role, mood: mood || null, pick, candidates: uniq.slice(0, 6) }, null, 2),
          }],
        }
      }

      try {
        const r = await sendMusic(key, pick)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, sent: 'music-card', role, mood: mood || null, song: pick, messageId: r?.data?.message_id ?? null }, null, 2),
          }],
        }
      } catch (cardErr) {
        const text = `分享一首我喜欢的：${pick.name} — ${pick.artists}《${pick.album}》\n${pick.url}`
        const r2 = await sendTextFallback(key, text)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, sent: 'text-fallback', cardError: String(cardErr?.message ?? cardErr), song: pick, messageId: r2?.data?.message_id ?? null }, null, 2),
          }],
        }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `分享失败：${e?.message ?? e}` }], isError: true }
    }
  },
)

await server.connect(new StdioServerTransport())

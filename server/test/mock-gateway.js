// A stand-in for New API / One API: user search and the two top-up endpoints.
// Run: node test/mock-gateway.js [port]   (default 3000). Logs every top-up.
import http from 'node:http'
const PORT = Number(process.argv[2] ?? 3000)
export const users = [
  { id: 7, username: 'alice', quota: 100000 },
  { id: 8, username: 'bob', quota: 0 },
]
export const topups = []
const send = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
const body = req => new Promise(r => { let t = ''; req.on('data', c => (t += c)); req.on('end', () => r(t ? JSON.parse(t) : {})) })
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.headers.authorization !== 'Bearer gw-admin-token') return send(res, { success: false, message: 'unauthorized' }, 401)
  if (req.method === 'GET' && url.pathname === '/api/user/search') {
    const k = (url.searchParams.get('keyword') ?? '').toLowerCase()
    const items = users.filter(u => u.username.includes(k))
    return send(res, { success: true, data: { items, total: items.length } })   // New API shape; One API returns a bare array
  }
  if (req.method === 'POST' && url.pathname === '/api/user/manage') {           // New API
    const b = await body(req)
    const u = users.find(u => u.id === b.id)
    if (!u || b.action !== 'add_quota' || b.mode !== 'add' || !(b.value > 0)) return send(res, { success: false, message: 'invalid params' })
    u.quota += b.value; topups.push({ kind: 'newapi', id: u.id, value: b.value })
    console.log(`[gateway] +${b.value} quota -> ${u.username} (now ${u.quota})`)
    return send(res, { success: true, message: '' })
  }
  if (req.method === 'POST' && url.pathname === '/api/topup') {                 // One API: AdminTopUp { user_id, quota, remark }
    const b = await body(req)
    const u = users.find(u => u.id === b.user_id)
    if (!u) return send(res, { success: false, message: 'no such user' })
    u.quota += b.quota; topups.push({ kind: 'oneapi', id: u.id, value: b.quota })
    return send(res, { success: true, message: '' })
  }
  send(res, { success: false, message: 'not found' }, 404)
})
if (process.argv[1] && process.argv[1].endsWith('mock-gateway.js')) server.listen(PORT, () => console.log(`mock gateway on :${PORT}`))

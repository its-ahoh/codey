#!/usr/bin/env node
const http = require('node:http')
const help = `Codey computer tools (all access passes through Codey):
  apps
  windows <bundleId>
  observe <windowId>
  act <windowId> '<JSON>'
Examples of action JSON:
  {"tool":"click","x":120,"y":80}
  {"tool":"type_text","text":"Sample note"}
  {"tool":"press_key","key":"Return"}
  {"tool":"hotkey","keys":["cmd","s"]}
  {"tool":"scroll","x":120,"y":80,"direction":"down","amount":3}
Observe before input. Coordinates use the returned window screenshot pixels.
Read screenshot image paths with your agent's image tool. They expire with the task.
Input defaults to background. delivery_mode:"foreground" explicitly allows focus changes.
After input observe again and verify. Do not guess a window ID or click blind.
Codey displays the same observation in Tools > Computer. A user denial must be respected.`
const [action, target, raw] = process.argv.slice(2)
if (!action || action === 'help') { console.log(help); process.exit(0) }
try {
  if (!['apps', 'windows', 'observe', 'act'].includes(action)) throw new Error('Unknown command; run help')
  const command = { action, ...(action === 'windows' ? { bundleId: target } : { window: target }), ...(raw ? { args: JSON.parse(raw) } : {}) }
  if (!process.env.CODEY_COMPUTER_SOCKET || !process.env.CODEY_COMPUTER_TOKEN) throw new Error('Run this tool from an enabled Codey task')
  const req = http.request({ socketPath: process.env.CODEY_COMPUTER_SOCKET, path: '/command', method: 'POST',
    headers: { authorization: `Bearer ${process.env.CODEY_COMPUTER_TOKEN}`, 'content-type': 'application/json' } }, res => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => { console.log(data); if (res.statusCode !== 200) process.exitCode = 1 })
  })
  req.setTimeout(300000, () => req.destroy(new Error('Codey computer request timed out')))
  req.on('error', e => { console.error(e.message); process.exitCode = 1 })
  req.end(JSON.stringify(command))
} catch (e) { console.error(e.message); process.exitCode = 1 }

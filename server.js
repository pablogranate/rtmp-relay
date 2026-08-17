const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const NodeMediaServer = require('node-media-server');

const DEST_FILE = path.join(__dirname, 'destinations.json');
const STREAM_KEY = process.env.STREAM_KEY;
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS;
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HTTP_PORT = Number(process.env.PORT || 8088);

if (!STREAM_KEY || !DASH_PASS) {
  console.error('Faltan env vars: STREAM_KEY y DASH_PASS son obligatorias.');
  process.exit(1);
}

if (!fs.existsSync(DEST_FILE)) fs.writeFileSync(DEST_FILE, '[]');

function loadDestinations() {
  return JSON.parse(fs.readFileSync(DEST_FILE, 'utf8'));
}
function saveDestinations(list) {
  fs.writeFileSync(DEST_FILE, JSON.stringify(list, null, 2));
}
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// --- RTMP relay ---
const nms = new NodeMediaServer({
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
  http: { port: HTTP_PORT + 1, allow_origin: '*' }, // NMS needs an http port; dashboard runs on its own below
});

const activeRelays = {};

nms.on('prePublish', (id, StreamPath) => {
  const key = StreamPath.split('/').pop();
  if (key !== STREAM_KEY) {
    const session = nms.getSession(id);
    session.reject();
  }
});

nms.on('postPublish', (id, StreamPath) => {
  const streamUrl = `rtmp://127.0.0.1:${RTMP_PORT}${StreamPath}`;
  const destinations = loadDestinations().filter((d) => d.enabled);
  activeRelays[id] = destinations.map((d) => {
    const proc = spawn('ffmpeg', ['-i', streamUrl, '-c', 'copy', '-f', 'flv', d.url]);
    proc.stderr.on('data', () => {}); // ponytail: silencia ffmpeg, ver logs con pm2 logs si hace falta debug
    return proc;
  });
  console.log(`Relay iniciado para ${id} -> ${destinations.map((d) => d.name).join(', ')}`);
});

nms.on('donePublish', (id) => {
  (activeRelays[id] || []).forEach((p) => p.kill('SIGKILL'));
  delete activeRelays[id];
});

nms.run();

// --- Dashboard ---
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === DASH_USER && pass && safeEqual(pass, DASH_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="rtmp-relay"');
  res.status(401).send('Auth requerida');
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>RTMP Relay</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse;margin-top:1rem}
td,th{padding:.5rem;border-bottom:1px solid #ddd;text-align:left}
input[type=text]{width:100%;box-sizing:border-box}
form.add{display:grid;grid-template-columns:1fr 2fr auto;gap:.5rem;margin-top:1.5rem}
button{cursor:pointer}
</style></head>
<body>
<h1>RTMP Relay</h1>
<p>Push desde vMix a: <code>rtmp://${req.hostname}:${RTMP_PORT}/live/${STREAM_KEY}</code></p>
<table id="tbl"><thead><tr><th>Activo</th><th>Nombre</th><th>URL</th><th></th></tr></thead><tbody></tbody></table>
<form class="add" id="addForm">
  <input type="text" id="name" placeholder="Nombre (ej: TikTok)" required>
  <input type="text" id="url" placeholder="rtmps://.../STREAM_KEY" required>
  <button type="submit">Agregar</button>
</form>
<script>
async function load() {
  const list = await fetch('/api/destinations').then(r => r.json());
  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = list.map(d => \`
    <tr>
      <td><input type="checkbox" \${d.enabled ? 'checked' : ''} onchange="toggle('\${d.id}', this.checked)"></td>
      <td>\${d.name}</td>
      <td style="font-family:monospace;font-size:.8em">\${d.url}</td>
      <td><button onclick="del('\${d.id}')">Borrar</button></td>
    </tr>\`).join('');
}
async function toggle(id, enabled) {
  await fetch('/api/destinations/' + id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) });
}
async function del(id) {
  if (!confirm('¿Borrar destino?')) return;
  await fetch('/api/destinations/' + id, { method: 'DELETE' });
  load();
}
document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('name').value;
  const url = document.getElementById('url').value;
  await fetch('/api/destinations', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, url }) });
  e.target.reset();
  load();
});
load();
</script>
</body></html>`);
});

app.get('/api/destinations', (req, res) => res.json(loadDestinations()));

app.post('/api/destinations', (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name y url requeridos' });
  const list = loadDestinations();
  list.push({ id: crypto.randomUUID(), name, url, enabled: true });
  saveDestinations(list);
  res.json({ ok: true });
});

app.patch('/api/destinations/:id', (req, res) => {
  const list = loadDestinations();
  const dest = list.find((d) => d.id === req.params.id);
  if (!dest) return res.status(404).end();
  Object.assign(dest, req.body);
  saveDestinations(list);
  res.json({ ok: true });
});

app.delete('/api/destinations/:id', (req, res) => {
  saveDestinations(loadDestinations().filter((d) => d.id !== req.params.id));
  res.json({ ok: true });
});

app.listen(HTTP_PORT, () => console.log(`Dashboard en :${HTTP_PORT}`));

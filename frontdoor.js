const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const TARGET_FILE = path.join(__dirname, 'frontdoor-target.json');
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.FRONTDOOR_DASH_PASS;
const LISTEN_PORT = Number(process.env.FRONTDOOR_PORT || 80);
const LISTEN_HOST = process.env.FRONTDOOR_BIND || '0.0.0.0';
const DASH_PORT = Number(process.env.FRONTDOOR_DASH_PORT || 8089);
// IP/puerto que ven los streamers desde afuera — puede no ser LISTEN_HOST/PORT
// si hay un redirect NAT delante (ej: puerto 80 público -> puerto interno real)
const PUBLIC_HOST = process.env.FRONTDOOR_PUBLIC_HOST || LISTEN_HOST;
const PUBLIC_PORT = Number(process.env.FRONTDOOR_PUBLIC_PORT || LISTEN_PORT);

if (!DASH_PASS) {
  console.error('Falta env var: FRONTDOOR_DASH_PASS es obligatoria.');
  process.exit(1);
}

if (!fs.existsSync(TARGET_FILE)) {
  fs.writeFileSync(TARGET_FILE, JSON.stringify({ host: '', port: 1935 }, null, 2));
}
function loadTarget() {
  return JSON.parse(fs.readFileSync(TARGET_FILE, 'utf8'));
}
function saveTarget(t) {
  fs.writeFileSync(TARGET_FILE, JSON.stringify(t, null, 2));
}
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// --- TCP passthrough: reenvía bytes tal cual al backend configurado ---
// ponytail: forward ciego, no entiende RTMP. Si el backend cambia de IP, el
// próximo connect ya va al nuevo destino, sin reiniciar nada.
const recentLog = []; // últimas conexiones, para ver en el dashboard si algo llegó
function logConn(entry) {
  recentLog.unshift(entry);
  if (recentLog.length > 30) recentLog.length = 30;
}

const server = net.createServer((client) => {
  const target = loadTarget();
  const entry = {
    time: new Date().toISOString(),
    from: client.remoteAddress,
    to: target.host ? `${target.host}:${target.port}` : '(sin destino configurado)',
    bytes: 0,
    status: 'conectando',
  };
  logConn(entry);

  if (!target.host) {
    entry.status = 'error: no hay destino configurado';
    client.destroy();
    return;
  }

  const upstream = net.connect(target.port, target.host, () => {
    entry.status = 'ok';
  });

  client.pipe(upstream);
  upstream.pipe(client);

  client.on('data', (chunk) => { entry.bytes += chunk.length; });

  const closeBoth = (status) => {
    if (status) entry.status = status;
    client.destroy();
    upstream.destroy();
  };
  client.on('error', () => closeBoth('error: cliente'));
  upstream.on('error', () => closeBoth(`error: no llega a ${target.host}:${target.port}`));
  client.on('close', () => closeBoth());
  upstream.on('close', () => closeBoth());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Frontdoor escuchando en ${LISTEN_HOST}:${LISTEN_PORT}`);
});

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
  res.set('WWW-Authenticate', 'Basic realm="rtmp-frontdoor"');
  res.status(401).send('Auth requerida');
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>RTMP Frontdoor</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.85em}
td,th{padding:.4rem;border-bottom:1px solid #ddd;text-align:left}
form.target{display:grid;grid-template-columns:2fr 1fr auto;gap:.5rem;margin-top:1rem}
input{width:100%;box-sizing:border-box}
code{background:#f0f0f0;padding:.1rem .3rem}
</style></head>
<body>
<h1>RTMP Frontdoor</h1>
<p>Cómo cargarlo en OBS / vMix (van en <b>dos campos separados</b>, no todo junto):</p>
<table style="margin-bottom:1rem">
<tr><td><b>Server</b></td><td><code>rtmp://${PUBLIC_HOST}${PUBLIC_PORT === 1935 || PUBLIC_PORT === 80 ? '' : ':' + PUBLIC_PORT}/&lt;app&gt;</code></td></tr>
<tr><td><b>Stream Key</b></td><td><code>&lt;key&gt;</code></td></tr>
</table>
<p style="color:#555;font-size:.9em">&lt;app&gt; y &lt;key&gt; son los que te haya dado la plataforma para ese partido (ej: <code>src</code> y <code>live</code>). No van pegados en una sola URL — si los juntás en el campo Server, la key real no llega y del otro lado no se ve la señal.</p>
<p>Destino actual (a donde se reenvía):</p>
<form class="target" id="targetForm">
  <input type="text" id="host" placeholder="IP del servidor real (ej: 54.232.6.26)" required>
  <input type="number" id="port" placeholder="1935" value="1935" required>
  <button type="submit">Guardar</button>
</form>
<h3>Últimas conexiones</h3>
<table id="tbl"><thead><tr><th>Hora</th><th>Desde</th><th>Hacia</th><th>Bytes</th><th>Estado</th></tr></thead><tbody></tbody></table>
<script>
async function loadTarget() {
  const t = await fetch('/api/target').then(r => r.json());
  document.getElementById('host').value = t.host;
  document.getElementById('port').value = t.port;
}
async function loadLog() {
  const log = await fetch('/api/log').then(r => r.json());
  document.querySelector('#tbl tbody').innerHTML = log.map(e => \`
    <tr>
      <td>\${new Date(e.time).toLocaleTimeString()}</td>
      <td>\${e.from}</td>
      <td>\${e.to}</td>
      <td>\${e.bytes}</td>
      <td>\${e.status}</td>
    </tr>\`).join('');
}
document.getElementById('targetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = document.getElementById('host').value;
  const port = Number(document.getElementById('port').value);
  await fetch('/api/target', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ host, port }) });
  alert('Destino actualizado');
});
loadTarget();
loadLog();
setInterval(loadLog, 5000);
</script>
</body></html>`);
});

app.get('/api/target', (req, res) => res.json(loadTarget()));
app.post('/api/target', (req, res) => {
  const { host, port } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'host y port requeridos' });
  saveTarget({ host, port: Number(port) });
  res.json({ ok: true });
});
app.get('/api/log', (req, res) => res.json(recentLog));

app.listen(DASH_PORT, () => console.log(`Dashboard en :${DASH_PORT}`));

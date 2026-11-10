#!/usr/bin/env node
// Ponte WhatsApp por QR code para o Fluxa CRM.
// Segura a conexão do WhatsApp (como o WhatsApp Web) numa máquina que fica ligada, e É ELA QUE PROCURA O CRM:
// a cada poucos segundos chama o endereço de pareamento, entrega o que chegou, conta o que enviou e leva a próxima mensagem.
// Por isso funciona com o CRM publicado na internet e a ponte atrás de qualquer roteador: sem porta aberta, sem túnel, sem senha.
//
//   cd zap && npm install
//   npm start -- "https://SEU-CRM/hooks/zap/chan_...?k=zap_..."     (o endereço aparece no CRM, em Canais; só na primeira vez)
//   npm start                                                        (depois disso, o endereço fica guardado em zap/dados)
//   npm run mock -- "<endereço>"                                     (sem WhatsApp, para testar o CRM; controle em http://127.0.0.1:8796/__mock/*)
//
// Variáveis: ZAP_CRM (endereço de pareamento), ZAP_DATA (pasta dos dados), ZAP_MIN_INTERVAL_MS (padrão 3000), ZAP_PORT (só no modo simulado).
// Conexão NÃO oficial: o WhatsApp pode bloquear o número. Use um número dedicado e nunca dispare em massa.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = process.argv.includes('--mock') || process.env.ZAP_MOCK === '1';
const DATA = process.env.ZAP_DATA ?? join(HERE, MOCK ? 'dados-mock' : 'dados');
const MIN_INTERVAL = Number(process.env.ZAP_MIN_INTERVAL_MS ?? (MOCK ? 0 : 3000));
const FAST = Number(process.env.ZAP_SYNC_MS ?? 0); // só para teste: força o ritmo das chamadas
mkdirSync(DATA, { recursive: true });
const log = (...a) => console.log(`[zap ${new Date().toLocaleTimeString('pt-BR')}]`, ...a);
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const readJson = (f, def) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { try { writeFileSync(f, JSON.stringify(v)); } catch (e) { log('não gravei', f, e.message); } };

// ===== Pareamento: o endereço que o CRM mostra em Canais =====
const pairFile = join(DATA, 'pareamento.txt');
const given = process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? process.env.ZAP_CRM ?? '';
if (given) writeFileSync(pairFile, given.trim());
const pairing = existsSync(pairFile) ? readFileSync(pairFile, 'utf8').trim() : '';
let SYNC_URL = ''; let KEY = '';
try {
  const u = new URL(pairing); KEY = u.searchParams.get('k') ?? ''; u.search = '';
  SYNC_URL = `${u.toString().replace(/\/$/, '')}/sync`;
} catch { /* sem endereço */ }
if (!SYNC_URL || !KEY) {
  console.error('\nFalta o endereço de pareamento.\nNo CRM: Canais, WhatsApp por QR code, aba Conexão. Copie a linha de comando que aparece lá e rode aqui.\n');
  process.exit(1);
}

// ===== O que ainda falta entregar ao CRM (sobrevive a reinício) =====
const inboxFile = join(DATA, 'recebidas.json');   // mensagens que chegaram e o CRM ainda não confirmou
const sentFile = join(DATA, 'enviadas.json');     // id da mensagem do CRM -> o que aconteceu com ela
let inbox = readJson(inboxFile, []);
const seen = new Set(readJson(join(DATA, 'vistas.json'), []));
const sent = new Map(readJson(sentFile, []));     // id -> { state: 'sending'|'ok'|'fail', external_id?, error?, code?, uncertain?, acked? }
const myIds = new Set([...sent.values()].map((v) => v.external_id).filter(Boolean));
const saveSent = () => { if (sent.size > 800) for (const k of [...sent.keys()].slice(0, sent.size - 500)) sent.delete(k); writeJson(sentFile, [...sent]); };
function received(m) {
  if (!m.id || seen.has(m.id)) return;
  seen.add(m.id); inbox.push(m);
  if (seen.size > 4000) for (const k of [...seen].slice(0, 1000)) seen.delete(k);
  writeJson(inboxFile, inbox); writeJson(join(DATA, 'vistas.json'), [...seen]);
  kick();
}
// Envio que ficou no meio quando a ponte caiu: não dá para saber se saiu.
for (const [id, v] of sent) if (v.state === 'sending') sent.set(id, { state: 'fail', uncertain: true, error: 'A ponte reiniciou no meio do envio.' });

// ===== Estado da conexão =====
const st = { state: 'starting', qr: null, me: null, last_error: null };
const setState = (state, extra = {}) => { Object.assign(st, { state, ...extra }); if (state !== 'qr') st.qr = null; log(state === 'qr' ? 'aguardando a leitura do QR code (ele aparece no CRM, em Canais)' : state === 'open' ? `WhatsApp conectado${st.me?.id ? ` (${st.me.id})` : ''}` : `${state}${extra.last_error ? `: ${extra.last_error}` : ''}`); kick(); };

// ===== WhatsApp de verdade (Baileys) =====
let sock = null; let stopping = false; let retry = 0;
const jidCache = new Map(); const BOOT = Date.now();
function textOf(message) {
  const m = message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message?.viewOnceMessageV2?.message ?? message?.documentWithCaptionMessage?.message ?? message;
  if (!m) return { text: '', kind: 'none' };
  const text = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption
    ?? m.buttonsResponseMessage?.selectedDisplayText ?? m.listResponseMessage?.title ?? m.templateButtonReplyMessage?.selectedDisplayText ?? '';
  const media = m.imageMessage ? 'imagem' : m.videoMessage ? 'vídeo' : m.audioMessage ? 'áudio' : m.documentMessage ? 'documento' : m.stickerMessage ? 'figurinha' : m.locationMessage ? 'localização' : m.contactMessage || m.contactsArrayMessage ? 'contato' : null;
  if (!text && !media) return { text: '', kind: 'none' }; // reação, protocolo, chave de grupo etc.
  return { text, kind: media ? 'media' : 'text', media };
}
function chatOf(key) {
  const jid = String(key?.remoteJid ?? '');
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid === 'status@broadcast') return null;
  // Conta com identificador oculto (LID): o telefone vem no campo alternativo quando o WhatsApp informa.
  const alt = key.remoteJidAlt ?? key.senderPn ?? null;
  if (jid.endsWith('@lid')) return alt && String(alt).includes('@s.whatsapp.net') ? { chat: digits(String(alt).split('@')[0].split(':')[0]), kind: 'phone' } : { chat: `lid:${digits(jid.split('@')[0].split(':')[0])}`, kind: 'lid' };
  if (jid.endsWith('@s.whatsapp.net')) return { chat: digits(jid.split('@')[0].split(':')[0]), kind: 'phone' };
  return null;
}
async function startReal() {
  const b = await import('baileys');
  const makeWASocket = b.makeWASocket ?? b.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = b;
  let logger; try { logger = (await import('pino')).default({ level: process.env.ZAP_LOG ?? 'silent' }); } catch { logger = undefined; }
  const dir = join(DATA, 'sessao');
  const { state: auth, saveCreds } = await useMultiFileAuthState(dir);
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa a versão embutida */ }
  sock = makeWASocket({ auth, version, logger, browser: Browsers.windows('Fluxa CRM'), markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) { const first = st.state !== 'qr'; st.qr = u.qr; if (first) setState('qr', { qr: u.qr, last_error: null }); else kick(); }
    if (u.connection === 'open') { retry = 0; setState('open', { me: { id: digits(String(sock.user?.id ?? '').split('@')[0].split(':')[0]), name: sock.user?.name ?? null }, last_error: null }); }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const why = u.lastDisconnect?.error?.message ?? `código ${code}`;
      if (stopping) return;
      if (code === DisconnectReason.loggedOut) {
        // Desconectado pelo celular: apaga a sessão e volta a mostrar QR.
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* já não existe */ }
        setState('closed', { me: null, last_error: 'Sessão encerrada no celular. Escaneie o QR de novo.' });
        setTimeout(() => startReal().catch(fail), 1500);
        return;
      }
      setState('closed', { last_error: why });
      setTimeout(() => startReal().catch(fail), code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** Math.min(retry++, 5)));
    }
  });
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages ?? []) {
      try {
        if (!m?.message || !m.key?.id) continue;
        const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) * 1000 || Date.now();
        if (ts < BOOT - 120_000) continue; // histórico antigo não é mensagem nova
        const c = chatOf(m.key); if (!c) continue;
        if (m.key.fromMe && myIds.has(m.key.id)) continue; // o que o próprio CRM enviou
        const t = textOf(m.message); if (t.kind === 'none') continue;
        received({ id: m.key.id, chat: c.chat, chat_kind: c.kind, from_me: !!m.key.fromMe, text: t.text, kind: t.kind, media: t.media ?? null, name: m.key.fromMe ? null : m.pushName ?? null, ts });
      } catch (e) { log('mensagem ignorada:', e.message); }
    }
  });
}
const fail = (e) => { setState('closed', { last_error: String(e?.message ?? e).slice(0, 300) }); setTimeout(() => startReal().catch(fail), 15_000); };
async function resolveJid(to) {
  if (String(to).startsWith('lid:')) return `${digits(to)}@lid`;
  const d = digits(to);
  if (jidCache.has(d)) return jidCache.get(d);
  // Confere se o número existe no WhatsApp e pega o identificador certo (números antigos sem o nono dígito, por exemplo).
  const r = await sock.onWhatsApp(d);
  const hit = (r ?? []).find((x) => x?.exists);
  if (!hit) { const err = new Error('Este número não tem WhatsApp.'); err.code = 'not_on_whatsapp'; throw err; }
  jidCache.set(d, hit.jid);
  return hit.jid;
}
async function sendReal(to, text) {
  const jid = await resolveJid(to);
  const r = await sock.sendMessage(jid, { text });
  return String(r?.key?.id ?? '');
}

// ===== Simulado (para testar o CRM sem WhatsApp) =====
const mock = { sent: [], failNext: null };
async function sendMock(to, text) {
  if (mock.failNext) { const f = mock.failNext; mock.failNext = null; const e = new Error(f.message ?? 'falha simulada'); if (f.code) e.code = f.code; throw e; }
  if (digits(to).endsWith('0000')) { const e = new Error('Este número não tem WhatsApp.'); e.code = 'not_on_whatsapp'; throw e; }
  const id = `MOCK${randomBytes(8).toString('hex').toUpperCase()}`;
  mock.sent.push({ id, to, text, at: Date.now() });
  return id;
}

// ===== Enviar o que o CRM mandou: uma vez só, com intervalo mínimo =====
let chain = Promise.resolve(); let lastSendAt = 0;
function deliver(item) {
  const id = String(item.id);
  if (sent.has(id)) { const v = sent.get(id); if (v.state !== 'sending') { v.acked = false; kick(); } return; } // o CRM perguntou de novo: responde com o que já aconteceu
  sent.set(id, { state: 'sending' }); saveSent(); // grava ANTES de enviar: se a ponte cair agora, o resultado fica "incerto", nunca duplicado
  chain = chain.then(async () => {
    const wait = lastSendAt + MIN_INTERVAL - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      if (st.state !== 'open') throw Object.assign(new Error('WhatsApp desconectado.'), { code: 'not_connected' });
      const text = String(item.text ?? ''); if (!text.trim()) throw Object.assign(new Error('Texto vazio.'), { code: 'empty_text' });
      const ext = await (MOCK ? sendMock(item.to, text) : sendReal(item.to, text));
      myIds.add(ext); sent.set(id, { state: 'ok', external_id: ext });
    } catch (e) {
      // Erro com código conhecido aconteceu antes de sair. Sem código, pode ter saído: fica incerto.
      sent.set(id, { state: 'fail', code: e.code ?? null, error: String(e.message ?? e).slice(0, 300), uncertain: !e.code });
    } finally { lastSendAt = Date.now(); saveSent(); kick(); }
  }).catch(() => {});
}

// ===== Conversa com o CRM =====
let timer = null; let syncing = false; let again = false; let backoff = 0; let refused = false;
function kick(ms = 0) { if (syncing) { again = true; return; } clearTimeout(timer); timer = setTimeout(sync, ms); }
async function sync() {
  if (stopping || syncing) return;
  syncing = true; again = false;
  let next = 6000;
  try {
    const results = [...sent].filter(([, v]) => v.state !== 'sending' && !v.acked).slice(0, 10).map(([id, v]) => ({ id, ok: v.state === 'ok', external_id: v.external_id ?? null, error: v.error ?? null, code: v.code ?? null, uncertain: !!v.uncertain }));
    const res = await fetch(SYNC_URL, {
      method: 'POST', signal: AbortSignal.timeout(25_000), headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ v: 1, state: st.state, qr: st.state === 'qr' ? st.qr : null, me: st.me, last_error: st.last_error, mock: MOCK, inbound: inbox.slice(0, 8), results }),
    });
    if (res.status === 401) { if (!refused) log('o CRM recusou este pareamento. Em Canais, gere um endereço novo e rode a ponte com ele.'); refused = true; next = 30_000; }
    else if (!res.ok) { next = Math.min(60_000, 3000 * 2 ** Math.min(backoff++, 4)); log(`o CRM respondeu ${res.status}; tento de novo em ${Math.round(next / 1000)} s`); }
    else {
      const d = await res.json(); backoff = 0;
      if (refused) { refused = false; log('pareamento aceito'); }
      if (d.command === 'logout') {
        log('o canal foi desligado no CRM: saindo do WhatsApp e apagando o pareamento.');
        stopping = true; try { await sock?.logout?.(); } catch { /* já estava fora */ }
        try { rmSync(join(DATA, 'sessao'), { recursive: true, force: true }); rmSync(pairFile, { force: true }); } catch { /* nada */ }
        setTimeout(() => process.exit(0), 500); return;
      }
      const ackIn = new Set(d.inbound_ack ?? []);
      if (ackIn.size) { inbox = inbox.filter((m) => !ackIn.has(m.id)); writeJson(inboxFile, inbox); }
      for (const id of d.results_ack ?? []) { const v = sent.get(id); if (v) v.acked = true; }
      if ((d.results_ack ?? []).length) saveSent();
      for (const item of d.outbound ?? []) deliver(item);
      next = Number(d.next_ms) || 6000;
      if (inbox.length) next = Math.min(next, 800);
    }
  } catch (e) {
    next = Math.min(60_000, 3000 * 2 ** Math.min(backoff++, 4));
    if (backoff <= 1 || backoff % 5 === 0) log(`não alcancei o CRM (${String(e?.message ?? e).slice(0, 80)}); tento de novo em ${Math.round(next / 1000)} s`);
  } finally {
    syncing = false;
    if (!stopping) { clearTimeout(timer); timer = setTimeout(sync, again ? 150 : (FAST || next)); }
  }
}

// ===== Controle do modo simulado (só em 127.0.0.1, só com --mock) =====
if (MOCK) {
  const PORT = Number(process.env.ZAP_PORT ?? 8796);
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => resolve(s)); });
  createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const path = new URL(req.url, 'http://x').pathname;
    let body = {}; try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch { /* corpo livre */ }
    if (path === '/health') return send(200, { ok: true, state: st.state });
    if (!path.startsWith('/__mock/')) return send(404, { error: 'not_found' });
    const c = path.slice('/__mock/'.length);
    if (c === 'state') return send(200, { ...st, inbox: inbox.length, pending: [...sent].filter(([, v]) => !v.acked).length });
    if (c === 'scan') { setState('open', { me: { id: digits(body.number ?? '5511900000000'), name: 'Número simulado' }, last_error: null }); return send(200, st); }
    if (c === 'drop') { setState('closed', { last_error: 'queda simulada' }); return send(200, st); }
    if (c === 'qr') { setState('qr', { qr: `MOCK-QR-${randomBytes(6).toString('hex')}`, me: null }); return send(200, st); }
    if (c === 'inbound') { const m = { id: body.id ?? `IN${randomBytes(8).toString('hex').toUpperCase()}`, chat: body.lid ? `lid:${digits(body.lid)}` : digits(body.from), chat_kind: body.lid ? 'lid' : 'phone', from_me: !!body.from_me, text: String(body.text ?? ''), kind: body.media ? 'media' : 'text', media: body.media ?? null, name: body.name ?? null, ts: body.ts ?? Date.now() }; received(m); return send(200, { ok: true, message: m }); }
    if (c === 'sent') return send(200, { sent: mock.sent });
    if (c === 'fail') { mock.failNext = body; return send(200, { ok: true }); }
    return send(404, { error: 'controle desconhecido' });
  }).listen(PORT, '127.0.0.1', () => log(`modo SIMULADO (sem WhatsApp). Controle em http://127.0.0.1:${PORT}/__mock/*`));
  setState('qr', { qr: `MOCK-QR-${randomBytes(6).toString('hex')}` });
} else {
  startReal().catch(fail);
}
log(`ligada ao CRM em ${new URL(SYNC_URL).origin}. Dados em ${DATA}`);
kick(300);
const bye = () => { stopping = true; clearTimeout(timer); try { sock?.end?.(undefined); } catch { /* nada */ } setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);

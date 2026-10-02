// Interfaz interactiva de exprof (Ink + React, sin paso de build: htm en lugar de JSX).
import path from 'node:path';
import os from 'node:os';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { render, Box, Text, useInput, usePaste, useApp, useWindowSize, useStdout } from 'ink';
import htm from 'htm';
import core from './core.js';
import callLib from './call.js';
import clipboard from './clipboard.js';

const html = htm.bind(React.createElement);
const { Profiler, connectionString, explainError, redact, MASK } = core;
const { parseCall, applyCatalog, buildExec } = callLib;

const MAX_EVENTS = 1000;
const MAX_ACTIVITY = 50;
const MIN_ROWS = 24, MIN_COLS = 80;
const VIA = { RPC: 'green', BATCH: 'magenta', STMT: 'blue', ERR: 'red' };
const SOURCE_COLOR = { 'catálogo': 'green', declarado: 'cyan', inferido: 'yellow' };
const LEVEL = { ok: ['✓', 'green'], info: ['•', 'cyan'], warn: ['!', 'yellow'], error: ['✕', 'red'] };

// ---------- utilidades ----------
const clock = (d = new Date()) => d.toTimeString().slice(0, 8);
const clockMs = (d) => clock(d) + '.' + String(d.getMilliseconds()).padStart(3, '0');
const elapsed = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const fit = (s, n) => {
  s = String(s ?? '');
  if (n <= 0) return '';
  // deja al menos un espacio al final para separar columnas
  return s.length > n - 1 ? s.slice(0, Math.max(0, n - 2)) + '… ' : s.padEnd(n);
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const prettyPath = (p) => {
  if (!p) return '';
  const rel = path.relative(process.cwd(), p);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
};
const describeFilter = (f) => [
  `SP: ${f.all ? 'todos (sin filtro)' : f.patterns.length ? f.patterns.join(', ') : '—'}`,
  `base: ${f.db || 'todas'}`,
  f.app && `app: ${f.app}`,
  f.login && `login: ${f.login}`,
  f.minMs && `≥ ${f.minMs} ms`,
].filter(Boolean).join(' · ');
const wrapText = (s, width, maxLines) => {
  const out = [];
  for (const line of String(s).split('\n')) {
    let rest = line;
    do { out.push(rest.slice(0, width)); rest = rest.slice(width); } while (rest.length);
  }
  if (out.length > maxLines) return [...out.slice(0, maxLines - 1), out[maxLines - 1].slice(0, width - 1) + '…'];
  return out;
};

// ---------- componentes base ----------
function Panel({ title, right, rightColor = 'gray', width, height, color = 'gray', children }) {
  const t = title ? ` ${title} ` : '';
  const r = right ? ` ${right} ` : '';
  const fill = Math.max(0, width - 4 - t.length - r.length);
  return html`
    <${Box} flexDirection="column" width=${width} height=${height} flexShrink=${0}>
      <${Text} wrap="truncate-end">
        <${Text} color=${color}>╭─<//><${Text} bold color="cyan">${t}<//><${Text} color=${color}>${'─'.repeat(fill)}<//><${Text} color=${rightColor}>${r}<//><${Text} color=${color}>─╮<//>
      <//>
      <${Box} borderStyle="round" borderTop=${false} borderColor=${color} flexDirection="column" paddingX=${1} height=${height - 1} overflow="hidden">
        ${children}
      <//>
    <//>`;
}

function Row({ label, children, right, labelWidth = 11 }) {
  return html`
    <${Box} flexDirection="row">
      <${Box} width=${labelWidth} flexShrink=${0}><${Text} color="gray">${label}<//><//>
      <${Box} flexGrow=${1} flexShrink=${1} overflow="hidden"><${Text} wrap="truncate-end">${children}<//><//>
      ${right && html`<${Box} flexShrink=${0} marginLeft=${2}><${Text} wrap="truncate-end">${right}<//><//>`}
    <//>`;
}

const Key = ({ k, label }) => html`<${Text}><${Text} color="cyan" bold>${k}<//><${Text} color="gray"> ${label}  <//><//>`;

function Field({ label, value, focused, mask, cursor, placeholder, width }) {
  const shown = mask ? '•'.repeat(value.length) : value;
  const w = Math.max(10, width - 20); // ancho del modal - borde/padding (4) - etiqueta (15) - cursor
  let body;
  if (focused) {
    const start = Math.max(0, cursor - w + 1);
    const vis = shown.slice(start, start + w);
    const c = cursor - start;
    body = html`<${Text}>${vis.slice(0, c)}<${Text} inverse>${vis[c] || ' '}<//>${vis.slice(c + 1)}<//>`;
  } else {
    body = shown ? html`<${Text}>${fit(shown, w)}<//>` : html`<${Text} color="gray">${fit(placeholder || '', w)}<//>`;
  }
  return html`
    <${Box} flexDirection="row">
      <${Text} color=${focused ? 'cyan' : 'gray'}>${focused ? '› ' : '  '}${fit(label, 13)}<//>
      ${body}
    <//>`;
}

// ---------- formulario modal (conexion / filtro) ----------
function FormModal({ title, fields, initial, onSubmit, onCancel, onRestore, width, notes = [], startField = 0 }) {
  const [values, setValues] = useState(initial);
  const [focus, setFocus] = useState(startField);
  const [cursor, setCursor] = useState((initial[fields[startField].key] || '').length);
  const key = fields[focus].key;
  const val = values[key] || '';

  const move = (d) => {
    const n = (focus + d + fields.length) % fields.length;
    setFocus(n);
    setCursor((values[fields[n].key] || '').length);
  };
  const insert = (text) => {
    const clean = text.replace(/[\r\n\t]/g, '');
    setValues({ ...values, [key]: val.slice(0, cursor) + clean + val.slice(cursor) });
    setCursor(cursor + clean.length);
  };

  usePaste((text) => insert(text));
  useInput((input, k) => {
    if (k.escape) return onCancel();
    if (k.return) return onSubmit(values);
    if (k.tab || k.downArrow) return move(k.shift ? -1 : 1);
    if (k.upArrow) return move(-1);
    if (k.leftArrow) return setCursor(Math.max(0, cursor - 1));
    if (k.rightArrow) return setCursor(Math.min(val.length, cursor + 1));
    if (k.ctrl && input === 'r' && onRestore) return onRestore();
    if (k.ctrl && input === 'u') { setValues({ ...values, [key]: '' }); return setCursor(0); }
    if (k.ctrl && input === 'a') return setCursor(0);
    if (k.ctrl && input === 'e') return setCursor(val.length);
    if (k.backspace || k.delete) {
      if (cursor === 0) return;
      setValues({ ...values, [key]: val.slice(0, cursor - 1) + val.slice(cursor) });
      return setCursor(cursor - 1);
    }
    if (input && !k.ctrl && !k.meta) insert(input);
  });

  const w = Math.min(width - 4, 84);
  return html`
    <${Box} position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
      <${Box} flexDirection="column" width=${w} borderStyle="round" borderColor="cyan" paddingX=${1} backgroundColor="black">
        <${Text} bold color="cyan">${title}<//>
        <${Text}> <//>
        ${fields.map((f, i) => html`<${Field} key=${f.key} label=${f.label} value=${values[f.key] || ''} focused=${i === focus}
            mask=${f.mask} cursor=${cursor} placeholder=${f.placeholder} width=${w} />`)}
        <${Text}> <//>
        ${fields[focus].help && html`<${Text} color="gray" wrap="wrap">${fields[focus].help}<//>`}
        ${notes.map((n, i) => html`<${Text} key=${i} color="yellow" wrap="wrap">${n}<//>`)}
        <${Text}> <//>
        <${Box}>
          <${Key} k="Enter" label="aplicar" /><${Key} k="Esc" label="cancelar" /><${Key} k="Tab/↑↓" label="campo" />
          ${onRestore && html`<${Key} k="Ctrl+R" label="restaurar .env" />`}
        <//>
      <//>
    <//>`;
}

function HelpModal({ width, onClose }) {
  useInput((input, k) => { if (k.escape || k.return || input === '?' || input === 'q') onClose(); });
  const rows = [
    ['s', 'Iniciar / detener la captura (crea o elimina la sesión de Extended Events)'],
    ['↑ ↓  j k', 'Moverse por los SPs capturados · PgUp/PgDn salta de a página'],
    ['g / Home', 'Volver a seguir lo más reciente'],
    ['c', 'Copiar la llamada raw tal como llegó al servidor'],
    ['y', 'Copiar la versión EXEC limpia (USE + EXEC, con OUTPUT declarados)'],
    ['p', 'Cambiar la contraseña de la conexión (solo en memoria)'],
    ['e', 'Editar servidor, base y usuario'],
    ['f', 'Editar el filtro: SPs, base, app, login y duración mínima'],
    ['r', 'Redactar valores (oculta argumentos en pantalla y al copiar)'],
    ['x', 'Limpiar la lista de SPs capturados'],
    ['o', 'Eliminar sesiones exprof_* huérfanas en el servidor'],
    ['q / Ctrl+C', 'Salir (elimina la sesión del servidor)'],
  ];
  const w = Math.min(width - 4, 90);
  return html`
    <${Box} position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
      <${Box} flexDirection="column" width=${w} borderStyle="round" borderColor="cyan" paddingX=${1} backgroundColor="black">
        <${Text} bold color="cyan">Atajos de teclado<//>
        <${Text}> <//>
        ${rows.map(([k, d]) => html`<${Box} key=${k}><${Box} width=${14} flexShrink=${0}><${Text} color="cyan" bold>${k}<//><//><${Text} wrap="truncate-end">${d}<//><//>`)}
        <${Text}> <//>
        <${Text} bold>Seguridad<//>
        <${Text} color="gray" wrap="wrap">La contraseña se lee del .env y nunca se muestra ni se guarda; si la cambias aquí vive solo en memoria. Los eventos no se escriben a disco y se borran al salir (pantalla alternativa, sin scrollback). Los valores de parámetros pueden ser datos personales: usa [r] antes de compartir la pantalla o copiar.<//>
        <${Text}> <//>
        <${Key} k="Esc" label="cerrar" />
      <//>
    <//>`;
}

// ---------- aplicacion ----------
function App({ profiler, init }) {
  const { exit } = useApp();
  const { columns: W, rows: H } = useWindowSize();
  const { write } = useStdout();

  const envPassword = useRef(init.cfg.password);
  const [conn, setConn] = useState(init.cfg);
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState('idle'); // idle|connecting|connected|starting|capturing|stopping|error
  const [filter, setFilter] = useState(init.filter);
  const [redactOn, setRedactOn] = useState(init.redact);
  const [events, setEvents] = useState([]);
  const [selId, setSelId] = useState(null); // null = seguir lo mas reciente
  const [activity, setActivity] = useState([]);
  const [modal, setModal] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [, setTick] = useState(0);
  const [total, setTotal] = useState(0);
  const scrollRef = useRef(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const busy = useRef(false);
  const resume = useRef(false); // reanudar la captura cuando una reconexion fallida se corrija
  const seq = useRef(0);

  const log = useCallback((level, text) => {
    setActivity((prev) => {
      if (prev[0] && prev[0].text === text && prev[0].level === level) {
        return [{ ...prev[0], n: prev[0].n + 1, t: clock() }, ...prev.slice(1)];
      }
      return [{ t: clock(), level, text, n: 1 }, ...prev].slice(0, MAX_ACTIVITY);
    });
  }, []);

  // eventos del profiler
  useEffect(() => {
    let queue = Promise.resolve(); // procesa los lotes en orden aunque esperen al catalogo
    const handle = async (rows) => {
      const items = [];
      for (const r of rows) {
        let call = parseCall(r, filterRef.current.patterns);
        const needsTypes = call.args.some((a) => a.typeSource !== 'declarado') || call.args.some((a) => !a.name);
        if (needsTypes && r.db && call.proc && !call.wrapper?.startsWith('sp_cursor')) {
          call = applyCatalog(call, await profiler.paramTypes(r.db, call.proc));
        }
        items.push({ id: ++seq.current, r, call, exec: buildExec(call, r.db) });
      }
      setTotal((n) => n + items.length);
      setEvents((prev) => [...items.reverse(), ...prev].slice(0, MAX_EVENTS));
    };
    const onEvents = (rows) => { queue = queue.then(() => handle(rows)).catch((e) => log('error', `Procesando eventos: ${e.message}`)); };
    const onError = (e) => log('error', `Lectura de eventos: ${explainError(e)}`);
    const onMeta = (db) => log('warn', `Sin acceso a metadatos de [${db}]: los tipos se infieren desde los valores (opcional: GRANT VIEW DEFINITION en esa base)`);
    profiler.on('events', onEvents);
    profiler.on('poll-error', onError);
    profiler.on('meta-unavailable', onMeta);
    return () => {
      profiler.off('events', onEvents);
      profiler.off('poll-error', onError);
      profiler.off('meta-unavailable', onMeta);
    };
  }, [profiler, log]);

  // reloj del encabezado
  useEffect(() => {
    if (status !== 'capturing') return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const connect = useCallback(async (c) => {
    setStatus('connecting');
    log('info', `Conectando a ${c.server} como ${c.user || '(sin usuario)'}…`);
    try {
      const i = await profiler.connect(c);
      setInfo(i);
      setStatus('connected');
      log('ok', `Conectado a ${i.serverName || c.server} · ${i.product} ${i.version} · login ${i.login}`);
      return true;
    } catch (e) {
      setInfo(null);
      setStatus('error');
      log('error', `No se pudo conectar: ${explainError(e)}`);
      return false;
    }
  }, [profiler, log]);

  const start = useCallback(async (f = filterRef.current, c = conn) => {
    if (!f.all && !f.patterns.length) {
      log('warn', 'Define al menos un SP en el filtro (o * para todos) antes de iniciar la captura');
      setModal({ kind: 'filter', thenStart: true });
      return;
    }
    if (!profiler.connected && !(await connect(c))) return;
    setStatus('starting');
    try {
      const name = await profiler.start(f, { interval: init.interval });
      resume.current = false;
      setStartedAt(Date.now());
      setStatus('capturing');
      if (f.all) log('warn', 'Capturando sin filtro de SP: todo el tráfico RPC (evítalo en servidores cargados)');
      log('ok', `Captura iniciada · sesión ${name} · ${describeFilter(f)}`);
    } catch (e) {
      setStatus(profiler.connected ? 'connected' : 'error');
      log('error', `No se pudo iniciar la captura: ${explainError(e)}`);
    }
  }, [profiler, conn, connect, log, init.interval]);

  const stop = useCallback(async () => {
    setStatus('stopping');
    try {
      const name = await profiler.stop();
      log('ok', `Captura detenida · sesión ${name} eliminada del servidor · ${profiler.count} eventos`);
    } catch (e) {
      log('error', `Error al detener: ${explainError(e)} · usa [o] para limpiar sesiones huérfanas`);
    }
    setStartedAt(null);
    setStatus(profiler.connected ? 'connected' : 'error');
  }, [profiler, log]);

  const guarded = (fn) => async (...a) => {
    if (busy.current) return log('info', 'Hay una operación en curso, espera un momento…');
    busy.current = true;
    try { await fn(...a); } finally { busy.current = false; }
  };

  const toggle = guarded(async () => (profiler.capturing ? stop() : start()));

  const applyConn = guarded(async (vals) => {
    const next = {
      ...conn,
      server: vals.server.trim() || conn.server,
      database: vals.database.trim() || 'master',
      user: vals.user.trim(),
    };
    if (vals.restore) { next.password = envPassword.current; next.passwordSource = envPassword.current ? 'env' : 'none'; }
    else if (vals.password) { next.password = vals.password; next.passwordSource = 'manual'; }
    const changed = ['server', 'database', 'user', 'password'].filter((k) => next[k] !== conn[k]);
    setModal(null);
    if (!changed.length) return log('info', 'Conexión sin cambios');
    if (changed.includes('password')) log('ok', vals.restore ? 'Contraseña restaurada desde el .env' : 'Contraseña actualizada para esta sesión (solo en memoria, no se guarda)');
    const others = changed.filter((k) => k !== 'password');
    if (others.length) log('info', `Conexión actualizada: ${others.join(', ')}`);
    const was = profiler.capturing || resume.current;
    if (profiler.capturing) await stop();
    setConn(next);
    const ok = await connect(next);
    resume.current = was && !ok;
    if (ok && was) await start(filterRef.current, next);
    else if (resume.current) log('info', 'La captura se reanudará al corregir la conexión ([p] o [e])');
  });

  const applyFilter = guarded(async (vals) => {
    const raw = vals.patterns.trim();
    const all = raw === '*';
    const next = {
      ...filter,
      all,
      patterns: all ? [] : core.splitList(raw),
      db: vals.db.trim() || undefined,
      app: vals.app.trim() || undefined,
      login: vals.login.trim() || undefined,
      minMs: vals.minMs.trim() && Number(vals.minMs) > 0 ? vals.minMs.trim() : undefined,
    };
    if (vals.minMs.trim() && !(Number(vals.minMs) >= 0)) return log('warn', 'Duración mínima inválida: debe ser un número de ms');
    setModal(null);
    setFilter(next);
    filterRef.current = next;
    log('info', `Filtro: ${describeFilter(next)}`);
    if (profiler.capturing) { await stop(); await start(next); }
    else if (modal && modal.thenStart) await start(next);
  });

  const quit = guarded(async () => {
    setStatus('stopping');
    log('info', 'Cerrando: eliminando la sesión del servidor…');
    await profiler.close();
    exit();
  });

  const cleanOrphans = guarded(async () => {
    if (!profiler.connected && !(await connect(conn))) return;
    try {
      const dropped = await profiler.clean();
      log(dropped.length ? 'ok' : 'info', dropped.length ? `Sesiones huérfanas eliminadas: ${dropped.join(', ')}` : 'No hay sesiones exprof_* huérfanas');
    } catch (e) {
      log('error', `No se pudieron limpiar las sesiones: ${explainError(e)}`);
    }
  });

  // seleccion actual
  const selIdx = selId == null ? 0 : Math.max(0, events.findIndex((e) => e.id === selId));
  const sel = events[selIdx];

  const copy = async (kind) => {
    if (!sel) return log('warn', 'No hay ningún SP seleccionado para copiar');
    let text = kind === 'exec' ? sel.exec : sel.call.raw;
    if (!text) return log('warn', 'Este evento no tiene una llamada EXEC reconstruible');
    if (redactOn) text = redact(text);
    const via = await clipboard.copy(text, write);
    if (!via) return log('error', 'No se encontró un portapapeles disponible (pbcopy, clip, wl-copy, xclip o xsel)');
    log('ok', `${kind === 'exec' ? 'EXEC limpio' : 'Llamada raw'} de ${sel.call.proc || 'evento'} ${kind === 'exec' ? 'copiado' : 'copiada'} (${via})${redactOn ? ' · valores redactados' : ' · contiene valores reales'}`);
  };

  const moveSel = (d) => {
    if (!events.length) return;
    const n = Math.min(events.length - 1, Math.max(0, selIdx + d));
    setSelId(n === 0 && d < 0 && selIdx + d <= 0 ? null : events[n].id);
  };

  // arranque
  useEffect(() => {
    guarded(async () => {
      if (!init.usedEnv.length) log('warn', 'No se encontró un .env: usando variables de entorno y valores por defecto');
      else log('info', `Configuración cargada desde ${prettyPath(init.usedEnv[0])}`);
      if (!conn.password) log('warn', 'No hay contraseña configurada: usa [p] para ingresarla');
      if (redactOn) log('info', 'Redacción activa por defecto (EXPROF_REDACT)');
      const ok = await connect(conn);
      if (ok && init.autoStart) await start();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, k) => {
    if ((k.ctrl && input === 'c') || input === 'q') return quit();
    if (input === 's' || input === ' ') return toggle();
    if (input === 'p') return setModal({ kind: 'conn', field: 3 });
    if (input === 'e') return setModal({ kind: 'conn', field: 0 });
    if (input === 'f') return setModal({ kind: 'filter' });
    if (input === '?') return setModal({ kind: 'help' });
    if (input === 'r') { setRedactOn(!redactOn); return log('info', `Redacción ${redactOn ? 'desactivada: se muestran los valores reales' : 'activada: valores ocultos en pantalla y al copiar'}`); }
    if (input === 'c') return copy('raw');
    if (input === 'y') return copy('exec');
    if (input === 'x') { setEvents([]); setTotal(0); setSelId(null); return log('info', 'Lista de SPs limpiada'); }
    if (input === 'o') return cleanOrphans();
    if (k.downArrow || input === 'j') return moveSel(1);
    if (k.upArrow || input === 'k') return moveSel(-1);
    if (k.pageDown) return moveSel(10);
    if (k.pageUp) return moveSel(-10);
    if (k.home || input === 'g') return setSelId(null);
    if (k.end || input === 'G') return events.length && setSelId(events[events.length - 1].id);
  }, { isActive: !modal });

  if (W < MIN_COLS || H < MIN_ROWS) {
    return html`<${Box} width=${W} height=${H} justifyContent="center" alignItems="center" flexDirection="column">
      <${Text} color="yellow">Terminal muy pequeña (${W}×${H}).<//>
      <${Text} color="gray">exprof necesita al menos ${MIN_COLS}×${MIN_ROWS}. Agranda la ventana · q para salir<//>
    <//>`;
  }

  // ---------- layout ----------
  const inner = W - 4;
  const headerH = 6, activityH = H >= 34 ? 6 : 4, footerH = 1, topH = 1;
  const avail = H - topH - headerH - activityH - footerH;

  // ---------- detalle del SP seleccionado (una entrada por linea, para recortar al alto disponible) ----------
  const T = (key, props, children) => html`<${Text} key=${key} wrap="truncate-end" ...${props}>${children}<//>`;
  const detailLines = [];
  if (!sel) {
    detailLines.push(T('vacio', { color: 'gray' }, 'Selecciona un SP para ver sus argumentos, tipos y la llamada raw para copiar.'));
  } else {
    const { r, call } = sel;
    const shownRaw = oneLine(redactOn ? redact(call.raw) : call.raw);
    const shownExec = sel.exec && (redactOn ? redact(sel.exec) : sel.exec);
    const wName = Math.min(26, Math.max(11, ...call.args.map((a) => (a.name || '').length + 2)));
    const wType = Math.min(22, Math.max(8, ...call.args.map((a) => (a.type || '').length + (a.output ? 5 : 0) + 2)));
    const wSrc = 11;
    const wVal = Math.max(10, inner - wName - wType - wSrc);
    const maxArgs = 8;
    const stats = [
      r.duration_us != null && `${(r.duration_us / 1000).toFixed(1)} ms`,
      r.cpu_us != null && `cpu ${(r.cpu_us / 1000).toFixed(1)} ms`,
      r.reads != null && `reads ${r.reads}`,
      r.writes != null && `writes ${r.writes}`,
      r.rows != null && r.rows >= 0 && `filas ${r.rows}`,
    ].filter(Boolean).join(' · ');
    detailLines.push(T('proc', {}, html`<${Text} bold color="white">${call.proc || r.obj || '—'}<//><${Text} color="gray">  ${r.db || ''} · spid ${r.spid} · ${r.login || ''}@${r.host || ''} · ${r.app || ''}<//>`));
    detailLines.push(T('stats', {}, html`<${Text} color="yellow">${stats}<//><${Text} color=${r.result && r.result !== 'OK' ? 'red' : 'green'}>  ${r.result || ''}<//>${call.wrapper ? html`<${Text} color="gray">  · vía ${call.wrapper}<//>` : ''}`));
    detailLines.push(T('thead', { color: 'gray', bold: true }, fit('PARÁMETRO', wName) + fit('TIPO', wType) + fit('ORIGEN', wSrc) + 'VALOR'));
    if (!call.args.length) detailLines.push(T('noargs', { color: 'gray' }, '(sin argumentos)'));
    call.args.slice(0, maxArgs).forEach((a, i) => detailLines.push(T('a' + i, {}, html`<${Text} color="cyan">${fit(a.name || `#${i + 1}`, wName)}<//><${Text}>${fit((a.type || '?') + (a.output ? ' out' : ''), wType)}<//><${Text} color=${SOURCE_COLOR[a.typeSource] || 'gray'}>${fit(a.typeSource || '—', wSrc)}<//><${Text} color=${a.isNull ? 'gray' : 'white'}>${fit(redactOn ? '?' : a.value, wVal)}<//>`)));
    if (call.args.length > maxArgs) detailLines.push(T('more', { color: 'gray' }, `… y ${call.args.length - maxArgs} argumentos más (ver llamada raw)`));
    if (call.omitted?.length) detailLines.push(T('omit', { color: 'gray' }, `Sin enviar (usan su valor por defecto): ${call.omitted.map((p) => `${p.name} ${p.type}`).join(', ')}`));
    detailLines.push(T('rawh', {}, html`<${Text} color="gray" bold>RAW<//><${Text} color="gray"> tal como llegó al servidor<//><${Text} color="cyan">  [c] copiar<//>`));
    wrapText(shownRaw, inner, 3).forEach((l, i) => detailLines.push(T('r' + i, { color: 'green' }, l)));
    if (shownExec) {
      detailLines.push(T('exech', {}, html`<${Text} color="gray" bold>EXEC<//><${Text} color="gray"> listo para SSMS / Azure Data Studio<//><${Text} color="cyan">  [y] copiar<//>`));
      shownExec.split('\n').slice(0, 4).forEach((l, i) => detailLines.push(T('e' + i, { color: 'magenta' }, l)));
    }
  }
  // el detalle tiene prioridad; la lista conserva al menos 3 filas visibles
  const detailH = Math.max(7, Math.min(detailLines.length + 2, avail - 6));
  const detailRoom = detailH - 2;
  const detailShown = detailLines.length > detailRoom
    ? [...detailLines.slice(0, detailRoom - 1), T('cut', { color: 'gray' }, '… agranda la terminal para ver el detalle completo (c / y copian igual)')]
    : detailLines;
  const listH = avail - detailH;
  const visible = Math.max(1, listH - 3);
  if (selIdx < scrollRef.current) scrollRef.current = selIdx;
  if (selIdx >= scrollRef.current + visible) scrollRef.current = selIdx - visible + 1;
  scrollRef.current = Math.max(0, Math.min(scrollRef.current, Math.max(0, events.length - visible)));
  const slice = events.slice(scrollRef.current, scrollRef.current + visible);

  // ---------- barra superior ----------
  const badge = {
    idle: [' ○ SIN CONEXIÓN ', 'gray'],
    connecting: [' ◌ CONECTANDO… ', 'yellow'],
    connected: [' ○ DETENIDO ', 'blue'],
    starting: [' ◌ INICIANDO… ', 'yellow'],
    capturing: [` ● CAPTURANDO ${startedAt ? elapsed(Date.now() - startedAt) : ''} `, 'green'],
    stopping: [' ◌ DETENIENDO… ', 'yellow'],
    error: [' ✕ ERROR ', 'red'],
  }[status];
  const top = html`
    <${Box} height=${1} flexShrink=${0}>
      <${Text} bold color="cyan"> ◆ exprof<//><${Text} color="gray">  mini SQL Server Profiler<//>
      <${Box} flexGrow=${1} />
      ${redactOn && html`<${Text} backgroundColor="yellow" color="black" bold> REDACTADO <//>`}<${Text}> <//>
      <${Text} backgroundColor=${badge[1]} color="black" bold>${badge[0]}<//>
    <//>`;

  // ---------- encabezado: conexion ----------
  const pwSource = conn.passwordSource === 'manual' ? 'manual · solo en memoria' : conn.passwordSource === 'env' ? '.env' : 'sin definir';
  const header = html`
    <${Panel} title="Conexión" width=${W} height=${headerH} right=${init.usedEnv.length ? `env: ${prettyPath(init.usedEnv[0])}` : 'sin .env'}>
      <${Row} label="Cadena">${connectionString(conn)}<//>
      <${Row} label="Usuario" right=${html`<${Text}><${Text} color="gray">Contraseña <//>${conn.password ? MASK : '(vacía)'}<${Text} color=${conn.passwordSource === 'manual' ? 'yellow' : 'gray'}> ${pwSource}<//><${Text} color="cyan"> [p] cambiar<//><//>`}>
        <${Text} bold>${conn.user || '(sin usuario)'}<//>${info && info.login && info.login !== conn.user ? html`<${Text} color="gray"> · login efectivo ${info.login}<//>` : ''}
      <//>
      <${Row} label="Servidor" right=${html`<${Text} color="cyan">[e] editar<//>`}>
        ${info ? html`<${Text}>${info.serverName || conn.server}<${Text} color="gray"> · ${info.product} ${info.version} · ${info.edition}<//><//>` : html`<${Text} color="gray">${status === 'connecting' ? 'conectando…' : 'sin conexión'}<//>`}
      <//>
      <${Row} label="Filtro" right=${html`<${Text} color="cyan">[f] editar<//>`}>${describeFilter(filter)}<//>
    <//>`;

  // ---------- lista de SPs ----------
  const wTime = 13, wVia = 6, wDur = 10, wRows = 6, wRes = 7;
  const fixed = 2 + wTime + wVia + wDur + wRows + wRes;
  const wProc = Math.min(38, Math.max(16, Math.floor((inner - fixed) * 0.45)));
  const wArgs = Math.max(8, inner - fixed - wProc);
  const argSummary = (call) => call.args.map((a) => `${a.name ? a.name + '=' : ''}${redactOn ? '?' : (a.isNull ? 'NULL' : a.value)}`).join(', ');
  const listTitle = `SPs ejecutados · ${events.length}${total > events.length ? ` de ${total}` : ''}`;
  const listRight = selId == null ? '▲ siguiendo lo más reciente' : `${selIdx + 1}/${events.length} · g para seguir`;
  const list = html`
    <${Panel} title=${listTitle} right=${listRight} width=${W} height=${listH}>
      <${Text} color="gray" bold wrap="truncate-end">${'  ' + fit('HORA', wTime) + fit('VÍA', wVia) + fit('SP', wProc) + fit('ARGUMENTOS', wArgs) + fit('DURACIÓN', wDur) + fit('FILAS', wRows) + fit('ESTADO', wRes)}<//>
      ${events.length === 0 && html`<${Box} flexDirection="column" paddingTop=${1}>
        <${Text} color="gray">${status === 'capturing' ? '  Escuchando… dispara la acción en tu aplicación y los SPs aparecerán aquí.' : '  Sin SPs capturados. Presiona [s] para iniciar la captura.'}<//>
      <//>`}
      ${slice.map((e) => {
        const isSel = e === sel;
        const bad = e.r.result && e.r.result !== 'OK';
        const dur = e.r.duration_us == null ? '' : `${(e.r.duration_us / 1000).toFixed(1)} ms`;
        const rowsN = e.r.rows == null || e.r.rows < 0 ? '' : String(e.r.rows);
        return html`<${Text} key=${e.id} wrap="truncate-end" inverse=${isSel}>
          <${Text} color=${isSel ? 'cyan' : undefined}>${isSel ? '▸ ' : '  '}<//><${Text} color="gray">${fit(clockMs(new Date(e.r.ts.getTime())), wTime)}<//><${Text} color=${VIA[e.call.via] || 'white'}>${fit(e.call.via, wVia)}<//><${Text} bold>${fit(e.call.proc || e.r.obj || '—', wProc)}<//><${Text} color="cyan">${fit(argSummary(e.call), wArgs)}<//><${Text} color="yellow">${fit(dur, wDur)}<//><${Text}>${fit(rowsN, wRows)}<//><${Text} color=${bad ? 'red' : 'green'}>${fit(e.r.result || '', wRes)}<//>
        <//>`;
      })}
    <//>`;

  const detail = html`<${Panel} title="Detalle" width=${W} height=${detailH} right=${sel ? sel.call.via : ''}>${detailShown}<//>`;

  // ---------- actividad ----------
  const act = html`
    <${Panel} title="Actividad" width=${W} height=${activityH}>
      ${activity.slice(0, activityH - 2).map((a, i) => html`<${Text} key=${i} wrap="truncate-end" dimColor=${i > 0}>
        <${Text} color="gray">${a.t} <//><${Text} color=${LEVEL[a.level][1]} bold>${LEVEL[a.level][0]} <//><${Text} color=${a.level === 'error' ? 'red' : a.level === 'warn' ? 'yellow' : undefined}>${a.text}<//>${a.n > 1 ? html`<${Text} color="gray"> ×${a.n}<//>` : ''}
      <//>`)}
    <//>`;

  const footer = html`
    <${Box} height=${1} flexShrink=${0} overflow="hidden">
      <${Text} wrap="truncate-end">
        <${Key} k="s" label=${profiler.capturing ? 'detener' : 'iniciar'} /><${Key} k="↑↓" label="navegar" /><${Key} k="c" label="copiar raw" /><${Key} k="y" label="copiar EXEC" /><${Key} k="p" label="contraseña" /><${Key} k="f" label="filtro" /><${Key} k="r" label="redactar" /><${Key} k="x" label="limpiar" /><${Key} k="?" label="ayuda" /><${Key} k="q" label="salir" />
      <//>
    <//>`;

  let overlay = null;
  if (modal?.kind === 'conn') {
    overlay = html`<${FormModal} key="conn" title="Conexión" width=${W} startField=${modal.field || 0}
      fields=${[
        { key: 'server', label: 'Servidor', placeholder: 'host,puerto', help: 'host[,puerto]. Por defecto viene de EXPROF_SERVER en el .env.' },
        { key: 'database', label: 'Base', placeholder: 'master', help: 'Base de la conexión (EXPROF_DATABASE). Para filtrar eventos por base usa [f].' },
        { key: 'user', label: 'Usuario', placeholder: 'login SQL', help: 'Login SQL (EXPROF_USER). Necesita ALTER ANY EVENT SESSION y VIEW SERVER STATE.' },
        { key: 'password', label: 'Contraseña', mask: true, placeholder: `${conn.password ? MASK : '(vacía)'}  · vacío = mantener la actual`, help: 'Se usa solo para esta sesión: no se escribe en disco ni se muestra. Vacío mantiene la actual; Ctrl+R vuelve a la del .env.' },
      ]}
      initial=${{ server: conn.server, database: conn.database, user: conn.user, password: '' }}
      notes=${profiler.capturing ? ['Al aplicar cambios se reinicia la captura con la nueva conexión.'] : []}
      onCancel=${() => { setModal(null); log('info', 'Edición de conexión cancelada'); }}
      onRestore=${() => applyConn({ server: conn.server, database: conn.database, user: conn.user, password: '', restore: true })}
      onSubmit=${applyConn} />`;
  } else if (modal?.kind === 'filter') {
    overlay = html`<${FormModal} key="filter" title="Filtro de captura" width=${W}
      fields=${[
        { key: 'patterns', label: 'SPs', placeholder: 'usp_Pago, usp_Contrato%  ·  * = todos', help: 'Separados por coma o espacio. Substring sin distinguir mayúsculas; con % se usa como LIKE. * captura todo (con cuidado).' },
        { key: 'db', label: 'Base', placeholder: 'todas', help: 'Solo eventos de esta base de datos.' },
        { key: 'app', label: 'Aplicación', placeholder: 'todas', help: 'Patrón sobre el nombre de aplicación cliente (client_app_name).' },
        { key: 'login', label: 'Login', placeholder: 'todos', help: 'Patrón sobre el login que ejecuta el SP.' },
        { key: 'minMs', label: 'Mín. ms', placeholder: '0', help: 'Solo ejecuciones con duración mayor o igual a este valor.' },
      ]}
      initial=${{ patterns: filter.all ? '*' : filter.patterns.join(', '), db: filter.db || '', app: filter.app || '', login: filter.login || '', minMs: filter.minMs || '' }}
      notes=${profiler.capturing ? ['Al aplicar se reinicia la sesión de captura con el filtro nuevo.'] : []}
      onCancel=${() => setModal(null)}
      onSubmit=${applyFilter} />`;
  } else if (modal?.kind === 'help') {
    overlay = html`<${HelpModal} width=${W} onClose=${() => setModal(null)} />`;
  }

  return html`
    <${Box} flexDirection="column" width=${W} height=${H}>
      ${top}${header}${list}${detail}${act}${footer}
      ${overlay}
    <//>`;
}

export async function runTui(init) {
  const profiler = new Profiler();
  let cleaning = null;
  const cleanup = () => (cleaning ||= profiler.close());
  const instance = render(html`<${App} profiler=${profiler} init=${init} />`, {
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: true,
  });
  const hardExit = (code) => cleanup().finally(() => { instance.unmount(); process.exit(code); });
  process.on('SIGTERM', () => hardExit(0));
  process.on('SIGHUP', () => hardExit(0));
  process.on('uncaughtException', (e) => {
    instance.unmount();
    console.error(`Error inesperado: ${e && e.stack ? e.stack : e}`);
    cleanup().finally(() => process.exit(1));
  });
  await instance.waitUntilExit();
  await cleanup();
  process.exit(0);
}

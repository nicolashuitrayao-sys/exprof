#!/usr/bin/env node
'use strict';
const path = require('path');
const { parseArgs } = require('util');
const core = require('../lib/core');

const HELP = `exprof - mini SQL Server Profiler (Extended Events) para terminal

Uso:
  exprof                  Abre la interfaz interactiva (TUI)
  exprof [opciones] [sp ...]

Interfaz:
  En una terminal interactiva se abre la TUI: conexion actual, inicio/detencion de la
  captura, lista de SPs con argumentos, tipos y llamada raw para copiar. Atajos con '?'.
  Con --json, --for, --max o --plain (o si la salida no es una terminal) se usa el modo
  de texto, pensado para scripts y agentes.
      --plain             Fuerza el modo de texto aunque sea una terminal
      --tui               Fuerza la interfaz interactiva

Filtro de SP (obligatorio en modo texto salvo --all o EXPROF_FILTER):
  sp ...                  Nombres/patrones de SP. Substring por defecto; si incluyes % se usa como LIKE exacto.
  -f, --sp <patron>       Igual que arriba (repetible)
  -a, --all               Sin filtro de SP (todo RPC)

Filtros extra:
  -d, --db <nombre>       Solo esta base de datos
      --app <patron>      Filtra por client_app_name
      --login <patron>    Filtra por login
      --min-ms <n>        Solo duracion >= n ms
      --errors            Solo RPC abortados + errores reportados (severity>10, RAISERROR incluido)
      --show-source       Ademas de la llamada, muestra el codigo del SP sentencia a sentencia
                          (con nivel de anidamiento y linea). Alias: --statements
      --no-batches        No incluir EXEC enviados como batch de texto (solo RPC)

Por defecto muestra cada llamada al SP con sus argumentos y valores (RPC y EXEC por batch).

Conexion (archivo .env; ver .env.example):
  Se busca en: $EXPROF_ENV, ./.env, ~/.exprof.env, <carpeta de exprof>/.env
  EXPROF_SERVER (host[,puerto]) · EXPROF_USER · EXPROF_PASSWORD · EXPROF_DATABASE
  Valores por defecto opcionales: EXPROF_FILTER (SPs) · EXPROF_REDACT (1/0) · EXPROF_ENCRYPT (1/0)
  -S, --server <host[,puerto]>   Sobrescribe EXPROF_SERVER
  -U, --user <login>             Sobrescribe EXPROF_USER (Windows auth no disponible en macOS)
      --encrypt                  Valida el certificado TLS (por defecto confia en el del servidor)

Salida:
      --redact            Oculta los valores de los parametros (?), deja solo la estructura de la llamada.
                          Best-effort: revisa la salida antes de compartirla.
      --no-redact         Ignora EXPROF_REDACT=1 del .env
      --for <seg>         Termina solo despues de <seg> segundos
      --max <n>           Termina solo despues de <n> eventos
      --json              Una linea JSON por evento
      --interval <ms>     Frecuencia de polling (def. 1000)
      --clean             Elimina sesiones exprof_* huerfanas y sale
  -h, --help

Requiere permiso ALTER ANY EVENT SESSION + VIEW SERVER STATE.
`;

let opts, positionals;
try {
  ({ values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sp: { type: 'string', short: 'f', multiple: true },
      all: { type: 'boolean', short: 'a' },
      db: { type: 'string', short: 'd' },
      app: { type: 'string' },
      login: { type: 'string' },
      'min-ms': { type: 'string' },
      errors: { type: 'boolean' },
      'show-source': { type: 'boolean' },
      statements: { type: 'boolean' }, // alias de --show-source
      'no-batches': { type: 'boolean' },
      server: { type: 'string', short: 'S' },
      user: { type: 'string', short: 'U' },
      encrypt: { type: 'boolean' },
      json: { type: 'boolean' },
      redact: { type: 'boolean' },
      'no-redact': { type: 'boolean' },
      for: { type: 'string' },
      max: { type: 'string' },
      interval: { type: 'string' },
      clean: { type: 'boolean' },
      plain: { type: 'boolean' },
      tui: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(e.message + '\n\n' + HELP);
  process.exit(2);
}
if (opts.statements) opts['show-source'] = true;
if (opts.help) { console.log(HELP); process.exit(0); }

let usedEnv;
try {
  usedEnv = core.loadEnv();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const { cfg, defaults } = core.readConfig({ server: opts.server, user: opts.user, encrypt: opts.encrypt });
const cliPatterns = [...(opts.sp || []), ...positionals];
const patterns = cliPatterns.length ? cliPatterns : opts.all ? [] : defaults.filter;
const redactOn = opts['no-redact'] ? false : !!(opts.redact || defaults.redact);
const filter = {
  patterns,
  all: !!opts.all,
  db: opts.db,
  app: opts.app,
  login: opts.login,
  minMs: opts['min-ms'],
  errors: !!opts.errors,
  showSource: !!opts['show-source'],
  noBatches: !!opts['no-batches'],
};

const interactive = process.stdout.isTTY && process.stdin.isTTY;
const wantsTui = opts.tui || (interactive && !opts.plain && !opts.json && !opts.for && !opts.max && !opts.clean);
if (opts.tui && !interactive) {
  console.error('--tui necesita una terminal interactiva (stdin y stdout TTY).');
  process.exit(2);
}

// ---------- modo texto (scripts / agentes) ----------
const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { d: '\x1b[2m', r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m' }
  : { d: '', r: '', g: '', y: '', c: '', b: '', x: '' };

function render(r) {
  if (redactOn) {
    r = { ...r, stmt: core.redact(r.stmt), batch: core.redact(r.batch), msg: r.msg && core.redactLiterals(r.msg) };
  }
  if (opts.json) {
    console.log(JSON.stringify({
      time: r.ts, event: r.event, db: r.db, sp: r.obj, spid: r.spid, login: r.login, host: r.host, app: r.app,
      duration_ms: r.duration_us == null ? null : r.duration_us / 1000, cpu_ms: r.cpu_us == null ? null : r.cpu_us / 1000,
      reads: r.reads == null ? null : Number(r.reads), writes: r.writes == null ? null : Number(r.writes), rows: r.rows == null ? null : Number(r.rows), result: r.result, nest: r.nest, line: r.line, error: r.errno, severity: r.sev, text: r.msg || r.stmt || r.batch,
    }));
    return;
  }
  const d = new Date(r.ts.getTime()); // XE entrega UTC; se muestra en hora local
  const t = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  if (r.event === 'error_reported') {
    console.log(`${C.d}${t}${C.x} ${C.r}ERR  ${C.b}#${r.errno} sev=${r.sev}${C.x} ${C.r}${(r.msg || '').trim()}${C.x}\n${C.d}  ${r.db || ''} · spid ${r.spid} · ${r.login || ''}@${r.host || ''} · ${r.app || ''}${C.x}`);
    return;
  }
  const bad = r.result && r.result !== 'OK';
  const kind = { rpc_completed: 'RPC', sp_statement_completed: 'STMT', sql_batch_completed: 'BATCH' }[r.event] || r.event;
  const dur = r.duration_us == null ? '' : `${(r.duration_us / 1000).toFixed(1)}ms`;
  const meta = [
    dur && `dur=${dur}`,
    r.cpu_us != null && `cpu=${(r.cpu_us / 1000).toFixed(1)}ms`,
    r.reads != null && `reads=${r.reads}`,
    r.event === 'sp_statement_completed' && `nest=${r.nest} line=${r.line}`,
    r.rows != null && r.rows >= 0 && `rows=${r.rows}`,
  ].filter(Boolean).join(' ');
  const head = `${C.d}${t}${C.x} ${bad ? C.r : C.g}${kind.padEnd(5)}${C.x} ${C.b}${r.obj || ''}${C.x}` +
    (bad ? ` ${C.r}[${r.result}]${C.x}` : '') + ` ${C.y}${meta}${C.x}`;
  const who = `${C.d}  ${r.db || ''} · spid ${r.spid} · ${r.login || ''}@${r.host || ''} · ${r.app || ''}${C.x}`;
  const body = (r.stmt || r.batch || '').trim().replace(/\s*\n\s*/g, ' ');
  console.log(head + '\n' + who + (body ? `\n  ${C.c}${body.length > 600 ? body.slice(0, 600) + '…' : body}${C.x}` : ''));
}

async function runPlain() {
  if (!patterns.length && !opts.all && !opts.clean) {
    console.error('Indica al menos un SP a escuchar (ej: exprof usp_MiProc), define EXPROF_FILTER o usa --all.\n');
    console.error(HELP);
    process.exit(2);
  }
  const profiler = new core.Profiler();
  await profiler.connect(cfg);
  if (opts.clean) {
    const dropped = await profiler.clean();
    for (const name of dropped) console.log(`Eliminada ${name}`);
    if (!dropped.length) console.log('No hay sesiones exprof_* huerfanas.');
    return profiler.close();
  }

  let count = 0, stopping = false;
  const maxEvents = opts.max ? Number(opts.max) : 0;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const name = profiler.session;
    console.error(`${C.d}Eventos capturados: ${count}${C.x}`);
    await profiler.close();
    console.error(`\n${C.d}Sesion ${name} eliminada.${C.x}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  profiler.on('events', (rows) => {
    for (const r of rows) {
      if (stopping || (maxEvents && count >= maxEvents)) break;
      render(r);
      count++;
    }
    if (maxEvents && count >= maxEvents) stop();
  });
  profiler.on('poll-error', (e) => console.error(`${C.r}poll: ${e.message}${C.x}`));

  await profiler.start(filter, { interval: opts.interval });
  const envLabel = usedEnv.length ? 'env: ' + path.relative(process.cwd(), usedEnv[0]) + ' · ' : '';
  console.error(`${C.d}${envLabel}Escuchando en ${cfg.server}${opts.db ? ` [${opts.db}]` : ''} · filtro: ${patterns.length ? patterns.join(', ') : '(todos)'}${redactOn ? ' · redactado' : ''} · Ctrl+C para salir${C.x}\n`);
  if (opts.for) setTimeout(stop, Number(opts.for) * 1000);
}

if (wantsTui) {
  import('../lib/tui.mjs')
    .then(({ runTui }) => runTui({
      cfg, usedEnv, filter, redact: redactOn,
      autoStart: cliPatterns.length > 0 || !!opts.all,
      interval: opts.interval,
    }))
    .catch((e) => {
      console.error(`No se pudo abrir la interfaz: ${e.message}\nUsa --plain para el modo de texto.`);
      process.exit(1);
    });
} else {
  runPlain().catch((e) => {
    console.error(`${C.r}Error: ${core.explainError(e)}${C.x}`);
    process.exit(1);
  });
}

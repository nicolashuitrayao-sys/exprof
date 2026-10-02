'use strict';
// Nucleo compartido por el modo CLI y la TUI: configuracion (.env), sesion de Extended Events,
// lectura del ring buffer, redaccion de valores y metadatos de parametros.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const sql = require('mssql');

// ---------- config (.env) ----------
// Prioridad: variables ya exportadas > EXPROF_ENV > ./.env > ~/.exprof.env > <carpeta de exprof>/.env
function loadDotenv(file) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] === undefined) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

function loadEnv() {
  if (process.env.EXPROF_ENV && !fs.existsSync(process.env.EXPROF_ENV)) {
    throw new Error(`EXPROF_ENV apunta a un archivo que no existe: ${process.env.EXPROF_ENV}`);
  }
  const files = [process.env.EXPROF_ENV, path.join(process.cwd(), '.env'), path.join(os.homedir(), '.exprof.env'), path.join(__dirname, '..', '.env')].filter(Boolean);
  return [...new Set(files.map((f) => path.resolve(f)))].filter(loadDotenv);
}

const truthy = (v) => /^(1|true|yes|si|sí|on)$/i.test(String(v || '').trim());
const splitList = (v) => String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

// Lee la configuracion de conexion y los valores por defecto. La clave se saca de process.env
// para que no la hereden procesos hijos (por ejemplo pbcopy al copiar al portapapeles).
function readConfig(overrides = {}) {
  const cfg = {
    server: overrides.server || process.env.EXPROF_SERVER || 'localhost',
    user: overrides.user || process.env.EXPROF_USER || '',
    password: process.env.EXPROF_PASSWORD || '',
    database: process.env.EXPROF_DATABASE || 'master',
    encrypt: overrides.encrypt || truthy(process.env.EXPROF_ENCRYPT),
    passwordSource: process.env.EXPROF_PASSWORD ? 'env' : 'none',
  };
  delete process.env.EXPROF_PASSWORD;
  const defaults = {
    filter: splitList(process.env.EXPROF_FILTER),
    redact: truthy(process.env.EXPROF_REDACT),
  };
  return { cfg, defaults };
}

// Cadena de conexion para mostrar: la clave siempre enmascarada y con largo fijo (no revela su longitud).
const MASK = '••••••••';
function connectionString(cfg) {
  return [
    `Server=${cfg.server}`,
    `Database=${cfg.database}`,
    `User Id=${cfg.user || '(sin usuario)'}`,
    `Password=${cfg.password ? MASK : '(vacía)'}`,
    'Encrypt=True',
    `TrustServerCertificate=${cfg.encrypt ? 'False' : 'True'}`,
  ].join(';');
}

function poolConfig(cfg) {
  const [host, port] = String(cfg.server).split(',');
  return {
    server: host.trim(),
    port: port ? Number(port) : undefined,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    requestTimeout: 30000,
    connectionTimeout: 15000,
    pool: { max: 2, min: 0 },
    options: { encrypt: true, trustServerCertificate: !cfg.encrypt, enableArithAbort: true, appName: 'exprof' },
  };
}

// ---------- SQL de la sesion ----------
const lit = (s) => "N'" + String(s).replace(/'/g, "''") + "'";
const like = (col, pat) => {
  const p = pat.includes('%') ? pat : `%${pat}%`; // sin % -> substring; '_' matchea cualquier caracter (incluido '_')
  return `sqlserver.like_i_sql_unicode_string(${col}, ${lit(p)})`;
};

const ACTIONS = `ACTION (sqlserver.database_name, sqlserver.client_app_name, sqlserver.client_hostname, sqlserver.username, sqlserver.session_id, package0.event_sequence)`;

// f: { patterns, db, app, login, minMs, errors, showSource, noBatches }
function buildSession(name, f) {
  const patterns = f.patterns || [];
  // excluye las consultas de la propia herramienta (importante con --all)
  const common = ["sqlserver.client_app_name <> N'exprof'"];
  if (f.db) common.push(`sqlserver.database_name = ${lit(f.db)}`);
  if (f.app) common.push(like('sqlserver.client_app_name', f.app));
  if (f.login) common.push(like('sqlserver.username', f.login));
  const minUs = f.minMs ? Math.round(Number(f.minMs) * 1000) : 0;
  if (minUs > 0) common.push(`duration >= ${minUs}`);
  const spFilter = patterns.length ? '(' + patterns.map((p) => like('object_name', p)).join(' OR ') + ')' : null;

  const where = (extra) => {
    const parts = [...common, ...extra].filter(Boolean);
    return parts.length ? `WHERE (${parts.join(' AND ')})` : '';
  };
  // ORMs/drivers envuelven la llamada en sp_executesql/sp_prepexec: el SP solo aparece dentro del texto (statement)
  const rpcSp = patterns.length ? '(' + patterns.map((p) => `${like('object_name', p)} OR ${like('statement', p)}`).join(' OR ') + ')' : null;
  const rpcExtra = [rpcSp, f.errors ? 'result <> 0' : null];
  const events = [`ADD EVENT sqlserver.rpc_completed (SET collect_statement=(1) ${ACTIONS} ${where(rpcExtra)})`];
  if (f.showSource) {
    events.push(`ADD EVENT sqlserver.sp_statement_completed (SET collect_object_name=(1), collect_statement=(1) ${ACTIONS} ${where([spFilter])})`);
  }
  if (!f.noBatches && patterns.length) {
    const b = '(' + patterns.map((p) => like('batch_text', p)).join(' OR ') + ')';
    events.push(`ADD EVENT sqlserver.sql_batch_completed (${ACTIONS} ${where([b, f.errors ? 'result <> 0' : null])})`);
  }
  if (f.errors) {
    const ec = [...common.filter((c) => !c.startsWith('duration')), 'severity > 10'];
    events.push(`ADD EVENT sqlserver.error_reported (${ACTIONS} WHERE (${ec.join(' AND ')}))`);
  }
  return `CREATE EVENT SESSION [${name}] ON SERVER
${events.join(',\n')}
ADD TARGET package0.ring_buffer (SET max_memory = 4096)
WITH (MAX_DISPATCH_LATENCY = 1 SECONDS, EVENT_RETENTION_MODE = ALLOW_SINGLE_EVENT_LOSS, STARTUP_STATE = OFF);`;
}

const READ_SQL = `
SELECT * FROM (
  SELECT
    x.e.value('(@name)[1]','nvarchar(60)') AS event,
    x.e.value('(@timestamp)[1]','datetime2(3)') AS ts,
    x.e.value('(action[@name="event_sequence"]/value)[1]','bigint') AS seq,
    x.e.value('(data[@name="object_name"]/value)[1]','nvarchar(400)') AS obj,
    x.e.value('(data[@name="statement"]/value)[1]','nvarchar(max)') AS stmt,
    x.e.value('(data[@name="batch_text"]/value)[1]','nvarchar(max)') AS batch,
    x.e.value('(data[@name="duration"]/value)[1]','bigint') AS duration_us,
    x.e.value('(data[@name="cpu_time"]/value)[1]','bigint') AS cpu_us,
    x.e.value('(data[@name="logical_reads"]/value)[1]','bigint') AS reads,
    x.e.value('(data[@name="writes"]/value)[1]','bigint') AS writes,
    x.e.value('(data[@name="row_count"]/value)[1]','bigint') AS rows,
    x.e.value('(data[@name="result"]/text)[1]','nvarchar(30)') AS result,
    x.e.value('(data[@name="nest_level"]/value)[1]','int') AS nest,
    x.e.value('(data[@name="line_number"]/value)[1]','int') AS line,
    x.e.value('(data[@name="message"]/value)[1]','nvarchar(max)') AS msg,
    x.e.value('(data[@name="error_number"]/value)[1]','int') AS errno,
    x.e.value('(data[@name="severity"]/value)[1]','int') AS sev,
    x.e.value('(action[@name="database_name"]/value)[1]','nvarchar(128)') AS db,
    x.e.value('(action[@name="client_app_name"]/value)[1]','nvarchar(256)') AS app,
    x.e.value('(action[@name="client_hostname"]/value)[1]','nvarchar(128)') AS host,
    x.e.value('(action[@name="username"]/value)[1]','nvarchar(128)') AS login,
    x.e.value('(action[@name="session_id"]/value)[1]','int') AS spid
  FROM (
    SELECT CAST(t.target_data AS xml) AS d
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = @name AND t.target_name = 'ring_buffer'
  ) q
  CROSS APPLY q.d.nodes('RingBufferTarget/event') x(e)
) ev
WHERE ev.seq > @last
ORDER BY ev.seq;`;

// ---------- redaccion de valores ----------
function redactLiterals(t) {
  return t
    .replace(/(N?)'(?:[^']|'')*'/gi, "$1'?'")
    .replace(/\b0x[0-9a-f]+\b/gi, '0x?')
    .replace(/(?<![\w@#.\[\]"])-?\d+(?:\.\d+)?(?![\w.])/g, '?');
}
function redact(t) {
  if (!t) return t;
  // sp_executesql/sp_prepexec: se conservan @statement (con sus literales ocultos) y @params; se ocultan los valores
  const m = t.match(/^(\s*exec(?:ute)?\s+sp_(?:executesql|prepexec|prepare|cursoropen|cursorprepexec)\b\s*)([\s\S]*)$/i);
  if (!m) return redactLiterals(t);
  const rest = m[2];
  const re = /N?'(?:[^']|'')*'/gi;
  let out = m[1], kept = 0, pos = 0, mm;
  while (kept < 2 && (mm = re.exec(rest))) {
    out += redactLiterals(rest.slice(pos, mm.index));
    const lit = mm[0];
    if (kept === 0) {
      const q = lit.indexOf("'");
      const inner = lit.slice(q + 1, -1).replace(/''/g, "'");
      out += lit.slice(0, q + 1) + redactLiterals(inner).replace(/'/g, "''") + "'";
    } else out += lit;
    pos = mm.index + lit.length;
    kept++;
  }
  return out + redactLiterals(rest.slice(pos));
}

// ---------- errores legibles ----------
function explainError(e) {
  const msg = (e && e.message) || String(e);
  if (/login failed/i.test(msg)) return `${msg} · revisa usuario/contraseña`;
  if (/permission|denied/i.test(msg)) return `${msg} · se necesita ALTER ANY EVENT SESSION y VIEW SERVER STATE`;
  if (/ECONNREFUSED|ETIMEOUT|ENOTFOUND|getaddrinfo|Failed to connect/i.test(msg)) return `${msg} · revisa servidor/puerto y que SQL Server esté accesible`;
  if (/certificate|self[- ]signed/i.test(msg)) return `${msg} · prueba sin EXPROF_ENCRYPT / --encrypt`;
  return msg;
}

// ---------- tipos de parametros desde el catalogo ----------
function formatType(t, maxLength, precision, scale) {
  const n = String(t).toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(n)) return `${n}(${maxLength === -1 ? 'max' : maxLength})`;
  if (['nvarchar', 'nchar'].includes(n)) return `${n}(${maxLength === -1 ? 'max' : maxLength / 2})`;
  if (['decimal', 'numeric'].includes(n)) return `${n}(${precision},${scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(n)) return `${n}(${scale})`;
  return n;
}
const qid = (s) => '[' + String(s).replace(/]/g, ']]') + ']';

// ---------- Profiler: conexion + sesion XE + polling ----------
// Eventos: 'events' (filas nuevas), 'poll-error' (Error), 'state' (estado nuevo)
class Profiler extends EventEmitter {
  constructor() {
    super();
    this.pool = null;
    this.session = null;
    this.last = 0;
    this.count = 0;
    this.interval = 1000;
    this.polling = false;
    this.paramCache = new Map();
    this.noMetaDbs = new Set();
  }

  get connected() { return !!(this.pool && this.pool.connected); }
  get capturing() { return !!this.session; }

  async connect(cfg) {
    await this.close();
    const pool = new sql.ConnectionPool(poolConfig(cfg));
    pool.on('error', (e) => this.emit('poll-error', e));
    await pool.connect();
    this.pool = pool;
    this.paramCache.clear();
    this.noMetaDbs.clear();
    const r = await pool.request().query(`SELECT SUSER_SNAME() AS login, @@SERVERNAME AS serverName,
      CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version,
      CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
      LEFT(@@VERSION, CHARINDEX(' (', @@VERSION + ' (') - 1) AS product`);
    return r.recordset[0];
  }

  async start(filter, { interval = 1000 } = {}) {
    if (!this.connected) throw new Error('No hay conexión activa');
    if (this.session) return this.session;
    const name = `exprof_${process.pid}_${Date.now().toString(36)}`;
    await this.pool.request().batch(buildSession(name, filter));
    try {
      await this.pool.request().batch(`ALTER EVENT SESSION [${name}] ON SERVER STATE = START`);
    } catch (e) {
      await this.dropSession(name).catch(() => {});
      throw e;
    }
    this.session = name;
    this.last = 0;
    this.count = 0;
    this.interval = Math.max(200, Number(interval) || 1000);
    this.loop();
    return name;
  }

  async loop() {
    if (this.polling) return;
    this.polling = true;
    while (this.session) {
      const name = this.session;
      try {
        const res = await this.pool.request()
          .input('name', sql.NVarChar(128), name)
          .input('last', sql.BigInt, this.last)
          .query(READ_SQL);
        if (this.session !== name) continue; // se detuvo o reinicio mientras se leia: descartar
        if (res.recordset.length) {
          for (const r of res.recordset) this.last = Math.max(this.last, Number(r.seq));
          this.count += res.recordset.length;
          this.emit('events', res.recordset);
        }
      } catch (e) {
        if (this.session) this.emit('poll-error', e);
      }
      await new Promise((r) => { this.wake = r; setTimeout(r, this.interval); });
    }
    this.polling = false;
  }

  async dropSession(name) {
    if (!this.pool) return;
    await this.pool.request().batch(`IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name=${lit(name)}) DROP EVENT SESSION ${qid(name)} ON SERVER`);
  }

  async stop() {
    const name = this.session;
    if (!name) return null;
    this.session = null;
    if (this.wake) this.wake();
    await this.dropSession(name);
    return name;
  }

  async close() {
    try { await this.stop(); } catch { /* la sesion se limpia con --clean si quedo huerfana */ }
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      try { await p.close(); } catch { /* nada que hacer */ }
    }
  }

  async clean() {
    const res = await this.pool.request().query(`SELECT name FROM sys.server_event_sessions WHERE name LIKE 'exprof[_]%'`);
    const own = this.session;
    const dropped = [];
    for (const { name } of res.recordset) {
      if (name === own) continue;
      await this.dropSession(name);
      dropped.push(name);
    }
    return dropped;
  }

  // Parametros declarados del SP segun sys.parameters de su base. Devuelve null si no hay acceso
  // (el login necesita acceso a la base y VIEW DEFINITION); en ese caso los tipos se infieren.
  async paramTypes(db, proc) {
    if (!db || !proc || !this.connected || this.noMetaDbs.has(db)) return null;
    const key = `${db}|${proc}`.toLowerCase();
    if (this.paramCache.has(key)) return this.paramCache.get(key);
    const parts = proc.replace(/[[\]"]/g, '').split('.').filter(Boolean);
    const full = `${qid(db)}.${parts.length > 1 ? qid(parts[parts.length - 2]) : ''}.${qid(parts[parts.length - 1])}`;
    let out = null;
    try {
      const r = await this.pool.request().input('full', sql.NVarChar(600), full).query(`
        SELECT p.name, t.name AS type, p.max_length, p.precision, p.scale, p.is_output, p.has_default_value
        FROM ${qid(db)}.sys.parameters p
        JOIN ${qid(db)}.sys.types t ON t.user_type_id = p.user_type_id
        WHERE p.object_id = OBJECT_ID(@full) ORDER BY p.parameter_id`);
      out = r.recordset.map((p) => ({ name: p.name, type: formatType(p.type, p.max_length, p.precision, p.scale), output: !!p.is_output }));
      if (!out.length) {
        // Sin filas: el SP no tiene parametros o el login no ve su definicion
        const v = await this.pool.request().input('full', sql.NVarChar(600), full).query('SELECT OBJECT_ID(@full) AS id');
        if (v.recordset[0].id == null) out = null;
      }
    } catch (e) {
      this.noMetaDbs.add(db);
      this.emit('meta-unavailable', db, e);
      return null;
    }
    this.paramCache.set(key, out);
    return out;
  }
}

module.exports = {
  sql, loadEnv, readConfig, connectionString, poolConfig, buildSession, READ_SQL,
  redact, redactLiterals, explainError, formatType, Profiler, MASK, truthy, splitList,
};

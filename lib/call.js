'use strict';
// Interpreta el texto de una llamada a SP capturada (RPC, sp_executesql/sp_prepexec o EXEC en batch)
// y la descompone en nombre, argumentos, tipos y una version EXEC lista para copiar.

const INT_MIN = -2147483648, INT_MAX = 2147483647;

function tokenize(s) {
  const toks = [];
  let i = 0;
  const prevIsValue = () => {
    const p = toks[toks.length - 1];
    // tras un nombre (word/ident) se asume posicion de argumento: "EXEC usp_X -5"
    return p && (['str', 'num', 'hex', 'var'].includes(p.t) || (p.t === 'punct' && p.v === ')'));
  };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { const n = s.indexOf('\n', i); i = n < 0 ? s.length : n + 1; continue; }
    if (c === '/' && s[i + 1] === '*') { const n = s.indexOf('*/', i + 2); i = n < 0 ? s.length : n + 2; continue; }
    const start = i;
    if (c === "'" || ((c === 'N' || c === 'n') && s[i + 1] === "'")) {
      const unicode = c !== "'";
      i += unicode ? 2 : 1;
      let v = '';
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++; break;
        }
        v += s[i++];
      }
      toks.push({ t: 'str', unicode, v, raw: s.slice(start, i) });
      continue;
    }
    if (c === '0' && /x/i.test(s[i + 1] || '')) {
      const m = s.slice(i).match(/^0x[0-9a-f]*/i);
      toks.push({ t: 'hex', v: m[0], raw: m[0] }); i += m[0].length; continue;
    }
    const num = s.slice(i).match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
    if (num && (/[\d.]/.test(c) || !prevIsValue())) {
      toks.push({ t: 'num', v: num[0], raw: num[0] }); i += num[0].length; continue;
    }
    if (c === '@') {
      const m = s.slice(i).match(/^@{1,2}[\w@#$]*/);
      toks.push({ t: 'var', v: m[0], raw: m[0] }); i += m[0].length; continue;
    }
    if (c === '[') {
      let j = i + 1, v = '';
      while (j < s.length) { if (s[j] === ']') { if (s[j + 1] === ']') { v += ']'; j += 2; continue; } j++; break; } v += s[j++]; }
      toks.push({ t: 'ident', v, raw: s.slice(i, j) }); i = j; continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      const end = j < 0 ? s.length : j + 1;
      toks.push({ t: 'ident', v: s.slice(i + 1, end - 1), raw: s.slice(i, end) }); i = end; continue;
    }
    const w = s.slice(i).match(/^[\p{L}_#$][\p{L}\p{N}_#$@]*/u);
    if (w) { toks.push({ t: 'word', v: w[0], raw: w[0] }); i += w[0].length; continue; }
    toks.push({ t: 'punct', v: c, raw: c }); i++;
  }
  return toks;
}

const isWord = (tok, re) => tok && tok.t === 'word' && re.test(tok.v);
const isP = (tok, ch) => tok && tok.t === 'punct' && tok.v === ch;

// Parsea "EXEC [@ret =] nombre arg, arg..." a partir del token i (que debe ser EXEC/EXECUTE)
function parseExec(toks, i) {
  let j = i + 1;
  if (toks[j] && toks[j].t === 'var' && isP(toks[j + 1], '=')) j += 2; // @ret = proc
  const parts = [];
  let raw = '';
  while (toks[j] && (toks[j].t === 'word' || toks[j].t === 'ident' || isP(toks[j], '.'))) {
    if (isP(toks[j], '.')) { raw += '.'; if (isP(toks[j + 1], '.')) parts.push(''); j++; continue; }
    if (parts.length && !isP(toks[j - 1], '.')) break;
    parts.push(toks[j].v); raw += toks[j].raw; j++;
  }
  if (!parts.length) return null;
  const args = [];
  const first = toks[j];
  // un EXEC sin argumentos termina en ';', fin de texto o la siguiente sentencia
  const startsArg = first && !isP(first, ';') && (first.t !== 'word' || isWord(first, /^(null|default)$/i) || isP(toks[j + 1], ','));
  if (startsArg) {
    while (toks[j]) {
      let name = null;
      if (toks[j].t === 'var' && isP(toks[j + 1], '=')) { name = toks[j].v; j += 2; }
      const val = toks[j];
      if (!val || isP(val, ';') || isP(val, ',')) break;
      j++;
      let output = false;
      if (isWord(toks[j], /^(output|out)$/i)) { output = true; j++; }
      args.push({ name, tok: val, output });
      if (isP(toks[j], ',')) { j++; continue; }
      break;
    }
  }
  return { parts, name: raw, args, end: j };
}

function findExecs(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (isWord(toks[i], /^(exec|execute)$/i) && !isP(toks[i + 1], '(')) {
      const e = parseExec(toks, i);
      if (e) { out.push(e); i = e.end - 1; }
    }
  }
  return out;
}

function inferType(tok) {
  if (!tok) return null;
  if (tok.t === 'str') return tok.unicode ? 'nvarchar' : 'varchar';
  if (tok.t === 'hex') return 'varbinary';
  if (tok.t === 'num') {
    if (/e/i.test(tok.v)) return 'float';
    if (tok.v.includes('.')) {
      const [a, b = ''] = tok.v.replace(/^[-+]/, '').split('.');
      const scale = b.length, prec = Math.max(1, a.replace(/^0+/, '').length + scale);
      return `decimal(${prec},${scale})`;
    }
    const n = Number(tok.v);
    return n >= INT_MIN && n <= INT_MAX ? 'int' : 'bigint';
  }
  return null;
}

function displayValue(tok) {
  if (!tok) return '';
  if (tok.t === 'str') return tok.v;
  if (isWord(tok, /^null$/i)) return 'NULL';
  return tok.raw;
}

// Declaracion de @params de sp_executesql: "@a int, @b nvarchar(10) OUTPUT"
function parseParamDecl(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(text || '') + ',') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      const m = cur.trim().match(/^(@[\w@#$]+)\s+(?:as\s+)?([\s\S]+?)(?:\s*=\s*[\s\S]+?)?(\s+(?:output|out))?(\s+readonly)?$/i);
      if (m) out.push({ name: m[1], type: m[2].trim().toLowerCase().replace(/\s+/g, ' '), output: !!m[3] });
      cur = '';
    } else cur += ch;
  }
  return out;
}

const WRAPPERS = /^sp_(executesql|prepexec|prepexecrpc|cursorprepexec|cursoropen)$/i;

function argFromTok(a, extra = {}) {
  const isNull = isWord(a.tok, /^null$/i);
  const type = inferType(a.tok);
  return {
    name: a.name,
    value: displayValue(a.tok),
    literal: a.tok.raw,
    isNull,
    isVar: a.tok.t === 'var',
    type,
    typeSource: type ? 'inferido' : null,
    output: a.output,
    ...extra,
  };
}

// Elige el EXEC que corresponde al SP capturado (por nombre de objeto o patrones del filtro)
function pickExec(execs, obj, patterns) {
  if (!execs.length) return null;
  const last = (e) => e.parts[e.parts.length - 1].toLowerCase();
  if (obj) {
    const hit = execs.find((e) => last(e) === obj.toLowerCase());
    if (hit) return hit;
  }
  for (const p of patterns || []) {
    const re = new RegExp('^' + (p.includes('%') ? '' : '.*') + p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + (p.includes('%') ? '' : '.*') + '$');
    const hit = execs.find((e) => re.test(last(e)) || re.test(e.name.toLowerCase()));
    if (hit) return hit;
  }
  return execs.find((e) => !WRAPPERS.test(e.parts[e.parts.length - 1])) || execs[0];
}

// r: fila del ring buffer ({ event, obj, stmt, batch, db, ... })
function parseCall(r, patterns) {
  const raw = (r.stmt || r.batch || r.msg || '').trim();
  const base = { proc: r.obj || null, args: [], raw, via: { rpc_completed: 'RPC', sql_batch_completed: 'BATCH', sp_statement_completed: 'STMT', error_reported: 'ERR' }[r.event] || r.event, wrapper: null };
  if (r.event === 'error_reported' || r.event === 'sp_statement_completed') return base;
  const toks = tokenize(raw);
  const exec = pickExec(findExecs(toks), r.obj, patterns);
  if (!exec) return base;
  const procShort = exec.parts[exec.parts.length - 1];

  if (WRAPPERS.test(procShort)) {
    const kind = procShort.toLowerCase();
    // posiciones de @statement / @params segun el procedimiento envoltorio
    const pos = kind === 'sp_executesql' ? { stmt: 0, params: 1, values: 2 }
      : kind === 'sp_prepexec' ? { stmt: 2, params: 1, values: 3 }
        : kind === 'sp_cursorprepexec' ? { stmt: 3, params: 2, values: 6 }
          : { stmt: 1, params: 5, values: 6 }; // sp_cursoropen
    const named = (n) => exec.args.find((a) => a.name && a.name.toLowerCase() === n);
    const stmtArg = (kind === 'sp_executesql' && named('@statement')) || exec.args[pos.stmt];
    const paramsArg = (kind === 'sp_executesql' && named('@params')) || exec.args[pos.params];
    const stmt = stmtArg && stmtArg.tok.t === 'str' ? stmtArg.tok.v : '';
    const decl = paramsArg && paramsArg.tok.t === 'str' ? parseParamDecl(paramsArg.tok.v) : [];
    const valueArgs = exec.args.slice(pos.values).filter((a) => a !== stmtArg && a !== paramsArg);
    const values = new Map();
    valueArgs.forEach((a, idx) => {
      const n = (a.name || (decl[idx] && decl[idx].name) || `@p${idx}`).toLowerCase();
      values.set(n, a);
    });
    const declOf = (n) => decl.find((d) => d.name.toLowerCase() === n.toLowerCase());
    const resolve = (n, fallback) => {
      const v = values.get(n.toLowerCase());
      const d = declOf(n);
      const arg = v ? argFromTok({ name: fallback.name, tok: v.tok, output: fallback.output || v.output }) : argFromTok(fallback);
      if (d) Object.assign(arg, { type: d.type, typeSource: 'declarado' });
      if (v) arg.bound = n;
      return arg;
    };
    const inner = pickExec(findExecs(tokenize(stmt)), r.obj, patterns);
    if (inner) {
      return {
        ...base, wrapper: kind, proc: inner.name,
        args: inner.args.map((a) => (a.tok.t === 'var' && values.has(a.tok.v.toLowerCase()) ? resolve(a.tok.v, a) : argFromTok(a))),
      };
    }
    // Sentencia sin EXEC (consulta parametrizada): se listan los parametros enlazados
    return {
      ...base, wrapper: kind, proc: r.obj || kind,
      args: decl.map((d) => resolve(d.name, { name: d.name, tok: { t: 'word', v: 'DEFAULT', raw: 'DEFAULT' }, output: d.output })),
    };
  }
  // Variables locales del batch: "DECLARE @t decimal(14,2)" aporta el tipo del argumento
  const locals = [];
  for (const m of raw.matchAll(/\bdeclare\s+([^;]*?)(?=;|\n|\bexec(?:ute)?\b|$)/gi)) locals.push(...parseParamDecl(m[1]));
  return {
    ...base, proc: exec.name,
    args: exec.args.map((a) => {
      const arg = argFromTok(a);
      const d = arg.isVar && locals.find((l) => l.name.toLowerCase() === arg.value.toLowerCase());
      return d ? { ...arg, type: d.type, typeSource: 'declarado' } : arg;
    }),
  };
}

// Completa nombres (argumentos posicionales) y tipos con los parametros del catalogo
function applyCatalog(call, params) {
  if (!params) return call;
  const args = call.args.map((a, idx) => {
    const p = a.name ? params.find((x) => x.name.toLowerCase() === a.name.toLowerCase()) : params[idx];
    if (!p) return a;
    return { ...a, name: a.name || p.name, positional: !a.name, type: p.type, typeSource: 'catálogo', declaredByClient: a.typeSource === 'declarado' ? a.type : undefined, output: a.output || false };
  });
  const omitted = params.filter((p) => !args.some((a) => a.name && a.name.toLowerCase() === p.name.toLowerCase()));
  return { ...call, args, omitted, catalog: true };
}

// Version EXEC limpia y ejecutable (sin envoltorio sp_executesql; OUTPUT con variables declaradas)
function buildExec(call, db) {
  if (!call.proc || call.via === 'ERR' || call.via === 'STMT') return null;
  const decls = [], outs = [];
  const parts = call.args.map((a, idx) => {
    let value = a.literal;
    if (a.output || a.isVar) {
      const vn = a.isVar ? a.value : a.name || `@p${idx + 1}`;
      const type = a.type && !/^(nvarchar|varchar)$/.test(a.type) ? a.type : (a.type ? `${a.type}(max)` : 'sql_variant');
      const init = a.isVar ? '' : ` = ${a.literal}`;
      if (!decls.some((d) => d.startsWith(`DECLARE ${vn} `))) decls.push(`DECLARE ${vn} ${type}${init};`);
      value = vn;
      if (a.output) outs.push(`${vn} AS ${'[' + vn.slice(1).replace(/]/g, ']]') + ']'}`);
    }
    return (a.name ? `${a.name} = ` : '') + value + (a.output ? ' OUTPUT' : '');
  });
  const lines = [];
  if (db) lines.push(`USE [${db.replace(/]/g, ']]')}];`);
  lines.push(...decls);
  lines.push(`EXEC ${call.proc}${parts.length ? ' ' + parts.join(', ') : ''};`);
  if (outs.length) lines.push(`SELECT ${outs.join(', ')};`);
  return lines.join('\n');
}

module.exports = { tokenize, parseCall, parseParamDecl, applyCatalog, buildExec, inferType };

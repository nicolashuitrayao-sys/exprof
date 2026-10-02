'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCall, parseParamDecl, applyCatalog, buildExec } = require('../lib/call');
const { redact, connectionString, MASK } = require('../lib/core');

const rpc = (stmt, obj) => ({ event: 'rpc_completed', stmt, obj });

test('RPC con argumentos nombrados e inferencia de tipos', () => {
  const c = parseCall(rpc('exec dbo.usp_RegistrarPedido @ClienteId=3,@Monto=200.50,@Nombre=N\'O\'\'Brien\',@Nada=NULL', 'usp_RegistrarPedido'));
  assert.equal(c.proc, 'dbo.usp_RegistrarPedido');
  assert.equal(c.via, 'RPC');
  assert.deepEqual(c.args.map((a) => [a.name, a.value, a.type]), [
    ['@ClienteId', '3', 'int'],
    ['@Monto', '200.50', 'decimal(5,2)'],
    ['@Nombre', "O'Brien", 'nvarchar'],
    ['@Nada', 'NULL', null],
  ]);
  assert.ok(c.args.every((a) => a.typeSource === 'inferido' || a.type === null));
});

test('RPC sin argumentos', () => {
  const c = parseCall(rpc('exec dbo.usp_ListarClientes ', 'usp_ListarClientes'));
  assert.equal(c.proc, 'dbo.usp_ListarClientes');
  assert.equal(c.args.length, 0);
  assert.equal(buildExec(c, 'ExprofTest'), 'USE [ExprofTest];\nEXEC dbo.usp_ListarClientes;');
});

test('sp_executesql: resuelve valores y tipos declarados', () => {
  const c = parseCall(rpc("exec sp_executesql N'EXEC dbo.usp_ObtenerPedidosCliente @ClienteId=@a, @Desde=@b',N'@a int,@b datetime2(7)',@a=7,@b='2026-01-01'", 'sp_executesql'), ['usp_Obtener']);
  assert.equal(c.wrapper, 'sp_executesql');
  assert.equal(c.proc, 'dbo.usp_ObtenerPedidosCliente');
  assert.deepEqual(c.args.map((a) => [a.name, a.value, a.type, a.typeSource]), [
    ['@ClienteId', '7', 'int', 'declarado'],
    ['@Desde', '2026-01-01', 'datetime2(7)', 'declarado'],
  ]);
  assert.equal(buildExec(c), "EXEC dbo.usp_ObtenerPedidosCliente @ClienteId = 7, @Desde = '2026-01-01';");
});

test('sp_executesql posicional con valores sin nombre', () => {
  const c = parseCall(rpc("exec sp_executesql N'EXEC usp_X @P1', N'@P1 nvarchar(20)', N'hola'"));
  assert.equal(c.proc, 'usp_X');
  assert.deepEqual(c.args.map((a) => [a.name, a.value, a.type]), [[null, 'hola', 'nvarchar(20)']]);
});

test('batch con varios EXEC elige el del filtro y respeta negativos y OUTPUT', () => {
  const batch = "SET NOCOUNT ON; DECLARE @t decimal(14,2);\nEXEC dbo.usp_Otro 1;\nEXECUTE dbo.usp_CalcularTotal -5, @t OUTPUT; SELECT @t";
  const c = parseCall({ event: 'sql_batch_completed', batch }, ['usp_Calcular']);
  assert.equal(c.via, 'BATCH');
  assert.equal(c.proc, 'dbo.usp_CalcularTotal');
  assert.deepEqual(c.args.map((a) => [a.name, a.value, a.output]), [[null, '-5', false], [null, '@t', true]]);
  assert.deepEqual([c.args[1].type, c.args[1].typeSource], ['decimal(14,2)', 'declarado']);
  assert.equal(buildExec(c), 'DECLARE @t decimal(14,2);\nEXEC dbo.usp_CalcularTotal -5, @t OUTPUT;\nSELECT @t AS [t];');
});

test('catalogo: nombra posicionales y prioriza tipos declarados en el SP', () => {
  const c = parseCall({ event: 'sql_batch_completed', batch: 'EXEC dbo.usp_CalcularTotal 1, @t OUTPUT' }, ['usp_Calcular']);
  const e = applyCatalog(c, [
    { name: '@ClienteId', type: 'int', output: false },
    { name: '@Total', type: 'decimal(14,2)', output: true },
    { name: '@Extra', type: 'bit', output: false },
  ]);
  assert.deepEqual(e.args.map((a) => [a.name, a.type, a.typeSource]), [['@ClienteId', 'int', 'catálogo'], ['@Total', 'decimal(14,2)', 'catálogo']]);
  assert.deepEqual(e.omitted.map((p) => p.name), ['@Extra']);
  assert.equal(buildExec(e, 'Db'), 'USE [Db];\nDECLARE @t decimal(14,2);\nEXEC dbo.usp_CalcularTotal @ClienteId = 1, @Total = @t OUTPUT;\nSELECT @t AS [t];');
});

test('parseParamDecl con precision y OUTPUT', () => {
  assert.deepEqual(parseParamDecl('@a decimal(12, 2),@b nvarchar(max) OUTPUT, @c int'), [
    { name: '@a', type: 'decimal(12, 2)', output: false },
    { name: '@b', type: 'nvarchar(max)', output: true },
    { name: '@c', type: 'int', output: false },
  ]);
});

test('redact oculta valores y conserva la estructura', () => {
  assert.equal(redact("exec dbo.usp_X @Rut=N'11.111.111-1',@Monto=1500"), "exec dbo.usp_X @Rut=N'?',@Monto=?");
  assert.equal(redact("exec sp_executesql N'EXEC usp_X @a=@p0',N'@p0 int',@p0=42"), "exec sp_executesql N'EXEC usp_X @a=@p0',N'@p0 int',@p0=?");
});

test('la cadena de conexion nunca muestra la clave ni su largo', () => {
  const s = connectionString({ server: 'srv,1433', database: 'master', user: 'u', password: 'MuySecreta#2026' });
  assert.ok(!s.includes('MuySecreta'));
  assert.ok(s.includes(`Password=${MASK}`));
  assert.ok(connectionString({ server: 's', database: 'd', user: 'u', password: 'x' }).includes(`Password=${MASK}`));
});

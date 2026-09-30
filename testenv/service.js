// Servicio de prueba: llama SPs cada 5 s contra ExprofTest (usa el mssql de ../node_modules)
const sql = require('../node_modules/mssql');
const cfg = {
  server: process.env.SVC_HOST || 'localhost', port: Number(process.env.SVC_PORT || 14330),
  user: process.env.SVC_USER || 'app_user', password: process.env.SVC_PASSWORD || 'App_User#2026',
  database: 'ExprofTest', options: { trustServerCertificate: true, appName: 'exprof-test-service' },
};
let n = 0;
async function tick() {
  n++;
  const p = await sql.connect(cfg);
  const one = (name, inputs = {}) => {
    const r = p.request();
    for (const [k, v] of Object.entries(inputs)) r.input(k, v);
    return r.execute(name);
  };
  await one('dbo.usp_ListarClientes');
  await one('dbo.usp_ObtenerPedidosCliente', { ClienteId: 1 + (n % 3) });
  await one('dbo.usp_ResumenVentas');
  if (n % 2 === 0) await one('dbo.usp_RegistrarPedido', { ClienteId: 1 + (n % 3), Monto: 100 * n });
  if (n % 4 === 0) await one('dbo.usp_Falla').catch((e) => console.log(`[svc] usp_Falla fallo (esperado): ${e.message}`));
  await p.request().query('SELECT COUNT(*) AS n FROM dbo.Pedidos'); // consulta ad-hoc, no es SP
  console.log(`[svc] ciclo ${n} ok`);
}
console.log('[svc] iniciando, ciclo cada 5s');
tick().catch(console.error);
setInterval(() => tick().catch((e) => console.error('[svc]', e.message)), 5000);

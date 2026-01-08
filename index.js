const express = require('express');
const sql = require('mssql');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: { encrypt: false, trustServerCertificate: true }
};

const poolMainPromise = new sql.ConnectionPool(dbConfig).connect();
const cleanParam = (p) => p ? p.toString().replace(':1', '').trim() : '';

// 1. SUCURSALES
app.get('/api/sucursales', async (req, res) => {
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().query("SELECT CODSUC, NOMBRE FROM QRSUCURSALES WHERE CODEMP <> 1 AND CODSUC NOT IN (996, 997) ORDER BY NOMBRE");
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. VENTAS
app.get('/api/facturas', async (req, res) => {
    let { sucursal, desde, hasta, articulo } = req.query;
    try {
        const pool = await poolMainPromise;
        let q = `SELECT A.CODCMP, A.PREFIJO, A.NUMERO, CONVERT(VARCHAR(10), A.FECHA, 103) AS FECHA_STR, B.CODITM, B.CANTIDAD1 AS cant, CAST(B.PRECIO AS MONEY) AS pre, ISNULL(B.OBSERVACIONES, '') AS obs, CASE WHEN C.CODPAG = '001' THEN 'EFECTIVO' WHEN C.CODPAG = '100' THEN 'TARJETA' WHEN C.CODPAG IN ('125','225') THEN 'MERCADOPAGO' ELSE 'OTRO' END AS pago_desc, CAST(A.TOTAL AS MONEY) AS total_comprobante FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter INNER JOIN dbo.QRLineasPago C ON A.IdRouter = C.IdRouter WHERE A.CODSUC = @suc AND CAST(A.FECHA AS DATE) >= CAST(@desde AS DATE) AND CAST(A.FECHA AS DATE) <= CAST(@hasta AS DATE) AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND A.IDCOMPROBANTE > 0`;
        if (cleanParam(articulo) !== "") q += ` AND A.IdRouter IN (SELECT IdRouter FROM dbo.QRLINEASITEMS WHERE CODITM LIKE '%' + @art + '%')`;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).input('art', sql.VarChar, cleanParam(articulo)).query(q);
        const facturas = {}; const procesados = new Set();
        let ef = 0, tj = 0, mp = 0, gr = 0, cFA = 0, cNC = 0;
        result.recordset.forEach(r => {
            const k = `${r.CODCMP}-${r.PREFIJO}-${r.NUMERO}`;
            if (!facturas[k]) {
                facturas[k] = { prefijo: r.PREFIJO, numero: r.NUMERO, tipo: r.CODCMP, fecha: r.FECHA_STR, pago: r.pago_desc, totalTicket: r.total_comprobante, items: [] };
                if (!procesados.has(k)) {
                    const factor = r.CODCMP.startsWith('C') ? -1 : 1;
                    const val = r.total_comprobante * factor;
                    if (r.pago_desc === 'EFECTIVO') ef += val; else if (r.pago_desc === 'TARJETA') tj += val; else if (r.pago_desc === 'MERCADOPAGO') mp += val;
                    if (r.CODCMP.startsWith('F')) cFA++; else cNC++;
                    gr += val; procesados.add(k);
                }
            }
            facturas[k].items.push({ cod: r.CODITM, cant: r.cant, pre: r.pre, obs: r.obs });
        });
        res.json({ datos: Object.values(facturas), totales: { efectivo: ef, tarjeta: tj, mp: mp, general: gr, facturas: cFA, notas: cNC } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. MEDIOS DE PAGO
app.get('/api/reporte/medios-pago', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).query(`SELECT J.CODPAG, CASE WHEN J.CODPAG = '100' THEN ISNULL(T.DESCRIPCION, 'TARJETA') WHEN J.CODPAG = '001' THEN 'EFECTIVO' WHEN J.CODPAG IN ('125','225') THEN 'MERCADO PAGO' ELSE M.DESCRIPCION END AS MEDIO, ISNULL(P.DESCRIPCION, 'N/A') AS PLAN_PAGO, COUNT(DISTINCT A.IdRouter) AS TICKETS, CAST(SUM(CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -J.IMPORTE ELSE J.IMPORTE END) AS MONEY) AS TOTAL_NETO FROM dbo.QRMVS A INNER JOIN dbo.QRLineasPago J ON A.IdRouter = J.IdRouter INNER JOIN dbo.QRMediosPago M ON J.CODPAG = M.CODPAG LEFT JOIN dbo.QRCUPONES C ON J.IDCUPON = C.IDCUPON AND J.CODPAG = '100' LEFT JOIN dbo.QRTARJETAS T ON C.CODTARjeta = T.CODTARjeta LEFT JOIN dbo.QRTarjetplanes P ON C.CODPLAn = P.CODPLAn WHERE A.CODSUC = @suc AND A.IDCOMPROBANTE > 0 AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND CAST(A.FECHA AS DATE) >= CAST(@desde AS DATE) AND CAST(A.FECHA AS DATE) <= CAST(@hasta AS DATE) GROUP BY J.CODPAG, M.DESCRIPCION, T.DESCRIPCION, P.DESCRIPCION ORDER BY TOTAL_NETO DESC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. FRANJAS
app.get('/api/reporte/franjas', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).query(`SELECT CASE WHEN DATEPART(HOUR, timestamp) >= 9 AND DATEPART(HOUR, timestamp) < 13 THEN 'MAÑANA (09-13hs)' WHEN DATEPART(HOUR, timestamp) >= 13 AND DATEPART(HOUR, timestamp) < 17 THEN 'TARDE 1 (13-17hs)' ELSE 'TARDE 2 (17-22hs)' END AS FRANJA, COUNT(DISTINCT CAST(CODCMP AS VARCHAR)+CAST(PREFIJO AS VARCHAR)+CAST(NUMERO AS VARCHAR)) AS TICKETS, SUM(CAST(TOTAL AS MONEY)) AS TOTAL_VENTAS FROM dbo.QRMVS WHERE CODSUC = @suc AND CAST(FECHA AS DATE) >= CAST(@desde AS DATE) AND CAST(FECHA AS DATE) <= CAST(@hasta AS DATE) AND CODCMP IN ('FA', 'FB', 'CA', 'CB') AND IDCOMPROBANTE > 0 GROUP BY CASE WHEN DATEPART(HOUR, timestamp) >= 9 AND DATEPART(HOUR, timestamp) < 13 THEN 'MAÑANA (09-13hs)' WHEN DATEPART(HOUR, timestamp) >= 13 AND DATEPART(HOUR, timestamp) < 17 THEN 'TARDE 1 (13-17hs)' ELSE 'TARDE 2 (17-22hs)' END ORDER BY MIN(timestamp)`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. TICKET PROMEDIO
app.get('/api/reporte/ticket-promedio', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).query(`SELECT CONVERT(VARCHAR(10), FECHA, 103) AS FECHA, COUNT(DISTINCT CAST(CODCMP AS VARCHAR)+CAST(PREFIJO AS VARCHAR)+CAST(NUMERO AS VARCHAR)) AS TICKETS, SUM(CAST(TOTAL AS MONEY)) AS VENTA_NETA FROM dbo.QRMVS WHERE CODSUC = @suc AND CAST(FECHA AS DATE) >= CAST(@desde AS DATE) AND CAST(FECHA AS DATE) <= CAST(@hasta AS DATE) AND CODCMP IN ('FA','FB', 'CA', 'CB') AND IDCOMPROBANTE > 0 GROUP BY CONVERT(VARCHAR(10), FECHA, 103) ORDER BY FECHA DESC`);
        const datosConPromedio = result.recordset.map(r => ({ ...r, PROMEDIO: r.TICKETS > 0 ? (r.VENTA_NETA / r.TICKETS) : 0 }));
        const totalVenta = result.recordset.reduce((a, r) => a + r.VENTA_NETA, 0);
        const totalTickets = result.recordset.reduce((a, r) => a + r.TICKETS, 0);
        res.json({ datos: datosConPromedio, resumen: { venta: totalVenta, tickets: totalTickets, promedio: totalTickets > 0 ? totalVenta / totalTickets : 0 } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. STOCK FÍSICO
app.get('/api/reporte/stock-fisico', async (req, res) => {
    let { sucursal, articulo } = req.query;
    try {
        const pool = await poolMainPromise;
        let q = `SELECT S.CODITM, I.DESCRIPCION, CAST(S.STKACTUAL AS INT) AS STOCK FROM dbo.QRITEMSACUM S INNER JOIN dbo.QRITEMS I ON S.CODITM = I.CODITM WHERE S.CODSUC = @suc AND S.STKACTUAL <> 0`;
        if (cleanParam(articulo) !== "") q += ` AND S.CODITM LIKE '%' + @art + '%'`;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('art', sql.VarChar, cleanParam(articulo)).query(q + " ORDER BY S.CODITM");
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. STOCK VALORIZADO
app.get('/api/reporte/stock-valorizado', async (req, res) => {
    let { sucursal } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).query(`SELECT A.CODITM, CAST(A.STKACTUAL AS MONEY) AS STKACTUAL, CAST(B.PRECIO AS MONEY) AS PRECIO_UNITARIO, CAST(A.STKACTUAL * B.PRECIO AS MONEY) AS TOTAL_VALORIZADO FROM QRITEMSACUM A INNER JOIN QRLISTASPRECIOS B ON A.CODITM = B.CODITM WHERE A.CODSUC = @suc AND B.CODLIS = 'PCI' AND A.STKACTUAL > 0 ORDER BY TOTAL_VALORIZADO DESC`);
        const total = result.recordset.reduce((acc, r) => acc + r.TOTAL_VALORIZADO, 0);
        res.json({ detalles: result.recordset, totalCartera: total });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. MOVIMIENTOS LOGÍSTICA
app.get('/api/reporte/logistica', async (req, res) => {
    let { sucursal, desde, hasta, articulo } = req.query;
    try {
        const pool = await poolMainPromise;
        let q = `SELECT CONVERT(VARCHAR(10), A.FECHA, 103) AS FECHA_STR, A.CODCMP, A.PREFIJO, A.NUMERO, H.DESCRIPCION AS CONCEPTO, B.CODITM, CAST(B.CANTIDAD1 AS INT) AS CANT FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter INNER JOIN dbo.QRMVSMAT G ON G.IdRouter = A.IdRouter INNER JOIN dbo.QRConceptos H ON G.CodConcepto = H.CODCPT WHERE A.CODSUC = @suc AND CAST(A.FECHA AS DATE) >= CAST(@desde AS DATE) AND CAST(A.FECHA AS DATE) <= CAST(@hasta AS DATE) AND A.CODCMP IN ('EE', 'IE') AND A.IDCOMPROBANTE > 0`;
        if (cleanParam(articulo) !== "") q += ` AND B.CODITM LIKE '%' + @art + '%'`;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).input('art', sql.VarChar, cleanParam(articulo)).query(q + " ORDER BY A.FECHA DESC");
        const movs = {};
        result.recordset.forEach(r => {
            const k = `${r.CODCMP}-${r.PREFIJO}-${r.NUMERO}`;
            if (!movs[k]) movs[k] = { tipo: r.CODCMP, prefijo: r.PREFIJO, numero: r.NUMERO, fecha: r.FECHA_STR, concepto: r.CONCEPTO, items: [] };
            movs[k].items.push({ cod: r.CODITM, cant: r.CANT });
        });
        res.json(Object.values(movs));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. RANKING TOP 5 (EXCLUYENDO DIFPRECIO)
app.get('/api/reporte/ranking', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).query(`
            SELECT TOP 5 B.CODITM AS ARTICULO, C.DESCRIPCION, SUM(CAST(B.CANTIDAD1 AS MONEY)) AS UNIDADES, SUM(CAST(B.CANTIDAD1 * B.PRECIO AS MONEY)) AS RECAUDACION_NETA 
            FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter INNER JOIN dbo.QRITEMS C ON C.CODITM = B.CODITM 
            WHERE A.CODSUC = @suc AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta 
            AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND A.IDCOMPROBANTE > 0 
            AND B.CODITM NOT LIKE 'DC%' AND B.CODITM NOT IN ('ajucen', 'SCAMBIO', 'difprecio', 'AJS')
            GROUP BY B.CODITM, C.DESCRIPCION ORDER BY UNIDADES DESC`);
        res.json({ ranking: result.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Master Server Activo en Puerto ${PORT}`));
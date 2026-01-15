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

// --- 1. SUCURSALES ---
app.get('/api/sucursales', async (req, res) => {
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().query("SELECT CODSUC, NOMBRE FROM QRSUCURSALES WHERE CODEMP <> 1 AND CODSUC NOT IN (996, 997) ORDER BY NOMBRE");
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. AUDITORÍA DE VENTAS ---
app.get('/api/facturas', async (req, res) => {
    let { sucursal, desde, hasta, articulo, medioPago } = req.query;
    try {
        const pool = await poolMainPromise;
        let q = `
            WITH FacturasBase AS (
                SELECT A.CODCMP, A.PREFIJO, A.NUMERO, A.IdRouter,
                CONVERT(VARCHAR(10), A.FECHA, 103) AS FECHA_STR, 
                CAST(A.TOTAL AS MONEY) AS total_comprobante,
                ISNULL((SELECT TOP 1 CASE 
                    WHEN CODPAG = '001' THEN 'EFECTIVO' 
                    WHEN CODPAG = '100' THEN 'TARJETAS' 
                    WHEN CODPAG IN ('125','225') THEN 'MERCADO PAGO' 
                    ELSE 'EFECTIVO' END 
                 FROM dbo.QRLineasPago WHERE IdRouter = A.IdRouter), 'EFECTIVO') AS pago_desc
                FROM dbo.QRMVS A 
                WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) 
                AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta 
                AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND A.IDCOMPROBANTE > 0 AND A.ANULADO = 0
            )
            SELECT * FROM FacturasBase WHERE 1=1`;
        
        if (cleanParam(articulo) !== "") q += ` AND IdRouter IN (SELECT IdRouter FROM dbo.QRLINEASITEMS WHERE CODITM LIKE '%' + @art + '%')`;
        if (cleanParam(medioPago) !== "" && cleanParam(medioPago) !== "TODOS") q += ` AND pago_desc = @mpago`;
        
        const request = pool.request()
            .input('suc', sql.Int, cleanParam(sucursal))
            .input('desde', sql.VarChar, cleanParam(desde))
            .input('hasta', sql.VarChar, cleanParam(hasta))
            .input('art', sql.VarChar, cleanParam(articulo))
            .input('mpago', sql.VarChar, cleanParam(medioPago));
            
        const result = await request.query(q);
        let ef = 0, tj = 0, mp = 0, gr = 0, cFA = 0, cNC = 0;
        
        const facturas = result.recordset.map(r => {
            const factor = (r.CODCMP === 'CA' || r.CODCMP === 'CB') ? -1 : 1;
            const netoReal = r.total_comprobante * factor;
            if (r.pago_desc === 'EFECTIVO') ef += netoReal;
            else if (r.pago_desc === 'TARJETAS') tj += netoReal;
            else if (r.pago_desc === 'MERCADO PAGO') mp += netoReal;
            else ef += netoReal;
            if (factor === 1) cFA++; else cNC++;
            gr += netoReal;
            return { prefijo: r.PREFIJO, numero: r.NUMERO, tipo: r.CODCMP, fecha: r.FECHA_STR, pago: r.pago_desc, totalTicket: r.total_comprobante, IdRouter: r.IdRouter, items: [] };
        });

        if (facturas.length > 0) {
            const ids = result.recordset.map(r => `'${r.IdRouter}'`).join(',');
            const itemsRes = await pool.request().query(`SELECT IdRouter, CODITM, CANTIDAD1, PRECIO, OBSERVACIONES FROM QRLINEASITEMS WHERE IdRouter IN (${ids})`);
            facturas.forEach(f => { f.items = itemsRes.recordset.filter(i => i.IdRouter === f.IdRouter).map(i => ({ cod: i.CODITM, cant: i.CANTIDAD1, pre: i.PRECIO, obs: i.OBSERVACIONES })); });
        }
        res.json({ datos: facturas, totales: { efectivo: ef, tarjeta: tj, mp: mp, general: gr, facturas: cFA, notas: cNC } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. MEDIOS DE PAGO ---
app.get('/api/reporte/medios-pago', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, cleanParam(sucursal))
            .input('desde', sql.VarChar, cleanParam(desde))
            .input('hasta', sql.VarChar, cleanParam(hasta))
            .query(`
                SELECT Calc.MEDIO, COUNT(DISTINCT A.IdRouter) AS TICKETS,
                CAST(SUM(CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -A.TOTAL ELSE A.TOTAL END) AS MONEY) AS TOTAL_NETO
                FROM dbo.QRMVS A
                CROSS APPLY (SELECT TOP 1 CASE WHEN P.CODPAG = '001' THEN 'EFECTIVO' WHEN P.CODPAG = '100' THEN 'TARJETAS' WHEN P.CODPAG IN ('125','225') THEN 'MERCADO PAGO' ELSE 'EFECTIVO' END AS MEDIO FROM dbo.QRLineasPago P WHERE P.IdRouter = A.IdRouter) Calc
                WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) AND A.IDCOMPROBANTE > 0 AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta AND A.ANULADO = 0
                GROUP BY Calc.MEDIO ORDER BY TOTAL_NETO DESC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. FRANJAS HORARIAS ---
app.get('/api/reporte/franjas', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, cleanParam(sucursal))
            .input('desde', sql.VarChar, cleanParam(desde))
            .input('hasta', sql.VarChar, cleanParam(hasta))
            .query(`
                SET LANGUAGE Spanish;
                WITH MasterFranjas AS (
                    SELECT 'MAÑANA (09-13hs)' AS F_NOM, 1 AS Ord
                    UNION ALL SELECT 'TARDE 1 (13-17hs)', 2
                    UNION ALL SELECT 'TARDE 2 (17-22hs)', 3
                ),
                Ventas AS (
                    SELECT 
                        A.IdRouter,
                        (CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -A.TOTAL ELSE A.TOTAL END) as MONTO,
                        CASE 
                            WHEN DATEPART(HOUR, A.timestamp) >= 9 AND DATEPART(HOUR, A.timestamp) < 13 THEN 'MAÑANA (09-13hs)' 
                            WHEN DATEPART(HOUR, A.timestamp) >= 13 AND DATEPART(HOUR, A.timestamp) < 17 THEN 'TARDE 1 (13-17hs)' 
                            ELSE 'TARDE 2 (17-22hs)' 
                        END AS F_ASIG
                    FROM dbo.QRMVS A 
                    WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR)
                      AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
                      AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') 
                      AND A.IDCOMPROBANTE > 0 AND A.ANULADO = 0
                )
                SELECT M.F_NOM AS FRANJA, COUNT(V.IdRouter) AS TICKETS, ISNULL(SUM(V.MONTO), 0) AS TOTAL_VENTAS
                FROM MasterFranjas M
                LEFT JOIN Ventas V ON M.F_NOM = V.F_ASIG
                GROUP BY M.F_NOM, M.Ord ORDER BY M.Ord`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. TICKET PROMEDIO ---
app.get('/api/reporte/ticket-promedio', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, cleanParam(sucursal))
            .input('desde', sql.VarChar, cleanParam(desde))
            .input('hasta', sql.VarChar, cleanParam(hasta))
            .query(`
                SELECT CONVERT(VARCHAR(10), FECHA, 103) AS FECHA, COUNT(DISTINCT IdRouter) AS TICKETS, 
                SUM(CASE WHEN CODCMP IN ('CA', 'CB') THEN -TOTAL ELSE TOTAL END) AS VENTA_NETA 
                FROM dbo.QRMVS WHERE CAST(CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) AND CAST(FECHA AS DATE) BETWEEN @desde AND @hasta AND CODCMP IN ('FA','FB', 'CA', 'CB') AND IDCOMPROBANTE > 0 AND ANULADO = 0 GROUP BY CONVERT(VARCHAR(10), FECHA, 103) ORDER BY FECHA DESC`);
        const totalVenta = result.recordset.reduce((a, r) => a + r.VENTA_NETA, 0);
        const totalTickets = result.recordset.reduce((a, r) => a + r.TICKETS, 0);
        res.json({ datos: result.recordset, resumen: { venta: totalVenta, tickets: totalTickets, promedio: totalTickets > 0 ? totalVenta / totalTickets : 0 } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. STOCK FÍSICO ---
app.get('/api/reporte/stock-fisico', async (req, res) => {
    let { sucursal, articulo } = req.query;
    try {
        const pool = await poolMainPromise;
        let q = `SELECT S.CODITM, I.DESCRIPCION, CAST(S.STKACTUAL AS INT) AS STOCK FROM dbo.QRITEMSACUM S INNER JOIN dbo.QRITEMS I ON S.CODITM = I.CODITM WHERE CAST(S.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) AND S.STKACTUAL > 0`;
        if (cleanParam(articulo) !== "") q += ` AND S.CODITM LIKE '%' + @art + '%'`;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('art', sql.VarChar, cleanParam(articulo)).query(q + " ORDER BY S.CODITM");
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 7. STOCK VALORIZADO ---
app.get('/api/reporte/stock-valorizado', async (req, res) => {
    let { sucursal } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, cleanParam(sucursal))
            .query(`
                SELECT A.CODITM, C.DESCRIPCION, CAST(A.STKACTUAL AS INT) AS STKACTUAL, ISNULL(P.PRECIO, 0) AS PRECIO_UNITARIO,
                ISNULL(CAST(A.STKACTUAL * P.PRECIO AS MONEY), 0) AS TOTAL_VALORIZADO, ISNULL(R.RUBRO_DESC, 'SIN RUBRO') AS RUBRO
                FROM dbo.QRITEMSACUM A INNER JOIN dbo.QRITEMS C ON A.CODITM = C.CODITM
                OUTER APPLY (SELECT TOP 1 PRECIO FROM dbo.QRLISTASPRECIOS WHERE CODITM = A.CODITM AND CODLIS = 'PCI') P
                OUTER APPLY (SELECT TOP 1 VAL.DESCRIPCION AS RUBRO_DESC FROM dbo.QRITEMSATRIB ATR INNER JOIN dbo.QRATRIBUTOSVAL VAL ON ATR.CODATR = VAL.CODATR AND ATR.CODATRVAL = VAL.CODATRVAL WHERE ATR.CODITM = A.CODITM AND ATR.CODATR = 'R') R
                WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) AND A.STKACTUAL > 0 ORDER BY TOTAL_VALORIZADO DESC`);
        res.json({ detalles: result.recordset, totalCartera: result.recordset.reduce((acc, r) => acc + r.TOTAL_VALORIZADO, 0) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 8. LOGÍSTICA (IE/EE) ---
app.get('/api/reporte/logistica', async (req, res) => {
    let { sucursal, desde, hasta, articulo } = req.query;
    try {
        const pool = await poolMainPromise;
        let q = `SELECT CONVERT(VARCHAR(10), A.FECHA, 103) AS FECHA_STR, A.CODCMP, A.PREFIJO, A.NUMERO, H.DESCRIPCION AS CONCEPTO, B.CODITM, CAST(B.CANTIDAD1 AS INT) AS CANT FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter INNER JOIN dbo.QRMVSMAT G ON G.IdRouter = A.IdRouter INNER JOIN dbo.QRConceptos H ON G.CodConcepto = H.CODCPT WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta AND A.CODCMP IN ('EE', 'IE') AND A.IDCOMPROBANTE > 0 AND A.ANULADO = 0`;
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

// --- 9. RANKING TOP ARTÍCULOS ---
app.get('/api/reporte/ranking', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().input('suc', sql.Int, cleanParam(sucursal)).input('desde', sql.VarChar, cleanParam(desde)).input('hasta', sql.VarChar, cleanParam(hasta)).query(`
            SELECT TOP 5 B.CODITM AS ARTICULO, C.DESCRIPCION, SUM(CAST(CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -B.CANTIDAD1 ELSE B.CANTIDAD1 END AS MONEY)) AS UNIDADES, SUM(CAST(CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -B.CANTIDAD1 ELSE B.CANTIDAD1 END * B.PRECIO AS MONEY)) AS RECAUDACION_NETA 
            FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter INNER JOIN dbo.QRITEMS C ON C.CODITM = B.CODITM 
            WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR) AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND A.IDCOMPROBANTE > 0 AND A.ANULADO = 0 
            AND B.CODITM NOT LIKE 'DC%' AND B.CODITM NOT IN ('ajucen', 'SCAMBIO', 'difprecio', 'AJS')
            GROUP BY B.CODITM, C.DESCRIPCION ORDER BY UNIDADES DESC`);
        res.json({ ranking: result.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 10. COMPARATIVO HISTÓRICO (INICIO LUNES + FECHAISO) ---
app.get('/api/reporte/comparativo-ventas', async (req, res) => {
    let { sucursal, fechaRef } = req.query; 
    let targetDate = fechaRef ? new Date(fechaRef + 'T12:00:00') : new Date();

    // Calculamos el Lunes de esa semana
    const day = targetDate.getDay();
    const diff = targetDate.getDate() - day + (day === 0 ? -6 : 1); 
    const lunesSemana = new Date(targetDate.setDate(diff)).toISOString().split('T')[0];

    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.VarChar, sucursal)
            .input('fechaRef', sql.Date, lunesSemana)
            .query(`
                SET LANGUAGE Spanish;
                WITH Calendario AS (
                    SELECT CAST(@fechaRef AS DATE) as FechaAct, DATEADD(DAY, -7, @fechaRef) as FechaSemAnt, DATEADD(DAY, -28, @fechaRef) as FechaMesAnt, 0 as Orden
                    UNION ALL SELECT DATEADD(DAY, 1, @fechaRef), DATEADD(DAY, -6, @fechaRef), DATEADD(DAY, -27, @fechaRef), 1
                    UNION ALL SELECT DATEADD(DAY, 2, @fechaRef), DATEADD(DAY, -5, @fechaRef), DATEADD(DAY, -26, @fechaRef), 2
                    UNION ALL SELECT DATEADD(DAY, 3, @fechaRef), DATEADD(DAY, -4, @fechaRef), DATEADD(DAY, -25, @fechaRef), 3
                    UNION ALL SELECT DATEADD(DAY, 4, @fechaRef), DATEADD(DAY, -3, @fechaRef), DATEADD(DAY, -24, @fechaRef), 4
                    UNION ALL SELECT DATEADD(DAY, 5, @fechaRef), DATEADD(DAY, -2, @fechaRef), DATEADD(DAY, -23, @fechaRef), 5
                    UNION ALL SELECT DATEADD(DAY, 6, @fechaRef), DATEADD(DAY, -1, @fechaRef), DATEADD(DAY, -22, @fechaRef), 6
                ),
                VentasBase AS (
                    SELECT 
                        CAST(M.FECHA AS DATE) as F,
                        SUM(CASE WHEN M.CODCMP IN ('CA', 'CB') THEN -M.TOTAL ELSE M.TOTAL END) as MontoDia,
                        ISNULL((
                            SELECT SUM(CASE WHEN M2.CODCMP IN ('CA', 'CB') THEN -I.CANTIDAD1 ELSE I.CANTIDAD1 END)
                            FROM dbo.QRMVS M2
                            INNER JOIN dbo.QRLINEASITEMS I ON M2.IdRouter = I.IdRouter
                            WHERE CAST(M2.FECHA AS DATE) = CAST(M.FECHA AS DATE)
                              AND CAST(M2.CODSUC AS VARCHAR) LIKE '%' + @suc
                              AND M2.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND M2.ANULADO = 0 AND M2.IDCOMPROBANTE > 0
                              AND I.CODITM NOT LIKE 'DC%'
                        ), 0) as UnidadesDia
                    FROM dbo.QRMVS M
                    WHERE CAST(M.CODSUC AS VARCHAR) LIKE '%' + @suc
                      AND M.CODCMP IN ('FA', 'FB', 'CA', 'CB') AND M.ANULADO = 0 AND M.IDCOMPROBANTE > 0
                    GROUP BY CAST(M.FECHA AS DATE)
                )
                SELECT 
                    FORMAT(C.FechaAct, 'dd/MM') as FechaLabel,
                    UPPER(LEFT(DATENAME(WEEKDAY, C.FechaAct), 3)) as DiaSemana,
                    FORMAT(C.FechaSemAnt, 'dd/MM') as LabelSem,
                    FORMAT(C.FechaMesAnt, 'dd/MM') as LabelMes,
                    '$ ' + FORMAT(ISNULL(V1.MontoDia, 0), '#,0.00') as MontoActStr,
                    CAST(ISNULL(V1.MontoDia, 0) AS FLOAT) as MontoAct, 
                    CAST(ISNULL(V2.MontoDia, 0) AS FLOAT) as MontoSem, 
                    CAST(ISNULL(V3.MontoDia, 0) AS FLOAT) as MontoMes,
                    CAST(ISNULL(V1.UnidadesDia, 0) AS INT) as UniAct,
                    CAST(ISNULL(V2.UnidadesDia, 0) AS INT) as UniSem,
                    CAST(ISNULL(V3.UnidadesDia, 0) AS INT) as UniMes,
                    CONVERT(VARCHAR, C.FechaAct, 126) as FechaIso
                FROM Calendario C
                LEFT JOIN VentasBase V1 ON V1.F = C.FechaAct
                LEFT JOIN VentasBase V2 ON V2.F = C.FechaSemAnt
                LEFT JOIN VentasBase V3 ON V3.F = C.FechaMesAnt
                ORDER BY C.Orden ASC
            `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 11. RUBROS ---
app.get('/api/reporte/rubros', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.VarChar, sucursal)
            .input('desde', sql.Date, desde)
            .input('hasta', sql.Date, hasta)
            .query(`
                WITH ItemsLimpios AS (
                    SELECT 
                        A.IdRouter, B.CODITM, A.CODCMP,
                        ISNULL((SELECT TOP 1 VAL.DESCRIPCION FROM dbo.QRITEMSATRIB ATR 
                                INNER JOIN dbo.QRATRIBUTOSVAL VAL ON ATR.CODATR = VAL.CODATR AND ATR.CODATRVAL = VAL.CODATRVAL 
                                WHERE ATR.CODITM = B.CODITM AND ATR.CODATR = 'R'), 'SIN RUBRO') AS RubroNombre,
                        B.CANTIDAD1 as CantidadFila
                    FROM dbo.QRMVS A
                    INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
                    WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + @suc
                      AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
                      AND A.ANULADO = 0 AND B.IDCOMPROBANTE > 0
                      AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB')
                      AND B.CODITM NOT LIKE 'DC%'
                )
                SELECT 
                    RubroNombre AS Rubro,
                    CAST(SUM(CASE WHEN CODCMP IN ('CA', 'CB') THEN -CantidadFila ELSE CantidadFila END) AS INT) AS TotalUnidades
                FROM ItemsLimpios
                GROUP BY RubroNombre
                ORDER BY TotalUnidades DESC;
            `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 12. DESCUENTOS ---
app.get('/api/reporte/auditoria-descuentos', async (req, res) => {
    let { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.VarChar, sucursal)
            .input('desde', sql.Date, desde)
            .input('hasta', sql.Date, hasta)
            .query(`
                WITH VentasYDescuentos AS (
                    SELECT A.IdRouter, B.CODITM, CAST(B.DESCRIPCION AS VARCHAR(MAX)) as DescripcionItem,
                    CASE WHEN B.CODITM LIKE 'DC%' THEN 'DESCUENTO' ELSE 'PRODUCTO' END AS TipoFila,
                    CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -B.IMPORTE ELSE B.IMPORTE END AS ImporteNeto
                    FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
                    WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + @suc AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
                    AND A.ANULADO = 0 AND B.IDCOMPROBANTE > 0
                ),
                GlobalBruto AS (SELECT SUM(ImporteNeto) as VentaBrutaTotal FROM VentasYDescuentos WHERE TipoFila = 'PRODUCTO')
                
                SELECT 'RESUMEN' as TipoFila, 'TOTAL' as Concepto, '' as Codigo, 
                CAST(ISNULL((SELECT VentaBrutaTotal FROM GlobalBruto), 0) AS MONEY) as ValBruto,
                CAST(SUM(ABS(ImporteNeto)) AS MONEY) as ValDcto,
                CAST(ISNULL((SELECT VentaBrutaTotal FROM GlobalBruto), 0) - SUM(ABS(ImporteNeto)) AS MONEY) as ValNeto,
                CAST((SUM(ABS(ImporteNeto)) / NULLIF((SELECT VentaBrutaTotal FROM GlobalBruto), 0)) * 100 AS DECIMAL(10,2)) as Porcentaje,
                COUNT(DISTINCT IdRouter) as CantTickets
                FROM VentasYDescuentos WHERE TipoFila = 'DESCUENTO'
                UNION ALL
                SELECT 'DETALLE', DescripcionItem, CODITM, 0, CAST(SUM(ABS(ImporteNeto)) AS MONEY), 0, 
                CAST((SUM(ABS(ImporteNeto)) / NULLIF((SELECT VentaBrutaTotal FROM GlobalBruto), 0)) * 100 AS DECIMAL(10,2)),
                COUNT(DISTINCT IdRouter) FROM VentasYDescuentos WHERE TipoFila = 'DESCUENTO' GROUP BY CODITM, DescripcionItem;
            `);
        const resumen = result.recordset.find(r => r.TipoFila === 'RESUMEN');
        const detalle = result.recordset.filter(r => r.TipoFila === 'DETALLE');
        const formatMoney = (val) => '$ ' + val.toLocaleString('es-AR', { minimumFractionDigits: 2 });
        res.json({
            resumen: { bruto: formatMoney(resumen.ValBruto || 0), descuento: formatMoney(resumen.ValDcto || 0), neto: formatMoney(resumen.ValNeto || 0), porcentaje: resumen.Porcentaje || 0, tickets: resumen.CantTickets || 0 },
            detalle: detalle.map(d => ({ codigo: d.Codigo, concepto: d.Concepto, monto: formatMoney(d.ValDcto), porcentaje: d.Porcentaje, tickets: d.CantTickets }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 13. GRILLA DIARIA CONSOLIDADA ---
app.get('/api/reporte/ventas-grilla-diaria', async (req, res) => {
    let { desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('desde', sql.Date, desde)
            .input('hasta', sql.Date, hasta)
            .query(`
                DECLARE @cols AS NVARCHAR(MAX), @sum_cols AS NVARCHAR(MAX), @query AS NVARCHAR(MAX);

                SELECT @cols = STUFF((SELECT ',' + QUOTENAME(CONVERT(VARCHAR, Fecha, 103)) 
                                FROM (
                                    SELECT DISTINCT CAST(FECHA AS DATE) as Fecha 
                                    FROM dbo.QRMVS 
                                    WHERE CAST(FECHA AS DATE) BETWEEN @desde AND @hasta
                                ) AS Dias
                                ORDER BY Fecha
                                FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, '');

                SELECT @sum_cols = STUFF((SELECT '+ISNULL(CAST(' + QUOTENAME(CONVERT(VARCHAR, Fecha, 103)) + ' AS MONEY),0)'
                                FROM (
                                    SELECT DISTINCT CAST(FECHA AS DATE) as Fecha 
                                    FROM dbo.QRMVS 
                                    WHERE CAST(FECHA AS DATE) BETWEEN @desde AND @hasta
                                ) AS Dias
                                ORDER BY Fecha
                                FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, '');

                SET @query = '
                SELECT SUCURSAL, ' + @cols + ', (' + @sum_cols + ') AS TOTAL_SUCURSAL
                FROM (
                    SELECT 
                        S.NOMBRE AS SUCURSAL,
                        CONVERT(VARCHAR, CAST(A.FECHA AS DATE), 103) AS Dia,
                        SUM(CAST(CASE 
                            WHEN A.CODCMP IN (''FA'', ''FB'') THEN B.IMPORTE 
                            WHEN A.CODCMP IN (''CA'', ''CB'') THEN -B.IMPORTE 
                            ELSE 0 END AS MONEY)) AS Neto
                    FROM dbo.QRSUCURSALES S
                    LEFT JOIN dbo.QRMVS A ON S.CODSUC = A.CODSUC 
                        AND CAST(A.FECHA AS DATE) BETWEEN ''' + CAST(@desde AS VARCHAR) + ''' AND ''' + CAST(@hasta AS VARCHAR) + '''
                        AND A.ANULADO = 0 AND A.CODCMP IN (''FA'', ''FB'', ''CA'', ''CB'')
                    LEFT JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter AND B.IDCOMPROBANTE > 0
                    WHERE S.CODEMP <> 1 AND S.CODSUC NOT IN (996, 997)
                    GROUP BY S.NOMBRE, CAST(A.FECHA AS DATE)
                ) x
                PIVOT (
                    SUM(Neto)
                    FOR Dia IN (' + @cols + ')
                ) p 
                ORDER BY TOTAL_SUCURSAL DESC';

                EXEC sp_executesql @query;
            `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Mimo BI Server Activo en Puerto ${PORT}`));
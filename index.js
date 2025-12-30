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

// Middleware de autenticación
function auth(req, res, next) { next(); }

// --- 1. SUCURSALES ---
app.get('/api/sucursales', auth, async (req, res) => {
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().query(`
            SELECT CODSUC, NOMBRE 
            FROM dbo.QRSUCURSALES 
            WHERE CODEMP <> 1 
              AND CODSUC NOT IN (996, 997) 
            ORDER BY NOMBRE
        `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. AUDITORÍA DE VENTAS (Corrección de Fecha) ---
app.get('/api/facturas', auth, async (req, res) => {
    const { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .input('desde', sql.VarChar, desde)
            .input('hasta', sql.VarChar, hasta)
            .query(`
                SELECT A.CODCMP, A.PREFIJO, A.NUMERO, B.CODITM, B.CANTIDAD1 AS cant, CAST(B.PRECIO AS MONEY) AS pre,
                CASE WHEN C.CODPAG = '001' THEN 'EFECTIVO' 
                     WHEN C.CODPAG = '100' THEN 'TARJETA' 
                     WHEN C.CODPAG IN ('125','225') THEN 'MERCADOPAGO' 
                     ELSE 'OTRO' END AS pago_desc,
                CAST(A.TOTAL AS MONEY) AS total_comprobante
                FROM dbo.QRMVS A 
                INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter 
                INNER JOIN dbo.QRLineasPago C ON A.IdRouter = C.IdRouter
                WHERE A.CODSUC = @suc 
                  AND CAST(A.FECHA AS DATE) >= CAST(@desde AS DATE)
                  AND CAST(A.FECHA AS DATE) <= CAST(@hasta AS DATE)
                  AND A.CODCMP IN ('FA','FB','CA','CB')
                  AND A.CODSUC NOT IN (996, 997)
            `);
        
        const facturas = {};
        let totEfectivo = 0, totTarjeta = 0, totMP = 0, totGeneral = 0;
        const procesados = new Set();

        result.recordset.forEach(r => {
            const key = `${r.CODCMP}-${r.PREFIJO}-${r.NUMERO}`;
            if (!facturas[key]) {
                facturas[key] = { prefijo: r.PREFIJO, numero: r.NUMERO, tipo: r.CODCMP, pago: r.pago_desc, items: [] };
                if (!procesados.has(key)) {
                    if (r.pago_desc === 'EFECTIVO') totEfectivo += r.total_comprobante;
                    else if (r.pago_desc === 'TARJETA') totTarjeta += r.total_comprobante;
                    else if (r.pago_desc === 'MERCADOPAGO') totMP += r.total_comprobante;
                    totGeneral += r.total_comprobante;
                    procesados.add(key);
                }
            }
            facturas[key].items.push({ cod: r.CODITM, cant: r.cant, pre: r.pre });
        });
        res.json({ datos: Object.values(facturas), totales: { efectivo: totEfectivo, tarjeta: totTarjeta, mp: totMP, general: totGeneral } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. TICKET PROMEDIO (Corrección de Fecha) ---
app.get('/api/reporte/ticket-promedio', auth, async (req, res) => {
    const { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .input('desde', sql.VarChar, desde)
            .input('hasta', sql.VarChar, hasta)
            .query(`
                SELECT 
                    CAST(A.FECHA AS DATE) AS FECHA,
                    COUNT(DISTINCT CAST(A.CODCMP AS VARCHAR) + CAST(A.PREFIJO AS VARCHAR) + CAST(A.NUMERO AS VARCHAR)) AS CANTIDAD_TICKETS, 
                    SUM(A.TOTAL) AS VENTA_NETA_TOTAL,
                    (SUM(A.TOTAL) / NULLIF(COUNT(DISTINCT CAST(A.CODCMP AS VARCHAR) + CAST(A.PREFIJO AS VARCHAR) + CAST(A.NUMERO AS VARCHAR)), 0)) AS TICKET_PROMEDIO 
                FROM dbo.QRMVS A
                WHERE A.CODSUC = @suc 
                  AND CAST(A.FECHA AS DATE) >= CAST(@desde AS DATE)
                  AND CAST(A.FECHA AS DATE) <= CAST(@hasta AS DATE)
                  AND A.CODCMP IN ('FA','FB','CA','CB')
                  AND A.CODSUC NOT IN (996, 997)
                GROUP BY CAST(A.FECHA AS DATE) 
                ORDER BY FECHA DESC
            `);
        const totalVenta = result.recordset.reduce((acc, r) => acc + r.VENTA_NETA_TOTAL, 0);
        const totalTickets = result.recordset.reduce((acc, r) => acc + r.CANTIDAD_TICKETS, 0);
        res.json({ datos: result.recordset, resumen: { totalVenta, totalTickets, promedio: totalTickets > 0 ? totalVenta / totalTickets : 0 } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. MOVIMIENTOS DE MERCADERÍA (Corrección de Fecha) ---
app.get('/api/reporte/movimientos-mercaderia', auth, async (req, res) => {
    const { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .input('desde', sql.VarChar, desde)
            .input('hasta', sql.VarChar, hasta)
            .query(`
                SELECT A.CODCMP, A.PREFIJO, A.NUMERO, B.CODITM, B.CANTIDAD1, C.CodConcepto 
                FROM dbo.QRMVS A 
                INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter 
                INNER JOIN dbo.QRMVSMAT C ON A.IdRouter = C.IdRouter
                WHERE A.CODSUC = @suc 
                  AND CAST(A.FECHA AS DATE) >= CAST(@desde AS DATE)
                  AND CAST(A.FECHA AS DATE) <= CAST(@hasta AS DATE)
                  AND A.IDCOMPROBANTE > 0
                  AND A.CODSUC NOT IN (996, 997)
            `);
        const movimientos = {};
        result.recordset.forEach(row => {
            const key = `${row.CODCMP}-${row.PREFIJO}-${row.NUMERO}`;
            if (!movimientos[key]) {
                movimientos[key] = { tipo: row.CODCMP, prefijo: row.PREFIJO, numero: row.NUMERO, concepto: row.CodConcepto, items: [] };
            }
            movimientos[key].items.push({ cod: row.CODITM, cant: row.CANTIDAD1 });
        });
        res.json(Object.values(movimientos));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. STOCK EN TIEMPO REAL ---
app.get('/api/reporte/stock', auth, async (req, res) => {
    const { sucursal } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .query(`
                SELECT CODITM, STKACTUAL AS CANTIDAD 
                FROM dbo.QRITEMSACUM 
                WHERE CODSUC = @suc AND STKACTUAL > 0 AND CODSUC NOT IN (996, 997)
            `);
        res.json({ detalles: result.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. STOCK VALORIZADO ---
app.get('/api/reporte/stock-valorizado', auth, async (req, res) => {
    const { sucursal } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .query(`
                SELECT A.CODITM, A.STKACTUAL, CAST(B.PRECIO AS MONEY) AS PRECIO_COMPRA_UNITARIO, 
                       CAST(A.STKACTUAL * B.PRECIO AS MONEY) AS TOTAL_COMPRA
                FROM QRITEMSACUM A 
                INNER JOIN QRLISTASPRECIOS B ON A.CODITM = B.CODITM
                WHERE A.CODSUC = @suc AND B.CODLIS = 'MAY' AND A.STKACTUAL > 0 AND A.CODSUC NOT IN (996, 997)
            `);
        const totalCartera = result.recordset.reduce((acc, row) => acc + row.TOTAL_COMPRA, 0);
        res.json({ detalles: result.recordset, totalCartera });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => console.log('🚀 Mimo BI Operativo con Corrección de Fechas'));
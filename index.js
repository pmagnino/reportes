const express = require('express');
const sql = require('mssql');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 30000
    }
};

// --- SELECTOR DE SUCURSALES ---
app.get('/api/sucursales', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query(`
            SELECT CODSUC, NOMBRE FROM QRSUCURSALES 
            WHERE CODEMP <> 1 AND CODSUC NOT IN (996, 997) ORDER BY NOMBRE ASC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- REPORTE 1: VENTAS ---
app.get('/api/facturas', async (req, res) => {
    const { sucursal, desde, hasta } = req.query;
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query(`
            SELECT A.PREFIJO, A.NUMERO, B.CODITM, B.CANTIDAD1 as cant, CAST(B.PRECIO AS MONEY) as pre,
            CASE 
                WHEN C.CODPAG = '001' THEN 'EFECTIVO' 
                WHEN C.CODPAG = '100' THEN 'TARJETA' 
                WHEN C.CODPAG IN ('125', '225') THEN 'MERCADOPAGO' 
                ELSE 'OTRO' 
            END AS pago_desc
            FROM QRMVS A 
            INNER JOIN QRLINEASITEMS B ON A.IdRouter = B.IdRouter 
            INNER JOIN QRLineasPago C ON A.IdRouter = C.IdRouter
            WHERE A.CODSUC = '${sucursal}' AND A.FECHA BETWEEN '${desde}' AND '${hasta}' 
              AND A.CODCMP IN ('FA','FB','CA','CB') AND B.CODITM <> 'AJUCEN'`);
        
        const facturasMap = {};
        const totales = { efectivo: 0, tarjeta: 0, mp: 0, general: 0 };
        result.recordset.forEach(row => {
            const key = `${row.PREFIJO}-${row.NUMERO}`;
            if (!facturasMap[key]) facturasMap[key] = { prefijo: row.PREFIJO, numero: row.NUMERO, pago: row.pago_desc, items: [] };
            facturasMap[key].items.push({ cod: row.CODITM, cant: row.cant, pre: row.pre });
            const subtotal = Number(row.cant) * Number(row.pre);
            totales.general += subtotal;
            if (row.pago_desc === 'EFECTIVO') totales.efectivo += subtotal;
            else if (row.pago_desc === 'TARJETA') totales.tarjeta += subtotal;
            else if (row.pago_desc === 'MERCADOPAGO') totales.mp += subtotal;
        });
        res.json({ datos: Object.values(facturasMap), totales });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- REPORTE 2: RANKING VENDEDORES ---
app.get('/api/reporte/vendedores', async (req, res) => {
    try {
        const { sucursal, desde, hasta } = req.query;
        let pool = await sql.connect(config);
        const result = await pool.request().input('FHD', sql.Date, desde).input('FHH', sql.Date, hasta).input('SUC', sql.Int, sucursal).query(`
            SELECT b.CODVENDEDOR, SUM(a.TOTAL) AS TOTAL_NUMERICO, COUNT(DISTINCT a.IdRouter) AS TOTAL_OPERACIONES
            FROM qrmvs a INNER JOIN qrcomprobantes b ON a.IdRouter = b.IdRouter
            WHERE a.codsuc = @SUC AND a.fecha BETWEEN @FHD AND @FHH AND a.codcmp IN ('fa', 'fb', 'ca', 'cb')
            GROUP BY b.CODVENDEDOR ORDER BY TOTAL_NUMERICO DESC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- REPORTE 3: STOCK (TU CONSULTA SQL OPTIMIZADA) ---
app.get('/api/reporte/stock', async (req, res) => {
    const { sucursal } = req.query;
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query(`
            SELECT 
                A.CODITM, 
                B.DESCRIPCION, 
                CAST(A.STKACTUAL AS INT) as STOCK_LIMPIO 
            FROM QRItemsAcum A
            INNER JOIN QRITEMS B ON A.CODITM = B.CODITM
            WHERE A.CODSUC = '${sucursal}'
              AND A.STKACTUAL > 0
            ORDER BY A.STKACTUAL DESC`);
        
        const totalUnidades = result.recordset.reduce((acc, row) => acc + row.STOCK_LIMPIO, 0);
        res.json({ detalles: result.recordset, resumen: { totalUnidades } });
    } catch (err) { 
        res.status(500).json({ error: "Error en base de datos", detalle: err.message }); 
    }
});

app.listen(3000, () => console.log('Servidor Mimo & Co Online puerto 3000'));
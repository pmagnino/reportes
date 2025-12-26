require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { poolPromise, sql } = require('./db');

const app = express();

// --- CONFIGURACIONES ---
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- RUTA: SUCURSALES (Filtro CODEMP <> 1) ---
app.get('/api/sucursales', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT CODSUC, NOMBRE 
            FROM QRSUCURSALES 
            WHERE CODEMP <> 1 
            ORDER BY NOMBRE ASC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: "Error al obtener sucursales" });
    }
});

// --- REPORTE 1: COMPROBANTES DETALLADOS ---
app.get('/api/facturas', async (req, res) => {
    try {
        const { sucursal, desde, hasta } = req.query;
        const pool = await poolPromise;
        const request = pool.request();
        request.input('desde', sql.Date, desde);
        request.input('hasta', sql.Date, hasta);

        let querySQL = `
            SELECT A.PREFIJO, A.NUMERO, A.FECHA, A.CODSUC, A.CODCMP, G.NOMBRE AS NOM_SUC,
                   B.CODITM, B.CANTIDAD1, CAST(B.PRECIO AS MONEY) AS PRECIO,
                   CASE 
                     WHEN C.CODPAG = '001' THEN 'EFECTIVO' 
                     WHEN C.CODPAG = '100' THEN 'TARJETA' 
                     WHEN C.CODPAG = '125' THEN 'MERCADOPAGO' 
                     WHEN C.CODPAG = '225' THEN 'MERCADOPAGO (DEV)' 
                     ELSE 'OTRO' 
                   END AS PAGO_DESC
            FROM QRMVS A
            INNER JOIN QRLINEASITEMS B ON A.IdRouter = B.IdRouter
            INNER JOIN QRLineasPago C ON A.IdRouter = C.IdRouter
            INNER JOIN QRSUCURSALES G ON A.CODSUC = G.CODSUC
            WHERE G.CODEMP <> 1
              AND A.CODCMP IN ('FB','FA','CB','CA')
              AND B.CODITM <> 'AJUCEN'
              AND A.FECHA >= @desde AND A.FECHA < DATEADD(day, 1, @hasta)
        `;

        if (sucursal && sucursal !== '0') {
            request.input('sucursal', sql.Int, sucursal);
            querySQL += ' AND A.CODSUC = @sucursal';
        }

        const result = await request.query(querySQL + ' ORDER BY A.FECHA, A.NUMERO');
        
        const facturas = {};
        const totales = { efectivo: 0, tarjeta: 0, mp: 0, general: 0 };

        result.recordset.forEach(r => {
            const key = `${r.PREFIJO}-${r.NUMERO}`;
            const subtotalItem = (r.CANTIDAD1 || 0) * (r.PRECIO || 0);
            if (!facturas[key]) {
                facturas[key] = { prefijo: r.PREFIJO, numero: r.NUMERO, fecha: r.FECHA, nom_suc: r.NOM_SUC, pago: r.PAGO_DESC, tipo: r.CODCMP, items: [] };
            }
            facturas[key].items.push({ cod: r.CODITM, cant: r.CANTIDAD1, pre: r.PRECIO });

            if (r.PAGO_DESC === 'EFECTIVO') totales.efectivo += subtotalItem;
            else if (r.PAGO_DESC === 'TARJETA') totales.tarjeta += subtotalItem;
            else if (r.PAGO_DESC.includes('MERCADOPAGO')) totales.mp += subtotalItem;
            totales.general += subtotalItem;
        });

        res.json({ datos: Object.values(facturas), totales });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- REPORTE 2: RANKING DE VENDEDORES ---
app.get('/api/reporte/vendedores', async (req, res) => {
    try {
        const { sucursal, desde, hasta } = req.query;
        const pool = await poolPromise;
        const request = pool.request();
        request.input('FHD', sql.Date, desde);
        request.input('FHH', sql.Date, hasta);
        request.input('SUC', sql.Int, sucursal);

        const result = await request.query(`
            SELECT b.CODVENDEDOR,
                SUM(CASE WHEN a.codcmp = 'fa' THEN 1 ELSE 0 END) AS CANTIDAD_FACTURAS_A,
                SUM(CASE WHEN a.codcmp = 'fb' THEN 1 ELSE 0 END) AS CANTIDAD_FACTURAS_B,
                SUM(CASE WHEN a.codcmp = 'ca' THEN 1 ELSE 0 END) AS CANTIDAD_NOTAS_CREDITO_A,
                SUM(CASE WHEN a.codcmp = 'cb' THEN 1 ELSE 0 END) AS CANTIDAD_NOTAS_CREDITO_B,
                SUM(a.TOTAL) AS TOTAL_NUMERICO,
                COUNT(DISTINCT a.IdRouter) AS TOTAL_OPERACIONES
            FROM qrmvs a
            INNER JOIN qrcomprobantes b ON a.IdRouter = b.IdRouter
            INNER JOIN qrsucursales s ON a.codsuc = s.codsuc
            WHERE s.codemp <> 1 AND a.codsuc = @SUC AND a.fecha BETWEEN @FHD AND @FHH
              AND a.codcmp IN ('fa', 'fb', 'ca', 'cb')
            GROUP BY b.CODVENDEDOR
            ORDER BY SUM(a.TOTAL) DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- REPORTE 3: LISTADO DE STOCK (CON JOIN A QRITEMS PARA DESCRIPCION) ---
app.get('/api/reporte/stock', async (req, res) => {
    try {
        const { sucursal } = req.query;
        const pool = await poolPromise;
        const request = pool.request();
        request.input('SUC', sql.Int, sucursal);

        const result = await request.query(`
            SELECT 
                A.CODITM, 
                C.DESCRIPCION,
                CAST(A.STKACTUAL AS INT) AS STOCK_LIMPIO, 
                B.NOMBRE AS NOM_SUC
            FROM QRITEMSACUM A
            INNER JOIN QRSUCURSALES B ON A.CODSUC = B.CODSUC
            INNER JOIN QRITEMS C ON C.CODITM = A.CODITM
            WHERE B.CODEMP <> 1 
              AND A.CODSUC = @SUC 
              AND A.STKACTUAL > 0
            ORDER BY C.DESCRIPCION ASC
        `);

        const totalUnidades = result.recordset.reduce((sum, item) => sum + item.STOCK_LIMPIO, 0);
        res.json({
            detalles: result.recordset,
            resumen: { 
                totalUnidades, 
                sucursalNombre: result.recordset.length > 0 ? result.recordset[0].NOM_SUC : 'Sin Datos' 
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- INICIO DEL SERVIDOR (PUERTO 3000) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
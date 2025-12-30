const express = require('express');
const sql = require('mssql');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =====================================================
   CONFIGURACIÓN DE CONEXIÓN (MS SQL SERVER)
===================================================== */
const dbConfig = {
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

const poolMainPromise = new sql.ConnectionPool(dbConfig).connect();
const poolAuthPromise = new sql.ConnectionPool({
    ...dbConfig,
    database: process.env.AUTH_DB_DATABASE
}).connect();

/* =====================================================
   MIDDLEWARE DE SEGURIDAD
===================================================== */
function auth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token requerido' });
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido' });
    }
}

/* =====================================================
   AUTENTICACIÓN
===================================================== */
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const pool = await poolAuthPromise;
        const result = await pool.request()
            .input('u', sql.VarChar, usuario)
            .query('SELECT id, usuario, password_hash, rol, sucursal FROM dbo.usuarios_reportes WHERE usuario = @u');

        if (!result.recordset.length) return res.status(401).json({ error: 'Usuario inexistente' });
        const user = result.recordset[0];
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

        const token = jwt.sign(
            { id: user.id, usuario: user.usuario, rol: user.rol, sucursal: user.sucursal },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ token });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* =====================================================
   RUTAS DE REPORTES
===================================================== */

// 1. LISTADO DE SUCURSALES (Para selectores de filtros)
app.get('/api/sucursales', auth, async (req, res) => {
    try {
        const pool = await poolMainPromise;
        const result = await pool.request().query('SELECT CODSUC, NOMBRE FROM dbo.QRSUCURSALES WHERE CODEMP <> 1 AND CODSUC NOT IN (996, 997) ORDER BY NOMBRE');
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. AUDITORÍA DE VENTAS (Con CODCMP para detección de Notas de Crédito)
app.get('/api/facturas', auth, async (req, res) => {
    const { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .input('desde', sql.Date, desde)
            .input('hasta', sql.Date, hasta)
            .query(`SELECT A.PREFIJO, A.NUMERO, A.CODCMP, B.CODITM, B.CANTIDAD1 AS cant, CAST(B.PRECIO AS MONEY) AS pre,
                    CASE WHEN C.CODPAG = '001' THEN 'EFECTIVO' WHEN C.CODPAG = '100' THEN 'TARJETA' WHEN C.CODPAG IN ('125','225') THEN 'MERCADOPAGO' ELSE 'OTRO' END AS pago_desc
                    FROM dbo.QRMVS A INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter INNER JOIN dbo.QRLineasPago C ON A.IdRouter = C.IdRouter
                    WHERE A.CODSUC = @suc AND A.FECHA BETWEEN @desde AND @hasta AND A.CODCMP IN ('FA','FB','CA','CB') AND B.CODITM <> 'AJUCEN'`);
        
        const facturas = {};
        const totales = { efectivo: 0, tarjeta: 0, mp: 0, general: 0 };

        result.recordset.forEach(r => {
            const key = `${r.PREFIJO}-${r.NUMERO}-${r.CODCMP}`;
            if (!facturas[key]) {
                facturas[key] = { prefijo: r.PREFIJO, numero: r.NUMERO, tipo: r.CODCMP, pago: r.pago_desc, items: [] };
            }
            facturas[key].items.push({ cod: r.CODITM, cant: r.cant, pre: r.pre });
            const sub = r.cant * r.pre;
            totales.general += sub;
            if (r.pago_desc === 'EFECTIVO') totales.efectivo += sub;
            else if (r.pago_desc === 'TARJETA') totales.tarjeta += sub;
            else if (r.pago_desc === 'MERCADOPAGO') totales.mp += sub;
        });
        res.json({ datos: Object.values(facturas), totales });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. CONTROL DE STOCK FÍSICO
app.get('/api/reporte/stock', auth, async (req, res) => {
    const { sucursal } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .query(`SELECT A.CODITM, B.DESCRIPCION, CAST(A.STKACTUAL AS INT) AS CANTIDAD 
                    FROM dbo.QRItemsAcum A INNER JOIN dbo.QRITEMS B ON A.CODITM = B.CODITM 
                    WHERE A.CODSUC = @suc AND A.STKACTUAL > 0 ORDER BY A.STKACTUAL DESC`);
        res.json({ detalles: result.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. STOCK VALORIZADO (Lista MAY) - Query exacta solicitada
app.get('/api/reporte/stock-valorizado', auth, async (req, res) => {
    const { sucursal } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .query(`
                SELECT 
                    A.CODITM,
                    A.STKACTUAL,
                    CAST(B.PRECIO AS MONEY) AS PRECIO_COMPRA_UNITARIO,
                    CAST(A.STKACTUAL * B.PRECIO AS MONEY) AS TOTAL_COMPRA
                FROM QRITEMSACUM A
                INNER JOIN QRLISTASPRECIOS B ON A.CODITM = B.CODITM
                WHERE A.CODSUC = @suc
                  AND B.CODLIS = 'MAY'
                  AND A.STKACTUAL > 0
                ORDER BY TOTAL_COMPRA DESC
            `);
        
        const totalCartera = result.recordset.reduce((acc, row) => acc + (row.TOTAL_COMPRA || 0), 0);
        res.json({ detalles: result.recordset, totalCartera });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. MOVIMIENTOS DE MERCADERÍA - Query exacta solicitada
app.get('/api/reporte/movimientos-mercaderia', auth, async (req, res) => {
    const { sucursal, desde, hasta } = req.query;
    try {
        const pool = await poolMainPromise;
        const result = await pool.request()
            .input('suc', sql.Int, sucursal)
            .input('desde', sql.Date, desde)
            .input('hasta', sql.Date, hasta)
            .query(`
                SELECT A.CODCMP, A.PREFIJO, A.NUMERO, B.CODITM, B.CANTIDAD1, C.CodConcepto
                FROM QRMVS A
                INNER JOIN QRLINEASITEMS B ON A.IdRouter = B.IdRouter
                INNER JOIN QRMVSMAT C ON A.IdRouter = C.IdRouter
                WHERE A.CODSUC = @suc
                  AND A.FECHA BETWEEN @desde AND @hasta
                  AND A.IDCOMPROBANTE > 0
                ORDER BY A.FECHA DESC, A.NUMERO DESC
            `);

        // Agrupación para Maestro-Detalle
        const movimientos = {};
        result.recordset.forEach(row => {
            const key = `${row.CODCMP}-${row.PREFIJO}-${row.NUMERO}`;
            if (!movimientos[key]) {
                movimientos[key] = {
                    tipo: row.CODCMP,
                    prefijo: row.PREFIJO,
                    numero: row.NUMERO,
                    concepto: row.CodConcepto,
                    items: []
                };
            }
            movimientos[key].items.push({ cod: row.CODITM, cant: row.CANTIDAD1 });
        });

        res.json(Object.values(movimientos));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Mimo Online en puerto ${PORT}`));
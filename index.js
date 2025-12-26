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
   BASES DE DATOS
===================================================== */

const poolMain = new sql.ConnectionPool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE, // BASROUTER
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
});

const poolAuth = new sql.ConnectionPool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.AUTH_DB_DATABASE, // ControlTiendas
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
});

const poolMainPromise = poolMain.connect();
const poolAuthPromise = poolAuth.connect();

/* =====================================================
   AUTH MIDDLEWARE
===================================================== */

function auth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token requerido' });

    const token = authHeader.split(' ')[1];

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(403).json({ error: 'Token inválido' });
    }
}

/* =====================================================
   LOGIN
===================================================== */

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;

    try {
        const pool = await poolAuthPromise;

        const result = await pool.request()
            .input('usuario', sql.VarChar, usuario)
            .query(`
                SELECT id, usuario, password_hash, rol, sucursal, activo
                FROM dbo.usuarios_reportes
                WHERE usuario = @usuario
            `);

        if (!result.recordset.length)
            return res.status(401).json({ error: 'Usuario inválido' });

        const user = result.recordset[0];

        if (!user.activo)
            return res.status(403).json({ error: 'Usuario inactivo' });

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

        const token = jwt.sign(
            {
                id: user.id,
                usuario: user.usuario,
                rol: user.rol,
                sucursal: user.sucursal
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES }
        );

        res.json({ token });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =====================================================
   ENDPOINTS PROTEGIDOS
===================================================== */

// ✅ SUCURSALES (BASROUTER)
app.get('/api/sucursales', auth, async (req, res) => {
    try {
        const pool = await poolMainPromise;

        const result = await pool.request().query(`
            SELECT CODSUC, NOMBRE
            FROM dbo.QRSUCURSALES
            WHERE CODEMP <> 1 AND CODSUC NOT IN (996, 997)
            ORDER BY NOMBRE
        `);

        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ✅ FACTURAS
app.get('/api/facturas', auth, async (req, res) => {
    const { sucursal, desde, hasta } = req.query;

    try {
        const pool = await poolMainPromise;

        const result = await pool.request().query(`
            SELECT 
                A.PREFIJO,
                A.NUMERO,
                B.CODITM,
                B.CANTIDAD1 AS cant,
                CAST(B.PRECIO AS MONEY) AS pre,
                CASE 
                    WHEN C.CODPAG = '001' THEN 'EFECTIVO'
                    WHEN C.CODPAG = '100' THEN 'TARJETA'
                    WHEN C.CODPAG IN ('125','225') THEN 'MERCADOPAGO'
                    ELSE 'OTRO'
                END AS pago_desc
            FROM dbo.QRMVS A
            INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
            INNER JOIN dbo.QRLineasPago C ON A.IdRouter = C.IdRouter
            WHERE A.CODSUC = '${sucursal}'
              AND A.FECHA BETWEEN '${desde}' AND '${hasta}'
              AND A.CODCMP IN ('FA','FB','CA','CB')
        `);

        const facturas = {};
        const totales = { efectivo: 0, tarjeta: 0, mp: 0, general: 0 };

        result.recordset.forEach(r => {
            const key = `${r.PREFIJO}-${r.NUMERO}`;
            if (!facturas[key]) facturas[key] = { ...r, items: [] };

            const subtotal = r.cant * r.pre;
            facturas[key].items.push({ cod: r.CODITM, cant: r.cant, pre: r.pre });

            totales.general += subtotal;
            if (r.pago_desc === 'EFECTIVO') totales.efectivo += subtotal;
            else if (r.pago_desc === 'TARJETA') totales.tarjeta += subtotal;
            else if (r.pago_desc === 'MERCADOPAGO') totales.mp += subtotal;
        });

        res.json({ datos: Object.values(facturas), totales });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ✅ STOCK
app.get('/api/reporte/stock', auth, async (req, res) => {
    const { sucursal } = req.query;

    try {
        const pool = await poolMainPromise;

        const result = await pool.request().query(`
            SELECT 
                A.CODITM,
                B.DESCRIPCION,
                CAST(A.STKACTUAL AS INT) AS STOCK_LIMPIO
            FROM dbo.QRItemsAcum A
            INNER JOIN dbo.QRITEMS B ON A.CODITM = B.CODITM
            WHERE A.CODSUC = '${sucursal}'
              AND A.STKACTUAL > 0
            ORDER BY A.STKACTUAL DESC
        `);

        res.json({
            detalles: result.recordset,
            resumen: {
                totalUnidades: result.recordset.reduce((a, b) => a + b.STOCK_LIMPIO, 0)
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =====================================================
   SERVER
===================================================== */

app.listen(3000, () => {
    console.log('🚀 Servidor activo en http://localhost:3000');
});

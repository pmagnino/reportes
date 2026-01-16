const express = require('express');
const router = express.Router();

const { sql, poolMainPromise } = require('../db');
const { authRequired } = require('../middleware/auth');

const cleanParam = (p) => (p ? p.toString().replace(':1', '').trim() : '');

function getSucursalFromReq(req) {
  // Admin puede elegir por query, usuario NO
  if (req.user?.rol === 'admin') return cleanParam(req.query.sucursal);
  return String(req.user?.sucursal || '');
}

// =============================
// HEALTHCHECK (PUBLICO)
// =============================
router.get('/health', async (req, res) => {
  try {
    const pool = await poolMainPromise;
    await pool.request().query('SELECT 1');
    return res.status(200).send('OK');
  } catch (err) {
    return res.status(500).send('DB ERROR');
  }
});
// =============================
// UTIL (PROTEGIDO o PUBLICO)
// =============================

// Si queres que sea protegido, dejalo con authRequired.
// Si queres que sea publico, sacale authRequired.
router.get('/api/util/fecha-hoy', authRequired, (req, res) => {
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const dd = String(hoy.getDate()).padStart(2, '0');
  return res.json({ fecha: `${yyyy}-${mm}-${dd}` });
});

// =============================
// SUCURSALES (PROTEGIDO)
// Admin: todas
// Usuario: solo la suya
// =============================
router.get('/api/sucursales', authRequired, async (req, res) => {
  try {
    const pool = await poolMainPromise;

    if (req.user.rol === 'admin') {
      const result = await pool.request().query(`
        SELECT CODSUC, NOMBRE
        FROM QRSUCURSALES
        WHERE CODEMP <> 1 AND CODSUC NOT IN (996, 997)
        ORDER BY NOMBRE
      `);
      return res.json(result.recordset);
    }

    const codSuc = parseInt(req.user.sucursal, 10);
    if (!codSuc || Number.isNaN(codSuc)) {
      return res.status(400).json({ error: 'Usuario sin sucursal asignada' });
    }

    const result = await pool.request()
      .input('codSuc', sql.Int, codSuc)
      .query(`SELECT CODSUC, NOMBRE FROM QRSUCURSALES WHERE CODSUC = @codSuc`);

    return res.json(result.recordset);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================
// REPORTES (PROTEGIDOS)
// =============================

// --- 1. COMPARATIVO (JSON EXACTO PARA reporte_comparativo.html) ---
// Front llama: /api/reporte/comparativo-ventas?fechaRef=YYYY-MM-DD&sucursal=201 (solo admin)
router.get('/api/reporte/comparativo-ventas', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const fechaRef = cleanParam(req.query.fechaRef);

  try {
    if (!fechaRef) {
      return res.status(400).json({ error: 'fechaRef es obligatorio (YYYY-MM-DD)' });
    }
    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    // Genera semana (Lun-Dom) a partir de fechaRef (DATEFIRST 1 => lunes=1)
    // Calcula:
    // - Act: ventas netas y unidades del dia
    // - Sem: mismo dia semana anterior (dia-7)
    // - Mes: mismo dia 4 semanas atras (dia-28)  (sirve como "mes" comparable fijo)
    const q = `
      SET DATEFIRST 1;

      DECLARE @ref DATE = @fechaRef;
      DECLARE @lunes DATE = DATEADD(day, 1 - DATEPART(weekday, @ref), @ref);

      ;WITH D AS (
        SELECT 0 AS n, @lunes AS Fecha
        UNION ALL SELECT 1, DATEADD(day, 1, @lunes)
        UNION ALL SELECT 2, DATEADD(day, 2, @lunes)
        UNION ALL SELECT 3, DATEADD(day, 3, @lunes)
        UNION ALL SELECT 4, DATEADD(day, 4, @lunes)
        UNION ALL SELECT 5, DATEADD(day, 5, @lunes)
        UNION ALL SELECT 6, DATEADD(day, 6, @lunes)
      ),
      Mov AS (
        SELECT
          CAST(A.FECHA AS DATE) AS Fecha,
          A.IdRouter,
          CASE WHEN A.CODCMP IN ('CA','CB') THEN -CAST(A.TOTAL AS FLOAT) ELSE CAST(A.TOTAL AS FLOAT) END AS Neto
        FROM dbo.QRMVS A
        WHERE A.ANULADO = 0
          AND A.IDCOMPROBANTE > 0
          AND A.CODCMP IN ('FA','FB','CA','CB')
          AND CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR)
          AND CAST(A.FECHA AS DATE) BETWEEN DATEADD(day, -35, @lunes) AND DATEADD(day, 6, @lunes)
      ),
      Uni AS (
        SELECT
          M.Fecha,
          SUM(CASE WHEN M.Neto < 0 THEN -ISNULL(L.CANTIDAD1,0) ELSE ISNULL(L.CANTIDAD1,0) END) AS Unidades
        FROM Mov M
        LEFT JOIN dbo.QRLINEASITEMS L ON L.IdRouter = M.IdRouter
        GROUP BY M.Fecha
      ),
      Agg AS (
        SELECT
          M.Fecha,
          SUM(M.Neto) AS Monto
        FROM Mov M
        GROUP BY M.Fecha
      )
      SELECT
        D.Fecha AS Fecha,
        ISNULL(A0.Monto, 0) AS MontoAct,
        ISNULL(U0.Unidades, 0) AS UniAct,

        ISNULL(A7.Monto, 0) AS MontoSem,
        ISNULL(U7.Unidades, 0) AS UniSem,

        ISNULL(A28.Monto, 0) AS MontoMes,
        ISNULL(U28.Unidades, 0) AS UniMes
      FROM D
      LEFT JOIN Agg A0 ON A0.Fecha = D.Fecha
      LEFT JOIN Uni U0 ON U0.Fecha = D.Fecha

      LEFT JOIN Agg A7 ON A7.Fecha = DATEADD(day, -7, D.Fecha)
      LEFT JOIN Uni U7 ON U7.Fecha = DATEADD(day, -7, D.Fecha)

      LEFT JOIN Agg A28 ON A28.Fecha = DATEADD(day, -28, D.Fecha)
      LEFT JOIN Uni U28 ON U28.Fecha = DATEADD(day, -28, D.Fecha)

      ORDER BY D.Fecha ASC;
    `;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('fechaRef', sql.Date, fechaRef)
      .query(q);

    const moneyFmt = new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0
    });

    const diaSemanaEs = (jsDate) => {
      // jsDate es Date local; usamos getDay() (0=Dom..6=Sab)
      const d = jsDate.getDay();
      return ([
        'DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'
      ])[d] || '';
    };

    const pad2 = (n) => String(n).padStart(2, '0');
    const ddmmaa = (jsDate) => `${pad2(jsDate.getDate())}/${pad2(jsDate.getMonth() + 1)}/${jsDate.getFullYear()}`;

    const payload = result.recordset.map(r => {
      const fecha = new Date(r.Fecha); // viene como Date
      const fechaIso = fecha.toISOString(); // sirve para el split('T')[0] del front
      const fechaLabel = ddmmaa(fecha);

      const fSem = new Date(fecha); fSem.setDate(fSem.getDate() - 7);
      const fMes = new Date(fecha); fMes.setDate(fMes.getDate() - 28);

      const montoAct = Number(r.MontoAct || 0);
      const uniAct = Number(r.UniAct || 0);

      return {
        FechaIso: fechaIso,
        FechaLabel: fechaLabel,
        DiaSemana: diaSemanaEs(fecha),

        MontoAct: montoAct,
        MontoActStr: moneyFmt.format(montoAct),

        MontoSem: Number(r.MontoSem || 0),
        LabelSem: ddmmaa(fSem),

        MontoMes: Number(r.MontoMes || 0),
        LabelMes: ddmmaa(fMes),

        UniAct: uniAct,
        UniSem: Number(r.UniSem || 0),
        UniMes: Number(r.UniMes || 0),
      };
    });

    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// --- 2. AUDITORIA DE VENTAS ---
router.get('/api/facturas', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);
  const articulo = cleanParam(req.query.articulo);
  const medioPago = cleanParam(req.query.medioPago);

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
          AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB')
          AND A.IDCOMPROBANTE > 0 AND A.ANULADO = 0
      )
      SELECT * FROM FacturasBase WHERE 1=1
    `;

    if (articulo !== '') q += ` AND IdRouter IN (SELECT IdRouter FROM dbo.QRLINEASITEMS WHERE CODITM LIKE '%' + @art + '%')`;
    if (medioPago !== '' && medioPago !== 'TODOS') q += ` AND pago_desc = @mpago`;

    const request = pool.request()
      .input('suc', sql.Int, sucursal)
      .input('desde', sql.VarChar, desde)
      .input('hasta', sql.VarChar, hasta)
      .input('art', sql.VarChar, articulo)
      .input('mpago', sql.VarChar, medioPago);

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

      return {
        prefijo: r.PREFIJO,
        numero: r.NUMERO,
        tipo: r.CODCMP,
        fecha: r.FECHA_STR,
        pago: r.pago_desc,
        totalTicket: r.total_comprobante,
        IdRouter: r.IdRouter,
        items: []
      };
    });

    if (facturas.length > 0) {
      const ids = result.recordset.map(r => `'${r.IdRouter}'`).join(',');
      const itemsRes = await pool.request().query(
        `SELECT IdRouter, CODITM, CANTIDAD1, PRECIO, OBSERVACIONES
         FROM QRLINEASITEMS
         WHERE IdRouter IN (${ids})`
      );

      facturas.forEach(f => {
        f.items = itemsRes.recordset
          .filter(i => i.IdRouter === f.IdRouter)
          .map(i => ({ cod: i.CODITM, cant: i.CANTIDAD1, pre: i.PRECIO, obs: i.OBSERVACIONES }));
      });
    }

    return res.json({
      datos: facturas,
      totales: { efectivo: ef, tarjeta: tj, mp: mp, general: gr, facturas: cFA, notas: cNC }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- 3. MEDIOS DE PAGO ---
router.get('/api/reporte/medios-pago', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    const pool = await poolMainPromise;
    const result = await pool.request()
      .input('suc', sql.Int, sucursal)
      .input('desde', sql.VarChar, desde)
      .input('hasta', sql.VarChar, hasta)
      .query(`
        SELECT Calc.MEDIO, COUNT(DISTINCT A.IdRouter) AS TICKETS,
        CAST(SUM(CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -A.TOTAL ELSE A.TOTAL END) AS MONEY) AS TOTAL_NETO
        FROM dbo.QRMVS A
        CROSS APPLY (
          SELECT TOP 1 CASE
            WHEN P.CODPAG = '001' THEN 'EFECTIVO'
            WHEN P.CODPAG = '100' THEN 'TARJETAS'
            WHEN P.CODPAG IN ('125','225') THEN 'MERCADO PAGO'
            ELSE 'EFECTIVO' END AS MEDIO
          FROM dbo.QRLineasPago P WHERE P.IdRouter = A.IdRouter
        ) Calc
        WHERE CAST(A.CODSUC AS VARCHAR) LIKE '%' + CAST(@suc AS VARCHAR)
          AND A.IDCOMPROBANTE > 0
          AND A.CODCMP IN ('FA', 'FB', 'CA', 'CB')
          AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
          AND A.ANULADO = 0
        GROUP BY Calc.MEDIO
        ORDER BY TOTAL_NETO DESC
      `);

    return res.json(result.recordset);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// --- 4. RUBROS (PROTEGIDO) ---
router.get('/api/reporte/rubros', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
      .query(`
        WITH ItemsLimpios AS (
          SELECT
            A.IdRouter,
            B.CODITM,
            A.CODCMP,
            ISNULL((
              SELECT TOP 1 VAL.DESCRIPCION
              FROM dbo.QRITEMSATRIB ATR
              INNER JOIN dbo.QRATRIBUTOSVAL VAL
                ON ATR.CODATR = VAL.CODATR
               AND ATR.CODATRVAL = VAL.CODATRVAL
              WHERE ATR.CODITM = B.CODITM
                AND ATR.CODATR = 'R'
            ), 'SIN RUBRO') AS RubroNombre,
            B.CANTIDAD1 AS CantidadFila
          FROM dbo.QRMVS A
          INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
          WHERE A.CODSUC = @suc
            AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
            AND A.ANULADO = 0
            AND A.IDCOMPROBANTE > 0
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

    return res.json(result.recordset);
  } catch (err) {
    console.error('ERROR /api/reporte/rubros:', err);
    return res.status(500).json({ error: err.message });
  }
});

// --- 12. DESCUENTOS (PROTEGIDO) ---
router.get('/api/reporte/auditoria-descuentos', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
      .query(`
        WITH VentasYDescuentos AS (
          SELECT
            A.IdRouter,
            B.CODITM,
            CAST(B.DESCRIPCION AS VARCHAR(MAX)) AS DescripcionItem,
            CASE WHEN B.CODITM LIKE 'DC%' THEN 'DESCUENTO' ELSE 'PRODUCTO' END AS TipoFila,
            CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -B.IMPORTE ELSE B.IMPORTE END AS ImporteNeto
          FROM dbo.QRMVS A
          INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
          WHERE A.CODSUC = @suc
            AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
            AND A.ANULADO = 0
            AND A.IDCOMPROBANTE > 0
        ),
        GlobalBruto AS (
          SELECT SUM(ImporteNeto) AS VentaBrutaTotal
          FROM VentasYDescuentos
          WHERE TipoFila = 'PRODUCTO'
        )
        SELECT
          'RESUMEN' AS TipoFila,
          'TOTAL' AS Concepto,
          '' AS Codigo,
          CAST(ISNULL((SELECT VentaBrutaTotal FROM GlobalBruto), 0) AS MONEY) AS ValBruto,
          CAST(SUM(ABS(ImporteNeto)) AS MONEY) AS ValDcto,
          CAST(ISNULL((SELECT VentaBrutaTotal FROM GlobalBruto), 0) - SUM(ABS(ImporteNeto)) AS MONEY) AS ValNeto,
          CAST((SUM(ABS(ImporteNeto)) / NULLIF((SELECT VentaBrutaTotal FROM GlobalBruto), 0)) * 100 AS DECIMAL(10,2)) AS Porcentaje,
          COUNT(DISTINCT IdRouter) AS CantTickets
        FROM VentasYDescuentos
        WHERE TipoFila = 'DESCUENTO'

        UNION ALL

        SELECT
          'DETALLE' AS TipoFila,
          DescripcionItem AS Concepto,
          CODITM AS Codigo,
          CAST(0 AS MONEY) AS ValBruto,
          CAST(SUM(ABS(ImporteNeto)) AS MONEY) AS ValDcto,
          CAST(0 AS MONEY) AS ValNeto,
          CAST((SUM(ABS(ImporteNeto)) / NULLIF((SELECT VentaBrutaTotal FROM GlobalBruto), 0)) * 100 AS DECIMAL(10,2)) AS Porcentaje,
          COUNT(DISTINCT IdRouter) AS CantTickets
        FROM VentasYDescuentos
        WHERE TipoFila = 'DESCUENTO'
        GROUP BY CODITM, DescripcionItem;
      `);

    const rows = result.recordset || [];
    const resumenRow = rows.find(r => r.TipoFila === 'RESUMEN') || {
      ValBruto: 0, ValDcto: 0, ValNeto: 0, Porcentaje: 0, CantTickets: 0
    };
    const detalleRows = rows.filter(r => r.TipoFila === 'DETALLE');

    // Formateo money "seguro"
    const formatMoney = (val) => {
      const n = Number(val || 0);
      return '$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    return res.json({
      resumen: {
        bruto: formatMoney(resumenRow.ValBruto),
        descuento: formatMoney(resumenRow.ValDcto),
        neto: formatMoney(resumenRow.ValNeto),
        porcentaje: Number(resumenRow.Porcentaje || 0),
        tickets: Number(resumenRow.CantTickets || 0),
      },
      detalle: detalleRows.map(d => ({
        codigo: d.Codigo,
        concepto: d.Concepto,
        monto: formatMoney(d.ValDcto),
        porcentaje: Number(d.Porcentaje || 0),
        tickets: Number(d.CantTickets || 0),
      }))
    });
  } catch (err) {
    console.error('ERROR /api/reporte/auditoria-descuentos:', err);
    return res.status(500).json({ error: err.message });
  }
});
// --- 5. TICKET PROMEDIO (PROTEGIDO) ---
router.get('/api/reporte/ticket-promedio', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
      .query(`
        SELECT
          CONVERT(VARCHAR(10), FECHA, 103) AS FECHA,
          COUNT(DISTINCT IdRouter) AS TICKETS,
          SUM(CASE WHEN CODCMP IN ('CA', 'CB') THEN -TOTAL ELSE TOTAL END) AS VENTA_NETA
        FROM dbo.QRMVS
        WHERE CODSUC = @suc
          AND CAST(FECHA AS DATE) BETWEEN @desde AND @hasta
          AND CODCMP IN ('FA','FB','CA','CB')
          AND IDCOMPROBANTE > 0
          AND ANULADO = 0
        GROUP BY CONVERT(VARCHAR(10), FECHA, 103)
        ORDER BY MIN(FECHA) DESC;
      `);

    const rows = result.recordset || [];
    const totalVenta = rows.reduce((a, r) => a + Number(r.VENTA_NETA || 0), 0);
    const totalTickets = rows.reduce((a, r) => a + Number(r.TICKETS || 0), 0);

    return res.json({
      datos: rows,
      resumen: {
        venta: totalVenta,
        tickets: totalTickets,
        promedio: totalTickets > 0 ? totalVenta / totalTickets : 0
      }
    });
  } catch (err) {
    console.error('ERROR /api/reporte/ticket-promedio:', err);
    return res.status(500).json({ error: err.message });
  }
});
// --- 4. FRANJAS HORARIAS (PROTEGIDO) ---
router.get('/api/reporte/franjas', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
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
            (CASE WHEN A.CODCMP IN ('CA', 'CB') THEN -A.TOTAL ELSE A.TOTAL END) AS MONTO,
            CASE
              WHEN DATEPART(HOUR, A.[timestamp]) >= 9  AND DATEPART(HOUR, A.[timestamp]) < 13 THEN 'MAÑANA (09-13hs)'
              WHEN DATEPART(HOUR, A.[timestamp]) >= 13 AND DATEPART(HOUR, A.[timestamp]) < 17 THEN 'TARDE 1 (13-17hs)'
              ELSE 'TARDE 2 (17-22hs)'
            END AS F_ASIG
          FROM dbo.QRMVS A
          WHERE A.CODSUC = @suc
            AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
            AND A.CODCMP IN ('FA','FB','CA','CB')
            AND A.IDCOMPROBANTE > 0
            AND A.ANULADO = 0
        )
        SELECT
          M.F_NOM AS FRANJA,
          COUNT(V.IdRouter) AS TICKETS,
          ISNULL(SUM(V.MONTO), 0) AS TOTAL_VENTAS
        FROM MasterFranjas M
        LEFT JOIN Ventas V ON M.F_NOM = V.F_ASIG
        GROUP BY M.F_NOM, M.Ord
        ORDER BY M.Ord;
      `);

    return res.json(result.recordset || []);
  } catch (err) {
    console.error('ERROR /api/reporte/franjas:', err);
    return res.status(500).json({ error: err.message });
  }
});
// --- 9. RANKING TOP ARTICULOS (PROTEGIDO) ---
router.get('/api/reporte/ranking', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
      .query(`
        SELECT TOP 5
          B.CODITM AS ARTICULO,
          C.DESCRIPCION,
          SUM(CASE WHEN A.CODCMP IN ('CA','CB') THEN -B.CANTIDAD1 ELSE B.CANTIDAD1 END) AS UNIDADES,
          SUM(CASE WHEN A.CODCMP IN ('CA','CB')
                   THEN -(B.CANTIDAD1 * B.PRECIO)
                   ELSE  (B.CANTIDAD1 * B.PRECIO)
              END) AS RECAUDACION_NETA
        FROM dbo.QRMVS A
        INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
        INNER JOIN dbo.QRITEMS C ON C.CODITM = B.CODITM
        WHERE A.CODSUC = @suc
          AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
          AND A.CODCMP IN ('FA','FB','CA','CB')
          AND A.IDCOMPROBANTE > 0
          AND A.ANULADO = 0
          AND B.CODITM NOT LIKE 'DC%'
          AND B.CODITM NOT IN ('ajucen', 'SCAMBIO', 'difprecio', 'AJS')
        GROUP BY B.CODITM, C.DESCRIPCION
        ORDER BY UNIDADES DESC;
      `);

    return res.json({ ranking: result.recordset || [] });
  } catch (err) {
    console.error('ERROR /api/reporte/ranking:', err);
    return res.status(500).json({ error: err.message });
  }
});
// --- 6. STOCK FISICO (PROTEGIDO) ---
router.get('/api/reporte/stock-fisico', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const articulo = cleanParam(req.query.articulo);

  try {
    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    let q = `
      SELECT
        S.CODITM,
        I.DESCRIPCION,
        CAST(S.STKACTUAL AS INT) AS STOCK
      FROM dbo.QRITEMSACUM S
      INNER JOIN dbo.QRITEMS I ON S.CODITM = I.CODITM
      WHERE S.CODSUC = @suc
        AND S.STKACTUAL > 0
    `;

    if (articulo !== '') {
      q += ` AND S.CODITM LIKE '%' + @art + '%'`;
    }

    q += ` ORDER BY S.CODITM;`;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('art', sql.VarChar, articulo)
      .query(q);

    return res.json(result.recordset || []);
  } catch (err) {
    console.error('ERROR /api/reporte/stock-fisico:', err);
    return res.status(500).json({ error: err.message });
  }
});


// --- 7. STOCK VALORIZADO (PROTEGIDO) ---
router.get('/api/reporte/stock-valorizado', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);

  try {
    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .query(`
        SELECT
          A.CODITM,
          C.DESCRIPCION,
          CAST(A.STKACTUAL AS INT) AS STKACTUAL,
          ISNULL(P.PRECIO, 0) AS PRECIO_UNITARIO,
          ISNULL(CAST(A.STKACTUAL * P.PRECIO AS MONEY), 0) AS TOTAL_VALORIZADO,
          ISNULL(R.RUBRO_DESC, 'SIN RUBRO') AS RUBRO
        FROM dbo.QRITEMSACUM A
        INNER JOIN dbo.QRITEMS C ON A.CODITM = C.CODITM
        OUTER APPLY (
          SELECT TOP 1 PRECIO
          FROM dbo.QRLISTASPRECIOS
          WHERE CODITM = A.CODITM AND CODLIS = 'PCI'
        ) P
        OUTER APPLY (
          SELECT TOP 1 VAL.DESCRIPCION AS RUBRO_DESC
          FROM dbo.QRITEMSATRIB ATR
          INNER JOIN dbo.QRATRIBUTOSVAL VAL
            ON ATR.CODATR = VAL.CODATR
           AND ATR.CODATRVAL = VAL.CODATRVAL
          WHERE ATR.CODITM = A.CODITM
            AND ATR.CODATR = 'R'
        ) R
        WHERE A.CODSUC = @suc
          AND A.STKACTUAL > 0
        ORDER BY TOTAL_VALORIZADO DESC;
      `);

    const rows = result.recordset || [];
    const totalCartera = rows.reduce((acc, r) => acc + Number(r.TOTAL_VALORIZADO || 0), 0);

    return res.json({ detalles: rows, totalCartera });
  } catch (err) {
    console.error('ERROR /api/reporte/stock-valorizado:', err);
    return res.status(500).json({ error: err.message });
  }
});
// --- 8. LOGISTICA (IE/EE) (PROTEGIDO) ---
router.get('/api/reporte/logistica', authRequired, async (req, res) => {
  const sucursal = getSucursalFromReq(req);
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);
  const articulo = cleanParam(req.query.articulo);

  try {
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const sucInt = parseInt(sucursal, 10);
    if (!sucInt || Number.isNaN(sucInt)) {
      return res.status(400).json({ error: 'Sucursal invalida (admin por query, usuario por token)' });
    }

    const pool = await poolMainPromise;

    let q = `
      SELECT
        CONVERT(VARCHAR(10), A.FECHA, 103) AS FECHA_STR,
        A.CODCMP,
        A.PREFIJO,
        A.NUMERO,
        H.DESCRIPCION AS CONCEPTO,
        B.CODITM,
        CAST(B.CANTIDAD1 AS INT) AS CANT
      FROM dbo.QRMVS A
      INNER JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
      INNER JOIN dbo.QRMVSMAT G ON G.IdRouter = A.IdRouter
      INNER JOIN dbo.QRConceptos H ON G.CodConcepto = H.CODCPT
      WHERE A.CODSUC = @suc
        AND CAST(A.FECHA AS DATE) BETWEEN @desde AND @hasta
        AND A.CODCMP IN ('EE', 'IE')
        AND A.IDCOMPROBANTE > 0
        AND A.ANULADO = 0
    `;

    if (articulo !== '') {
      q += ` AND B.CODITM LIKE '%' + @art + '%'`;
    }

    q += ` ORDER BY A.FECHA DESC;`;

    const result = await pool.request()
      .input('suc', sql.Int, sucInt)
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
      .input('art', sql.VarChar, articulo)
      .query(q);

    const movs = {};
    (result.recordset || []).forEach(r => {
      const k = `${r.CODCMP}-${r.PREFIJO}-${r.NUMERO}`;
      if (!movs[k]) {
        movs[k] = {
          tipo: r.CODCMP,
          prefijo: r.PREFIJO,
          numero: r.NUMERO,
          fecha: r.FECHA_STR,
          concepto: r.CONCEPTO,
          items: []
        };
      }
      movs[k].items.push({ cod: r.CODITM, cant: r.CANT });
    });

    return res.json(Object.values(movs));
  } catch (err) {
    console.error('ERROR /api/reporte/logistica:', err);
    return res.status(500).json({ error: err.message });
  }
});
// --- 13. GRILLA DIARIA CONSOLIDADA (SOLO ADMIN) ---
router.get('/api/reporte/ventas-grilla-diaria', authRequired, async (req, res) => {
  const desde = cleanParam(req.query.desde);
  const hasta = cleanParam(req.query.hasta);

  try {
    if (req.user?.rol !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    if (!desde || !hasta) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }

    const pool = await poolMainPromise;

    const result = await pool.request()
      .input('desde', sql.Date, desde)
      .input('hasta', sql.Date, hasta)
      .query(`
        DECLARE @cols NVARCHAR(MAX), @sum_cols NVARCHAR(MAX), @query NVARCHAR(MAX);

        SELECT @cols = STUFF((
          SELECT ',' + QUOTENAME(CONVERT(VARCHAR, Fecha, 103))
          FROM (
            SELECT DISTINCT CAST(FECHA AS DATE) AS Fecha
            FROM dbo.QRMVS
            WHERE CAST(FECHA AS DATE) BETWEEN @desde AND @hasta
          ) AS Dias
          ORDER BY Fecha
          FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 1, '');

        SELECT @sum_cols = STUFF((
          SELECT '+ISNULL(CAST(' + QUOTENAME(CONVERT(VARCHAR, Fecha, 103)) + ' AS MONEY),0)'
          FROM (
            SELECT DISTINCT CAST(FECHA AS DATE) AS Fecha
            FROM dbo.QRMVS
            WHERE CAST(FECHA AS DATE) BETWEEN @desde AND @hasta
          ) AS Dias
          ORDER BY Fecha
          FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 1, '');

        SET @query = '
          SELECT SUCURSAL, ' + @cols + ', (' + @sum_cols + ') AS TOTAL_SUCURSAL
          FROM (
            SELECT
              S.NOMBRE AS SUCURSAL,
              CONVERT(VARCHAR, CAST(A.FECHA AS DATE), 103) AS Dia,
              SUM(CAST(CASE
                WHEN A.CODCMP IN (''FA'',''FB'') THEN B.IMPORTE
                WHEN A.CODCMP IN (''CA'',''CB'') THEN -B.IMPORTE
                ELSE 0 END AS MONEY)) AS Neto
            FROM dbo.QRSUCURSALES S
            LEFT JOIN dbo.QRMVS A ON S.CODSUC = A.CODSUC
              AND CAST(A.FECHA AS DATE) BETWEEN @p_desde AND @p_hasta
              AND A.ANULADO = 0
              AND A.CODCMP IN (''FA'',''FB'',''CA'',''CB'')
            LEFT JOIN dbo.QRLINEASITEMS B ON A.IdRouter = B.IdRouter
              AND B.IDCOMPROBANTE > 0
            WHERE S.CODEMP <> 1 AND S.CODSUC NOT IN (996, 997)
            GROUP BY S.NOMBRE, CAST(A.FECHA AS DATE)
          ) x
          PIVOT (
            SUM(Neto) FOR Dia IN (' + @cols + ')
          ) p
          ORDER BY TOTAL_SUCURSAL DESC;
        ';

        EXEC sp_executesql
          @query,
          N'@p_desde DATE, @p_hasta DATE',
          @p_desde = @desde,
          @p_hasta = @hasta;
      `);

    return res.json(result.recordset || []);
  } catch (err) {
    console.error('ERROR /api/reporte/ventas-grilla-diaria:', err);
    return res.status(500).json({ error: err.message });
  }
});



module.exports = router;

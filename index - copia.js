require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { poolPromise, sql } = require('./db')

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

app.get('/', (req, res) => {
  res.send('API Facturas OK')
})

app.get('/api/facturas', async (req, res) => {
  try {
    const { sucursal, desde, hasta } = req.query

    if (!sucursal) {
      return res.status(400).json({ error: 'Falta parámetro sucursal' })
    }

    const pool = await poolPromise
    const request = pool.request()

    request.input('sucursal', sql.Int, sucursal)

    let whereFecha = ''

    if (desde) {
      request.input('desde', sql.Date, desde)
      whereFecha += ' AND A.FECHA >= @desde'
    }

    if (hasta) {
      request.input('hasta', sql.Date, hasta)
      whereFecha += ' AND A.FECHA < DATEADD(day,1,@hasta)'
    }

    const result = await request.query(`
      SELECT DISTINCT
        A.PREFIJO,
        A.NUMERO,
        A.FECHA,

        B.CODITM,
        B.CANTIDAD1,
        CAST(B.PRECIO AS MONEY) AS PRECIO,

        CASE 
          WHEN C.CODPAG = '001' THEN 'PAGO EFECTIVO'
          WHEN C.CODPAG = '100' THEN 'PAGO TARJETA'
          WHEN C.CODPAG = '125' THEN 'MERCADO PAGO'
          ELSE 'OTRO'
        END AS PAGO_DESC,

        T.DESCRIPCION AS TARJETA_DESC,
        P.DESCRIPCION AS PLAN_DESC,
        P.CUOTAS

      FROM dbo.QRMVS A

      INNER JOIN dbo.QRLINEASITEMS B
        ON A.IdRouter = B.IdRouter

      INNER JOIN dbo.QRLineasPago C
        ON A.IdRouter = C.IdRouter

      LEFT JOIN QRCUPONES D
        ON C.IDCUPON = D.IDCUPON
       AND C.CODPAG = '100'

      LEFT JOIN QRTARJETAS T
        ON D.CODTARJETA = T.CODTARJETA

      LEFT JOIN QRTarjetplanes P
        ON D.CODPLAN = P.CODPLAN

      WHERE A.CODSUC = @sucursal
        AND A.CODCMP IN ('FB','FA','CB','CA')
        ${whereFecha}

      ORDER BY A.FECHA, A.PREFIJO, A.NUMERO
    `)

    // Agrupar por factura
    const facturas = {}

    result.recordset.forEach(r => {
      const key = `${r.PREFIJO}-${r.NUMERO}`

      if (!facturas[key]) {
        facturas[key] = {
          prefijo: r.PREFIJO,
          numero: r.NUMERO,
          fecha: r.FECHA,
          pago_desc: r.PAGO_DESC,
          tarjeta_desc: r.TARJETA_DESC,
          plan_desc: r.PLAN_DESC,
          cuotas: r.CUOTAS,
          items: []
        }
      }

      facturas[key].items.push({
        codigo: r.CODITM,
        cantidad: r.CANTIDAD1,
        precio: r.PRECIO
      })
    })

    res.json(Object.values(facturas))

  } catch (err) {
    console.error('ERROR SQL:', err)
    res.status(500).json({ error: 'Error consultando facturas' })
  }
})

app.get('/health', (req, res) => res.send('OK'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 API escuchando en puerto ${PORT}`)
})

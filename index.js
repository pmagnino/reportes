require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { poolPromise, sql } = require('./db')

const app = express()

// Middlewares
app.use(cors())
app.use(express.json())

// Servir frontend
app.use(express.static('public'))

// Ruta raiz
app.get('/', (req, res) => {
  res.send('API Facturas OK')
})

// API facturas
app.get('/api/facturas', async (req, res) => {
  try {
    const { sucursal, desde, hasta } = req.query

    if (!sucursal) {
      return res.status(400).json({ error: 'Falta parametro sucursal' })
    }

    const pool = await poolPromise
    const request = pool.request()
      .input('sucursal', sql.Int, sucursal)

    let whereFecha = ''

    if (desde) {
      request.input('desde', sql.Date, desde)
      whereFecha += ' AND A.FECHA >= @desde'
    }

    if (hasta) {
      request.input('hasta', sql.Date, hasta)
      whereFecha += ' AND A.FECHA <= @hasta'
    }

    const result = await request.query(`
SELECT 
    A.PREFIJO,
    A.NUMERO,
    A.FECHA,
    B.CODITM,
    B.CANTIDAD1,
    C.CODPAG,
    D.NROCUPON,
    D.CODTARJETA,
    D.CODPLAN
FROM QRMVS A WITH (NOLOCK)
INNER JOIN QRLINEASITEMS B WITH (NOLOCK)
    ON A.IdRouter = B.IdRouter
INNER JOIN QRLineasPago C WITH (NOLOCK)
    ON A.IdRouter = C.IdRouter
INNER JOIN QRCUPONES D WITH (NOLOCK)
    ON D.IDCUPON = C.IDCUPON
WHERE 1 = 1
  AND A.CODSUC = @sucursal
  AND A.CODCMP IN ('FB','FA','CB','CA')
  ${whereFecha};
    `)

    // Agrupar por factura
    const facturas = {}

    result.recordset.forEach(row => {
      const key = `${row.PREFIJO}-${row.NUMERO}`

      if (!facturas[key]) {
        facturas[key] = {
          prefijo: row.PREFIJO,
          numero: row.NUMERO,
          fecha: row.FECHA,
          items: []
        }
      }

      facturas[key].items.push({
        codigo: row.CODITM,
        cantidad: row.CANTIDAD1
      })
    })

    res.json(Object.values(facturas))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error consultando facturas' })
  }
})
// Health check
app.get('/health', (req, res) => {
  res.send('OK')
})

// Start server
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 API escuchando en puerto ${PORT}`)
})

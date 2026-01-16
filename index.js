// index.js
const express = require('express');
const path = require('path');
const cors = require('cors');

require('dotenv').config();

// TZ (opcional)
process.env.TZ = 'America/Argentina/Buenos_Aires';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Home (opcional)
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'reporte_index.html'));
});

// Healthcheck (PARA ECS / ALB) - NO lleva auth
app.get('/health', async (req, res) => {
  try {
    // Import lazy para no romper si db aun no esta listo
    const { poolMainPromise } = require('./db');
    const pool = await poolMainPromise;
    await pool.request().query('SELECT 1');
    return res.status(200).send('OK');
  } catch (err) {
    return res.status(500).send('DB ERROR');
  }
});

// Rutas (orden recomendado)
// 1) auth primero (login es publico)
app.use(require('./routes/auth.routes'));

// 2) el resto ya protegido adentro de cada routes con authRequired
app.use(require('./routes/main.routes'));
app.use(require('./routes/users.routes'));

// 404 JSON para /api (evita "Unexpected token <")
app.use('/api', (req, res) => {
  return res.status(404).json({ error: 'API route not found' });
});

// fallback a index (para archivos html si queres)
app.use((req, res) => {
  return res.status(404).sendFile(path.join(__dirname, 'public', 'reporte_index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Mimo BI Server Activo en Puerto ${PORT}`));

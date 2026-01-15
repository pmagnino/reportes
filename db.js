const sql = require('mssql');
require('dotenv').config();

const dbPort = parseInt(process.env.DB_PORT || '1433', 10);

// =============================
// DB PRINCIPAL (REPORTES)
// =============================
const mainConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,        // BAS...
  port: dbPort,
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// =============================
// DB AUTENTICACION (USUARIOS)
// =============================
const authConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.AUTH_DB_DATABASE,   // Controxxxx
  port: dbPort,
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// Pool REPORTES
const poolMainPromise = new sql.ConnectionPool(mainConfig)
  .connect()
  .then(pool => {
    console.log('✔ MSSQL conectado (REPORTES)');
    return pool;
  })
  .catch(err => {
    console.error('❌ Error MSSQL REPORTES', err);
    throw err;
  });

// Pool AUTENTICACION
const poolAuthPromise = new sql.ConnectionPool(authConfig)
  .connect()
  .then(pool => {
    console.log('✔ MSSQL conectado (AUTH)');
    return pool;
  })
  .catch(err => {
    console.error('❌ Error MSSQL AUTH', err);
    throw err;
  });

module.exports = {
  sql,
  poolMainPromise,
  poolAuthPromise
};

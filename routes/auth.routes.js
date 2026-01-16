const express = require('express');
const router = express.Router();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { sql, poolAuthPromise } = require('../db');

router.post('/api/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;

    if (!usuario || !password) {
      return res.status(400).json({ error: 'Faltan credenciales' });
    }

    const pool = await poolAuthPromise;

    const result = await pool.request()
      .input('usuario', sql.VarChar, usuario)
      .query(`
        SELECT TOP 1
          id,
          usuario,
          password_hash,
          rol,
          sucursal,
          activo
        FROM dbo.usuarios_reportes
        WHERE usuario = @usuario
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    const u = result.recordset[0];

    if (!u.activo) {
      return res.status(403).json({ error: 'Usuario inactivo' });
    }

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    const token = jwt.sign(
      { id: u.id, usuario: u.usuario, rol: u.rol, sucursal: u.sucursal },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '8h' }
    );

    return res.json({
      token,
      user: {
        id: u.id,
        usuario: u.usuario,
        rol: u.rol,
        sucursal: u.sucursal,
        activo: !!u.activo
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

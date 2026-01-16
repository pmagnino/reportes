const express = require('express');
const router = express.Router();

const bcrypt = require('bcrypt');
const { sql, poolAuthPromise } = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');

// LISTAR (solo admin)
router.get('/api/usuarios', authRequired, adminOnly, async (req, res) => {
  try {
    const pool = await poolAuthPromise;
    const result = await pool.request().query(`
      SELECT id, usuario, rol, sucursal, activo
      FROM dbo.usuarios_reportes
      ORDER BY usuario ASC
    `);
    return res.json(result.recordset);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// CREAR (solo admin)
router.post('/api/usuarios', authRequired, adminOnly, async (req, res) => {
  try {
    const { usuario, password, rol, sucursal, activo } = req.body;

    if (!usuario || !password) {
      return res.status(400).json({ error: 'usuario y password son obligatorios' });
    }

    const pool = await poolAuthPromise;

    const exists = await pool.request()
      .input('usuario', sql.VarChar, usuario)
      .query(`SELECT TOP 1 id FROM dbo.usuarios_reportes WHERE usuario = @usuario`);

    if (exists.recordset.length > 0) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }

    const hash = await bcrypt.hash(password, 10);

    await pool.request()
      .input('usuario', sql.VarChar, usuario)
      .input('password_hash', sql.VarChar, hash)
      .input('rol', sql.VarChar, rol || 'usuario')
      .input('sucursal', sql.Int, sucursal ? parseInt(sucursal, 10) : null)
      .input('activo', sql.Bit, activo ? 1 : 0)
      .query(`
        INSERT INTO dbo.usuarios_reportes (usuario, password_hash, rol, sucursal, activo)
        VALUES (@usuario, @password_hash, @rol, @sucursal, @activo)
      `);

    return res.status(201).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// EDITAR (solo admin)
router.put('/api/usuarios/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { usuario, password, rol, sucursal, activo } = req.body;

    if (!id || !usuario) {
      return res.status(400).json({ error: 'id y usuario son obligatorios' });
    }

    const pool = await poolAuthPromise;

    if (password && password.trim() !== '') {
      const hash = await bcrypt.hash(password, 10);

      await pool.request()
        .input('id', sql.Int, id)
        .input('usuario', sql.VarChar, usuario)
        .input('password_hash', sql.VarChar, hash)
        .input('rol', sql.VarChar, rol || 'usuario')
        .input('sucursal', sql.Int, sucursal ? parseInt(sucursal, 10) : null)
        .input('activo', sql.Bit, activo ? 1 : 0)
        .query(`
          UPDATE dbo.usuarios_reportes
          SET usuario = @usuario,
              password_hash = @password_hash,
              rol = @rol,
              sucursal = @sucursal,
              activo = @activo
          WHERE id = @id
        `);
    } else {
      await pool.request()
        .input('id', sql.Int, id)
        .input('usuario', sql.VarChar, usuario)
        .input('rol', sql.VarChar, rol || 'usuario')
        .input('sucursal', sql.Int, sucursal ? parseInt(sucursal, 10) : null)
        .input('activo', sql.Bit, activo ? 1 : 0)
        .query(`
          UPDATE dbo.usuarios_reportes
          SET usuario = @usuario,
              rol = @rol,
              sucursal = @sucursal,
              activo = @activo
          WHERE id = @id
        `);
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

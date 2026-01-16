// middleware/auth.js
const jwt = require('jsonwebtoken');

function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'NO_TOKEN' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, usuario, rol, sucursal }
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  return next();
}

module.exports = { authRequired, adminOnly };

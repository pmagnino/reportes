// public/auth.js
const AUTH_TOKEN_KEY = 'mimo_token';
const AUTH_USER_KEY  = 'mimo_user';

function setSession(token, user) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

function getToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function getUser() {
  const raw = localStorage.getItem(AUTH_USER_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function clearSession() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

function logout() {
  clearSession();
  window.location.href = '/login.html';
}

function protectPage() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

/**
 * NUEVA FUNCIÓN: Bloquea el acceso a reportes de Admin 
 * para usuarios con rol 'sucursal' o similar.
 */
function verificarAccesoAdmin() {
    const user = getUser();
    // Si el usuario existe pero NO es admin, le borramos la pantalla y mostramos el error
    if (user && user.rol !== 'admin') {
        document.body.innerHTML = `
            <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: #f1f5f9; font-family: 'Inter', sans-serif; padding: 20px;">
                <div style="max-width: 450px; width: 100%; background: white; padding: 40px; border-radius: 20px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); text-align: center;">
                    <div style="width: 80px; height: 80px; background: #fef2f2; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;">
                        <i class="bi bi-shield-lock" style="font-size: 35px; color: #dc2626;"></i>
                    </div>
                    <h2 style="color: #1e293b; font-size: 22px; font-weight: 800; margin-bottom: 12px;">
                        FORMULARIO NO DISPONIBLE
                    </h2>
                    <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin-bottom: 32px;">
                        Lo sentimos, su perfil de usuario (<strong>${user.usuario || 'Sucursal'}</strong>) no tiene permisos para acceder a reportes consolidados.
                    </p>
                    <a href="reporte_index.html" style="display: inline-block; background: #1e293b; color: white; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700; font-size: 14px; transition: 0.3s;">
                        VOLVER AL PANEL PRINCIPAL
                    </a>
                </div>
            </div>`;
        return false;
    }
    return true;
}

async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = Object.assign({}, options.headers || {});

  if (token) headers['Authorization'] = `Bearer ${token}`;
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    window.location.href = '/login.html';
    throw new Error('No autorizado (401)');
  }

  return res;
}
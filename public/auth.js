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

// Protege páginas HTML (si no hay token, afuera)
function protectPage() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

// fetch con JWT
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = Object.assign({}, options.headers || {});

  if (token) headers['Authorization'] = `Bearer ${token}`;
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';

  const res = await fetch(url, { ...options, headers });

  // Si el backend ahora responde 401, te mando al login
  if (res.status === 401) {
    clearSession();
    window.location.href = '/login.html';
    throw new Error('No autorizado (401)');
  }

  return res;
}

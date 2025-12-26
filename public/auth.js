function getToken() {
    return localStorage.getItem('token');
}

function protectPage() {
    const token = getToken();

    if (!token) {
        window.location.href = '/login.html';
        return;
    }
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = '/login.html';
}

async function authFetch(url, options = {}) {
    const token = getToken();

    if (!token) {
        logout();
        return;
    }

    options.headers = {
        ...(options.headers || {}),
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    const res = await fetch(url, options);

    if (res.status === 401 || res.status === 403) {
        logout();
        return;
    }

    return res;
}

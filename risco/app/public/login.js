const form = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const errorEl = document.getElementById('login-error');

const setError = (msg) => {
  if (!errorEl) return;
  errorEl.textContent = msg || '';
  errorEl.style.color = msg ? '#fca5a5' : 'inherit';
};

const handleLogin = async () => {
  const username = document.getElementById('username')?.value || '';
  const password = document.getElementById('password')?.value || '';
  if (!username || !password) {
    setError('Completa usuario y contrase\u00f1a');
    return;
  }
  try {
    setError('');
    loginBtn.disabled = true;
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status === 401) {
      setError('Credenciales no v\u00e1lidas');
      loginBtn.disabled = false;
      return;
    }
    if (!res.ok) throw new Error('login_failed');
    window.location.href = '/';
  } catch (e) {
    console.error(e);
    setError('No se pudo iniciar sesi\u00f3n');
    loginBtn.disabled = false;
  }
};

if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleLogin();
  });
}
if (loginBtn) {
  loginBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handleLogin();
  });
}

const statusMsg = document.getElementById('status-msg');
const passMsg = document.getElementById('pass-msg');
const logoutBtn = document.getElementById('logout-btn');

const setStatus = (msg, ok = true) => {
  if (!statusMsg) return;
  statusMsg.textContent = msg;
  statusMsg.style.color = ok ? '#94a3b8' : '#fca5a5';
};
const setPassStatus = (msg, ok = true) => {
  if (!passMsg) return;
  passMsg.textContent = msg;
  passMsg.style.color = ok ? '#94a3b8' : '#fca5a5';
};

const handleUnauthorized = (res) => {
  if (res && res.status === 401) {
    window.location.href = '/login';
    return true;
  }
  return false;
};

const fillConfig = (cfg) => {
  document.getElementById('panelIp').value = cfg.panel?.panelIp || '';
  document.getElementById('panelPort').value = cfg.panel?.panelPort || '';
  const maskedPanelPass = cfg.panel?.panelPassword === '***' ? '' : (cfg.panel?.panelPassword || '');
  document.getElementById('panelPassword').value = maskedPanelPass;
  document.getElementById('panelId').value = cfg.panel?.panelId || '';
  document.getElementById('webPort').value = cfg.web?.http_port || '';
  document.getElementById('wsPath').value = cfg.web?.ws_path || '';
  document.getElementById('modbusHost').value = cfg.modbus?.host || '';
  document.getElementById('modbusPort').value = cfg.modbus?.port || '';
  document.getElementById('logLevel').value = cfg.log || 'info';
  document.getElementById('logColorize').checked = !!cfg.logColorize;
  document.getElementById('heartbeatMs').value = cfg.heartbeat_interval_ms ?? 0;
};

const loadConfig = async () => {
  try {
    const res = await fetch('/api/config');
    if (handleUnauthorized(res)) return;
    if (!res.ok) throw new Error('config_fetch_failed');
    const data = await res.json();
    fillConfig(data.config || {});
    setStatus('Config cargada', true);
  } catch (e) {
    console.error(e);
    setStatus('No se pudo cargar la configuracion', false);
  }
};

const gatherConfig = () => ({
  panel: {
    panelIp: document.getElementById('panelIp').value,
    panelPort: Number(document.getElementById('panelPort').value),
    panelPassword: document.getElementById('panelPassword').value,
    panelId: document.getElementById('panelId').value,
  },
  web: {
    http_port: Number(document.getElementById('webPort').value),
    ws_path: document.getElementById('wsPath').value,
  },
  modbus: {
    host: document.getElementById('modbusHost').value,
    port: Number(document.getElementById('modbusPort').value),
  },
  log: document.getElementById('logLevel').value,
  logColorize: document.getElementById('logColorize').checked,
  heartbeat_interval_ms: Number(document.getElementById('heartbeatMs').value || 0),
});

const saveConfig = async (restartAfter = false) => {
  try {
    setStatus('Guardando...', true);
    const payload = gatherConfig();
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (handleUnauthorized(res)) return;
    if (!res.ok) throw new Error('save_failed');
    setStatus(restartAfter ? 'Guardado. Reiniciando...' : 'Config guardada (reinicia para aplicar).', true);
    if (restartAfter) {
      await restartService();
    }
  } catch (e) {
    console.error(e);
    setStatus('No se pudo guardar la config', false);
  }
};

const applyHostIp = async () => {
  const ip = document.getElementById('hostIp').value;
  const cidr = document.getElementById('hostCidr').value;
  const gateway = document.getElementById('hostGw').value;
  if (!ip || !cidr || !gateway) {
    setStatus('Completa IP/CIDR/Gateway', false);
    return;
  }
  try {
    setStatus('Aplicando IP del gateway...', true);
    const res = await fetch('/api/host/ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, cidr, gateway }),
    });
    if (handleUnauthorized(res)) return;
    if (res.status === 501) {
      setStatus('Cambio de IP no soportado en este entorno (falta script en host)', false);
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'No se pudo aplicar la IP', false);
      return;
    }
    setStatus('IP aplicada. Reiniciando servicio...', true);
    setTimeout(() => window.location.reload(), 1500);
  } catch (e) {
    console.error(e);
    setStatus('No se pudo aplicar la IP del gateway', false);
  }
};

const restartService = async () => {
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    if (handleUnauthorized(res)) return;
    if (!res.ok) throw new Error('restart_failed');
    setStatus('Reiniciando servicio...', true);
    setTimeout(() => window.location.reload(), 1500);
  } catch (e) {
    console.error(e);
    setStatus('No se pudo reiniciar el servicio', false);
  }
};

const factoryReset = async () => {
  const sure = confirm('Esto restablece config y usuario admin (Admin123). Continuar?');
  if (!sure) return;
  try {
    const res = await fetch('/api/factory-reset', { method: 'POST' });
    if (handleUnauthorized(res)) return;
    if (!res.ok) throw new Error('factory_failed');
    setStatus('Restablecido. Reiniciando...', true);
    setTimeout(() => window.location.href = '/login', 1500);
  } catch (e) {
    console.error(e);
    setStatus('No se pudo restablecer a f\u00e1brica', false);
  }
};

const changePassword = async () => {
  const current = document.getElementById('currentPassword').value;
  const next = document.getElementById('newPassword').value;
  const confirm = document.getElementById('confirmPassword').value;
  if (next !== confirm) {
    setPassStatus('Las contrase\u00f1as no coinciden', false);
    return;
  }
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    if (handleUnauthorized(res)) return;
    if (res.status === 401) {
      setPassStatus('Contrase\u00f1a actual no v\u00e1lida', false);
      return;
    }
    if (!res.ok) throw new Error('pass_failed');
    setPassStatus('Contrase\u00f1a actualizada', true);
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
  } catch (e) {
    console.error(e);
    setPassStatus('No se pudo actualizar la contrase\u00f1a', false);
  }
};

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    window.location.href = '/login';
  });
}

const form = document.getElementById('config-form');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfig(false);
  });
}

document.getElementById('save-restart-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  saveConfig(true);
});
document.getElementById('restart-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  restartService();
});
document.getElementById('factory-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  factoryReset();
});
document.getElementById('change-pass-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  changePassword();
});
document.getElementById('apply-host-ip')?.addEventListener('click', (e) => {
  e.preventDefault();
  applyHostIp();
});

window.addEventListener('DOMContentLoaded', loadConfig);

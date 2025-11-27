// Jaime Acosta github: jatsoca
import express from 'express';
import { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import * as Modbus from 'jsmodbus';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { execFile } from 'child_process';

type PartitionState = { id: number; status: string; ready?: boolean };
type ZoneState = { id: number; open: boolean; bypass: boolean; label: string };
type PanelState = { online: boolean };

export interface WebOptions {
  http_port: number;
  ws_path: string;
}
export interface ModbusOptions {
  enable: boolean;
  port: number;
  host: string;
}

export interface RealtimeState {
  partitions: Map<number, PartitionState>;
  zones: Map<number, ZoneState>;
  panel?: PanelState;
}

type Session = { username: string; exp: number };

const DATA_DIR = process.env.RISCO_DATA_DIR || '/data';
const CONFIG_PATH = process.env.RISCO_MQTT_HA_CONFIG_FILE || path.join(process.cwd(), 'config.json');
const DEFAULT_CONFIG_PATH = process.env.RISCO_MQTT_HA_DEFAULT_CONFIG || path.resolve(__dirname, '../../config.default.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HOST_IP_SCRIPT = process.env.RISCO_HOST_IP_SCRIPT || '/usr/local/bin/set-ip-rpi.sh';
const AUTH_COOKIE = 'risco_auth';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const sessions = new Map<string, Session>();

const allowedLogLevels = ['error', 'warn', 'info', 'verbose', 'debug'];

const parseCookies = (cookieHeader?: string) => {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const key = parts.shift()?.trim() || '';
      const value = decodeURIComponent(parts.join('=')).trim();
      if (key) list[key] = value;
    }
  });
  return list;
};

const getTokenFromRequest = (req: express.Request | { headers: any }) => {
  const cookieHeader = (req as any).headers?.cookie as string | undefined;
  const cookies = parseCookies(cookieHeader);
  return cookies[AUTH_COOKIE];
};

const setSessionCookie = (res: express.Response, token: string) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`);
};

const clearSessionCookie = (res: express.Response) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
};

const validateSession = (token?: string) => {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.exp = Date.now() + SESSION_TTL_MS;
  sessions.set(token, session);
  return session.username;
};

const ensureDir = async (dir: string) => {
  await fsp.mkdir(dir, { recursive: true });
};

const ensureConfigFile = async () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    await ensureDir(path.dirname(CONFIG_PATH));
    const source = fs.existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : path.join(__dirname, '../../config-sample.json');
    await fsp.copyFile(source, CONFIG_PATH);
  }
};

const defaultUsersContent = async () => {
  const hash = await bcrypt.hash('Admin123', 10);
  return { users: [{ username: 'admin', passwordHash: hash }] };
};

const ensureUsersFile = async () => {
  if (!fs.existsSync(USERS_FILE)) {
    await ensureDir(DATA_DIR);
    const payload = await defaultUsersContent();
    await fsp.writeFile(USERS_FILE, JSON.stringify(payload, null, 2));
  }
};

const loadUsers = async (): Promise<{ username: string; passwordHash: string }[]> => {
  await ensureUsersFile();
  const raw = await fsp.readFile(USERS_FILE, 'utf-8');
  const data = JSON.parse(raw);
  return Array.isArray(data.users) ? data.users : [];
};

const saveUsers = async (users: { username: string; passwordHash: string }[]) => {
  await ensureDir(DATA_DIR);
  await fsp.writeFile(USERS_FILE, JSON.stringify({ users }, null, 2));
};

const isHtmlRequest = (req: express.Request) => (req.headers.accept || '').includes('text/html');

const requireAuthJson = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = validateSession(getTokenFromRequest(req));
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  (req as any).user = user;
  return next();
};

const requireAuthHtml = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = validateSession(getTokenFromRequest(req));
  if (!user) {
    if (isHtmlRequest(req)) return res.redirect('/login');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  (req as any).user = user;
  return next();
};

const maskSensitiveFields = (config: any) => {
  const clone = JSON.parse(JSON.stringify(config));
  if (clone?.panel?.panelPassword !== undefined) clone.panel.panelPassword = '***';
  if (clone?.panel?.panelPassword2 !== undefined) clone.panel.panelPassword2 = '***';
  return clone;
};

const readConfig = async (mask = false) => {
  await ensureConfigFile();
  const raw = await fsp.readFile(CONFIG_PATH, 'utf-8');
  const data = JSON.parse(raw);
  return mask ? maskSensitiveFields(data) : data;
};

const writeConfig = async (config: any) => {
  await ensureDir(path.dirname(CONFIG_PATH));
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
};

const sanitizeLogLevel = (lvl: any) => (allowedLogLevels.includes(lvl) ? lvl : undefined);

const toPort = (val: any) => {
  const num = Number(val);
  if (Number.isInteger(num) && num > 0 && num <= 65535) return num;
  return undefined;
};

const isValidIp = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
const isValidCidr = (cidr: any) => {
  const num = Number(cidr);
  return Number.isInteger(num) && num >= 0 && num <= 32;
};

const applyConfigUpdate = (current: any, next: any) => {
  const updated = { ...current };
  updated.panel = { ...current.panel };
  updated.web = { ...current.web };
  updated.modbus = { ...current.modbus };

  if (next.panel?.panelIp || next.panelIp) updated.panel.panelIp = next.panel?.panelIp || next.panelIp;
  if (next.panel?.panelPort || next.panelPort) {
    const port = toPort(next.panel?.panelPort ?? next.panelPort);
    if (port) updated.panel.panelPort = port;
  }
  if (next.panel?.panelPassword || next.panelPassword) updated.panel.panelPassword = next.panel?.panelPassword ?? next.panelPassword;
  if (next.panel?.panelId || next.panelId) updated.panel.panelId = next.panel?.panelId ?? next.panelId;
  if (next.panel?.socketMode) updated.panel.socketMode = next.panel.socketMode;

  if (next.web?.http_port !== undefined) {
    const port = toPort(next.web.http_port);
    if (port) updated.web.http_port = port;
  }
  if (next.web?.ws_path) updated.web.ws_path = next.web.ws_path;
  if (next.web?.enable !== undefined) updated.web.enable = !!next.web.enable;

  if (next.modbus?.port !== undefined) {
    const port = toPort(next.modbus.port);
    if (port) updated.modbus.port = port;
  }
  if (next.modbus?.host) updated.modbus.host = next.modbus.host;
  if (next.modbus?.enable !== undefined) updated.modbus.enable = !!next.modbus.enable;

  if (next.log !== undefined) {
    const lvl = sanitizeLogLevel(next.log);
    if (lvl) updated.log = lvl;
  }
  if (next.logColorize !== undefined) updated.logColorize = !!next.logColorize;
  if (next.heartbeat_interval_ms !== undefined) {
    const num = Number(next.heartbeat_interval_ms);
    if (!Number.isNaN(num) && num >= 0) updated.heartbeat_interval_ms = num;
  }

  return updated;
};

const PARTITION_REGS = 32; // 32 particiones
const ZONE_REGS = 512;     // 512 zonas
const BYTES_PER_REG = 2;

export function startWebServer(
  web: WebOptions,
  modbus: ModbusOptions,
  state: RealtimeState,
  onArm: (partitionId: number, mode: 'away' | 'home' | 'disarm') => Promise<boolean>,
  onBypass?: (zoneId: number) => Promise<boolean>,
) {
  const app = express();
  const httpServer = new HttpServer(app);
  const panelState: PanelState = state.panel || { online: false };

  void ensureConfigFile();
  void ensureUsersFile();

  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const publicDir = path.join(process.cwd(), 'public');
  console.log(`[WEB] Static dir: ${publicDir}`);

  // Health (sin auth, usado por healthcheck)
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Auth
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_credentials' });
    const users = await loadUsers();
    const user = users.find((u) => u.username === username);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      clearSessionCookie(res);
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username, exp: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    return res.json({ ok: true, username });
  });

  app.post('/api/auth/logout', requireAuthJson, (req, res) => {
    const token = getTokenFromRequest(req);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuthJson, (req, res) => {
    res.json({ ok: true, username: (req as any).user });
  });

  app.post('/api/auth/password', requireAuthJson, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: 'new_password_too_short' });
    }
    const users = await loadUsers();
    const username = (req as any).user as string;
    const user = users.find((u) => u.username === username);
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const valid = await bcrypt.compare(currentPassword || '', user.passwordHash);
    if (!valid) return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await saveUsers(users);

    Array.from(sessions.entries()).forEach(([token, s]) => {
      if (s.username === username) sessions.delete(token);
    });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username, exp: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    res.json({ ok: true });
  });

  // Config
  app.get('/api/config', requireAuthJson, async (_req, res) => {
    const cfg = await readConfig(true);
    res.json({ ok: true, config: cfg });
  });

  app.post('/api/config', requireAuthJson, async (req, res) => {
    const cfg = await readConfig(false);
    const updated = applyConfigUpdate(cfg, req.body || {});
    await writeConfig(updated);
    res.json({ ok: true, needsRestart: true });
  });

  app.post('/api/restart', requireAuthJson, async (_req, res) => {
    res.json({ ok: true, restarting: true });
    setTimeout(() => process.exit(0), 500);
  });

  app.post('/api/factory-reset', requireAuthJson, async (_req, res) => {
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) return res.status(500).json({ ok: false, error: 'default_config_missing' });
    await ensureDir(path.dirname(CONFIG_PATH));
    await fsp.copyFile(DEFAULT_CONFIG_PATH, CONFIG_PATH);
    const payload = await defaultUsersContent();
    await fsp.writeFile(USERS_FILE, JSON.stringify(payload, null, 2));
    sessions.clear();
    res.json({ ok: true, needsRestart: true });
  });

  // Cambiar IP del host (Raspberry). Requiere script externo con sudo.
  app.post('/api/host/ip', requireAuthJson, async (req, res) => {
    const { ip, cidr, gateway } = req.body || {};
    if (!ip || !cidr || !gateway) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!isValidIp(ip) || !isValidIp(gateway) || !isValidCidr(cidr)) {
      return res.status(400).json({ ok: false, error: 'invalid_ip' });
    }
    if (!fs.existsSync(HOST_IP_SCRIPT)) {
      return res.status(501).json({ ok: false, error: 'host_ip_not_supported' });
    }
    execFile('sudo', [HOST_IP_SCRIPT, ip, String(cidr), gateway], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({ ok: false, error: 'script_error', detail: stderr || err.message });
      }
      res.json({ ok: true, restarting: true, output: stdout });
      setTimeout(() => process.exit(0), 500);
    });
  });

  // Datos en tiempo real
  app.get('/snapshot', requireAuthJson, (_req, res) => {
    res.json({
      panelOnline: panelState.online,
      partitions: Array.from(state.partitions.values()),
      zones: Array.from(state.zones.values()),
    });
  });

  // Assets
  app.use(express.static(publicDir, { index: false }));

  // WebSocket
  const wss = new WebSocketServer({ server: httpServer, path: web.ws_path });
  const broadcast = (msg: any) => {
    const data = JSON.stringify(msg);
    wss.clients.forEach((c) => {
      if (c.readyState === c.OPEN) c.send(data);
    });
  };

  wss.on('connection', (ws, req) => {
    const user = validateSession(getTokenFromRequest(req));
    if (!user) {
      ws.close(1008, 'unauthorized');
      return;
    }
    ws.send(JSON.stringify({
      type: 'snapshot',
      panelOnline: panelState.online,
      partitions: Array.from(state.partitions.values()),
      zones: Array.from(state.zones.values()),
    }));
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'arm' && msg.partitionId && msg.mode) {
          const ok = await onArm(Number(msg.partitionId), msg.mode);
          const message = ok ? '' : (panelState.online ? 'Operacion rechazada' : 'Panel offline');
          ws.send(JSON.stringify({ type: 'ack', action: 'arm', ok, partitionId: Number(msg.partitionId), message }));
        } else if (msg.type === 'bypass' && msg.zoneId && onBypass) {
          const ok = await onBypass(Number(msg.zoneId));
          const message = ok ? '' : (panelState.online ? 'Operacion rechazada' : 'Panel offline');
          ws.send(JSON.stringify({ type: 'ack', action: 'bypass', ok, zoneId: Number(msg.zoneId), message }));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ok: false, message: (e as Error).message || 'Error' }));
      }
    });
  });

  // Rutas HTML
  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.get('/config', requireAuthHtml, (_req, res) => res.sendFile(path.join(publicDir, 'config.html')));
  app.get('/', requireAuthHtml, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('*', requireAuthHtml, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  httpServer.listen(web.http_port, () => {
    console.log(`[WEB] HTTP/WS listening on ${web.http_port}${web.ws_path}`);
  });

  // Modbus TCP (jsmodbus ModbusTCPServer expects net.Server como primer argumento)
  if (modbus.enable) {
    const totalRegs = PARTITION_REGS + ZONE_REGS;
    const holding = Buffer.alloc(totalRegs * BYTES_PER_REG);
    const discrete = Buffer.alloc(Math.ceil((PARTITION_REGS + ZONE_REGS) / 8));

    const bitSet = (buf: Buffer, index: number, value: boolean) => {
      const byte = Math.floor(index / 8);
      const bit = index % 8;
      const cur = buf.readUInt8(byte);
      const next = value ? cur | (1 << bit) : cur & ~(1 << bit);
      buf.writeUInt8(next, byte);
    };

    const writePartition = (p: PartitionState) => {
      if (p.id >= 1 && p.id <= PARTITION_REGS) {
        holding.writeUInt16BE(encodePartitionHolding(p.status, p.ready), (p.id - 1) * BYTES_PER_REG);
        const alarm = p.status === 'triggered';
        bitSet(discrete, p.id - 1, alarm);
      }
    };
    const writeZone = (z: ZoneState) => {
      if (z.id >= 1 && z.id <= ZONE_REGS) {
        const regIdx = PARTITION_REGS + z.id - 1;
        holding.writeUInt16BE(encodeZoneHolding(z.open, z.bypass), regIdx * BYTES_PER_REG);
        bitSet(discrete, regIdx, z.open);
      }
    };

    state.partitions.forEach((p) => writePartition(p));
    state.zones.forEach((z) => writeZone(z));

    const modbusNetServer = net.createServer();
    const modbusServer = new (Modbus as any).ModbusTCPServer(modbusNetServer, { holding, discrete });
    modbusServer.on('connection', () => console.log('[MODBUS] client connected'));

    const handleWriteRegisters = async (startAddress: number, values: number[]) => {
      for (let i = 0; i < values.length; i++) {
        const regIndex = startAddress + i; // base 0
        const val = values[i];
        if (regIndex < PARTITION_REGS) {
          const partitionId = regIndex + 1;
          // Solo permitimos 0=disarm, 1=arm away (full). Ignoramos 2 (home) para este proyecto.
          if (val === 0 || val === 1) {
            const mode: 'disarm' | 'home' | 'away' = val === 0 ? 'disarm' : 'away';
            const ok = await onArm(partitionId, mode);
            const current = state.partitions.get(partitionId);
            if (!ok && current) writePartition(current);
          }
        } else if (regIndex < PARTITION_REGS + ZONE_REGS) {
          const zoneId = regIndex - PARTITION_REGS + 1;
          if (val === 0 || val === 2) {
            const desiredBypass = val === 2;
            const current = state.zones.get(zoneId)?.bypass ?? false;
            if (desiredBypass !== current && onBypass) {
              const ok = await onBypass(zoneId);
              const zone = state.zones.get(zoneId);
              if (!ok && zone) writeZone(zone);
            }
          }
        }
      }
    };

    modbusServer.on('postWriteSingleRegister', async (req: any) => {
      const value = req.body.value;
      await handleWriteRegisters(req.body.address, [value]);
    });
    modbusServer.on('postWriteMultipleRegisters', async (req: any) => {
      const vals: number[] = [];
      for (let i = 0; i < req.body.values.length; i += 2) {
        vals.push(req.body.values.readUInt16BE(i));
      }
      await handleWriteRegisters(req.body.address, vals);
    });

    modbusNetServer.listen(modbus.port, modbus.host, () => {
      console.log(`[MODBUS] TCP listening on ${modbus.host}:${modbus.port}`);
    });

    return {
      broadcast,
      updatePartition: (p: PartitionState) => {
        state.partitions.set(p.id, p);
        writePartition(p);
        broadcast({ type: 'partition', data: p });
      },
      updateZone: (z: ZoneState) => {
        state.zones.set(z.id, z);
        writeZone(z);
        broadcast({ type: 'zone', data: z });
      },
      updatePanelStatus: (online: boolean) => {
        panelState.online = online;
        broadcast({ type: 'panel', online });
      },
      stop: () => {
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        httpServer.close();
        modbusNetServer.close();
      },
    };
  }

  // Sin Modbus
  return {
    broadcast,
    updatePartition: (p: PartitionState) => {
      state.partitions.set(p.id, p);
      broadcast({ type: 'partition', data: p });
    },
    updateZone: (z: ZoneState) => {
      state.zones.set(z.id, z);
      broadcast({ type: 'zone', data: z });
    },
    updatePanelStatus: (online: boolean) => {
      panelState.online = online;
      broadcast({ type: 'panel', online });
    },
    stop: () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      httpServer.close();
    },
  };
}

// codifica estado de particion en holding register
function encodePartition(status: string): number {
  switch (status) {
    case 'armed_away': return 2;
    case 'armed_home': return 1;
    case 'triggered': return 3;
    case 'disarmed':
    default: return 0;
  }
}

// Holding register: 0=desarmada, 1=armada (home/away), 2=alarmada/triggered, 3=Ready (desarmada), 4=NotReady (desarmada)
function encodePartitionHolding(status: string, ready?: boolean): number {
  if (status === 'triggered') return 2;
  if (ready === true) return 3;
  if (ready === false) return 4;
  if (status === 'armed_home' || status === 'armed_away') return 1;
  return 0;
}

// Holding zone: 0=cerrada/normal, 1=abierta/alarmada, 2=bypass
function encodeZoneHolding(open: boolean, bypass: boolean): number {
  if (bypass) return 2;
  return open ? 1 : 0;
}

# Risco Gateway (Web + Modbus TCP)
By Jaime Acosta. Github: jatsoca

Gateway para paneles RISCO LightSYS/LightSYS Plus y ProSYS Plus. Expone:
- Dashboard web (estado en tiempo real, armado/desarmado, bypass).
- Modbus TCP (puerto 502) para integración con BMS/SCADA.
- UI de login + página de configuración + restablecer a fábrica.
- Opción de cambio de IP del Raspberry desde la UI (requiere script en el host).

Repositorio: `https://github.com/jatsoca/risco_stack_RPi.git`

## Estructura
- `docker-compose.yml`
- `risco/`
  - `config.default.json` (plantilla)
  - `config.json` (ejemplo)
  - `data/` (persistencia: `config.json`, `users.json`, logs, etc.)
  - `Dockerfile.risco`
  - `app/` (web + modbus)
  - `risco-lan-bridge/` (librería local: comunicación con panel RISCO)
  - `scripts/` (scripts del host, ej. cambio IP)

## Ejecutar con Docker (PC o Raspberry)
```bash
docker compose down
docker compose build --no-cache risco
docker compose up -d
```
- Web: `http://localhost:8080`
- Modbus TCP: puerto `502`

## Raspberry Pi sin Docker (recomendado)
### 1) Instalar dependencias y compilar
```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y git nodejs npm

git clone https://github.com/jatsoca/risco_stack_RPi.git

cd risco_stack_RPi/risco/risco-lan-bridge
npm install --include=dev
npm run build

cd ../app
npm install --include=dev
npm run build
```

### 2) Primer arranque (manual)
El servicio lee el config desde `~/risco_stack_RPi/risco/app/config.json` (o la ruta definida en `RISCO_MQTT_HA_CONFIG_FILE`).
Si no existe, copia los defaults desde `risco/config.default.json`.

Nota: cuando actualizas el repo con `git pull`, el `config.json` existente NO se sobrescribe (se mantiene tu configuración).

En Raspberry, el puerto `502` requiere permisos de root (puerto <1024):
```bash
cd ~/risco_stack_RPi/risco/app
sudo node dist/main.js
```

### 3) Servicio de arranque automático (systemd)
Crear el unit file (como root):
```bash
sudo tee /etc/systemd/system/risco-gateway.service >/dev/null <<'EOF'
[Unit]
Description=Risco Gateway (Web + Modbus)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/risco_stack_RPi/risco/app
ExecStart=/usr/bin/node /home/pi/risco_stack_RPi/risco/app/dist/main.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Activar y arrancar:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now risco-gateway.service
```

Ver estado y logs:
```bash
sudo systemctl status risco-gateway.service
sudo journalctl -u risco-gateway.service -f
```

Alternativa (sin root): puedes dar capacidad al binario `node` para bindear puerto 502:
```bash
sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node
```
y en el `service` usar `User=pi`. (Si usas esta alternativa, el cambio de IP desde la UI deberá ejecutarse con `sudoers`.)

## UI: credenciales y configuración
- Login web por defecto: usuario `admin`, contraseña `Admin123` (se guarda hash en `/data/users.json`).
- Página de configuración: `http://IP:8080/config`
- Botones: Guardar, Guardar y reiniciar, Reiniciar servicio, Restablecer a fábrica, Cambiar contraseña admin.

## Cambio de IP del Raspberry desde la UI (NetworkManager / nmcli)
Cuando cambias la IP desde la página `/config`, la conexión se corta y debes reconectar a la nueva IP.

### Instalar el script del host
Este proyecto trae el script en `risco/scripts/set-ip-rpi.sh`. Instálalo en el host así:
```bash
sudo install -m 0755 /home/pi/risco_stack_RPi/risco/scripts/set-ip-rpi.sh /usr/local/bin/set-ip-rpi.sh
```

Opcional: si NO ejecutas el gateway como root, permite ejecutar el script sin contraseña:
- Crear `/etc/sudoers.d/risco-ip` con:
  ```
  pi ALL=(root) NOPASSWD:/usr/local/bin/set-ip-rpi.sh
  ```

Opcional: si quieres forzar un perfil específico de NetworkManager (por ejemplo `Cableada1`), exporta `RISCO_NET_CON=Cableada1` en el entorno del servicio.

### Script completo (`/usr/local/bin/set-ip-rpi.sh`)
```bash
#!/bin/sh
set -eu

IP="${1:-}"
CIDR="${2:-}"
GW="${3:-}"

DEVICE="${RISCO_NET_DEVICE:-eth0}"
CONNECTION="${RISCO_NET_CON:-}"

if [ -z "$IP" ] || [ -z "$CIDR" ] || [ -z "$GW" ]; then
  echo "missing args: IP CIDR GW" >&2
  exit 1
fi

is_ip() {
  echo "$1" | awk -F. 'NF==4 && $1>=0 && $1<=255 && $2>=0 && $2<=255 && $3>=0 && $3<=255 && $4>=0 && $4<=255 {exit 0} {exit 1}'
}

is_cidr() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$1" -ge 0 ] && [ "$1" -le 32 ] ;;
  esac
}

if ! is_ip "$IP" || ! is_ip "$GW" || ! is_cidr "$CIDR"; then
  echo "invalid args" >&2
  exit 1
fi

# Prefer NetworkManager if present (Bookworm Pi OS often uses it).
if command -v nmcli >/dev/null 2>&1; then
  if [ -z "$CONNECTION" ]; then
    CONNECTION="$(nmcli -t -f NAME,DEVICE con show --active | awk -F: -v dev="$DEVICE" '$2==dev {print $1; exit}')"
  fi
  if [ -z "$CONNECTION" ]; then
    CONNECTION="$(nmcli -t -f NAME,DEVICE con show | awk -F: -v dev="$DEVICE" '$2==dev {print $1; exit}')"
  fi
  if [ -z "$CONNECTION" ]; then
    echo "no NetworkManager connection found for device: $DEVICE" >&2
    exit 2
  fi

  nmcli con mod "$CONNECTION" ipv4.method manual
  nmcli con mod "$CONNECTION" ipv4.addresses "$IP/$CIDR"
  nmcli con mod "$CONNECTION" ipv4.gateway "$GW"
  nmcli con mod "$CONNECTION" ipv4.dns "$GW 1.1.1.1 8.8.8.8"
  nmcli con mod "$CONNECTION" ipv4.ignore-auto-dns yes

  nmcli con down "$CONNECTION" || true
  nmcli con up "$CONNECTION"

  echo "OK: $CONNECTION -> $IP/$CIDR gw $GW"
  exit 0
fi

# Fallback: dhcpcd (older Raspberry Pi OS images).
CONF=/etc/dhcpcd.conf
cat <<EOF > "$CONF"
interface $DEVICE
static ip_address=${IP}/${CIDR}
static routers=${GW}
static domain_name_servers=${GW}
EOF

systemctl restart dhcpcd 2>/dev/null || service dhcpcd restart 2>/dev/null || true
echo "OK: dhcpcd -> $IP/$CIDR gw $GW"
```

## Modbus (resumen)
- Holding particiones regs 1-32 (uint16): `0=disarmed, 1=armed(home/away), 2=triggered, 3=Ready, 4=NotReady`.
- Holding zonas regs 33-544 (uint16): `0=cerrada, 1=abierta, 2=bypass`.
- Discrete inputs: bits 0-31 particiones alarmadas; bits 32-543 zonas abiertas.
- Escritura: partición reg=0/1 desarma/arma; zona reg=2 aplica bypass (0 quita).

## Evitar suspensión/reposo en Raspberry Pi
Raspberry Pi OS normalmente no entra en “sleep” como un PC, pero para máxima estabilidad:
- Desactivar blanking de pantalla (si aplica): `sudo raspi-config` (Interface Options).
- Evitar powersave de Wi‑Fi (si usas Wi‑Fi):
  - Crear `/etc/NetworkManager/conf.d/default-wifi-powersave-on.conf`:
    ```
    [connection]
    wifi.powersave = 2
    ```
  - Reiniciar: `sudo systemctl restart NetworkManager` (o reboot).

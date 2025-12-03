# Risco Gateway (Web + Modbus)
By Jaime Acosta (@jatsoca)

Gateway probado con paneles RISCO LightSYS/LightSYS Plus y ProSYS Plus. Expone:
- Dashboard web con armado/desarmado, bypass y estado en tiempo real.
- Modbus TCP con holdings/discrete ya mapeados.
- Autenticación web (admin/Admin123) y página de configuración.
- Opción de cambiar la IP del Raspberry vía la página de configuración (requiere script en el host).

## Estructura
- `docker-compose.yml` (solo servicio del gateway).
- `risco/`
  - `config.default.json` (plantilla; se copia a `/data/config.json` al primer arranque).
  - `Dockerfile.risco` (build multi-stage).
  - `app/` (TS, Web, Modbus) + UI de login/config.
  - `risco-lan-bridge/` (librería local incluida en la build).

## Puesta en marcha rápida (PC o Pi, con Docker)
```bash
docker compose down
docker compose build --no-cache risco
docker compose up -d
```
- Dashboard: http://localhost:8080  
- Modbus TCP: puerto 502

## Raspberry Pi sin Docker (recomendado)
1) Preparar la Pi  
```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y nodejs npm git dhcpcd5
git clone https://github.com/jatsoca/risco_stack_RPi.git
cd risco_stack_RPi/risco/risco-lan-bridge
npm install --include=dev
npm run build
cd ../app
npm install --include=dev
npm run build
```
2) Servicio systemd (con sudo/root para usar puerto 502)  
`/etc/systemd/system/risco-gateway.service`
```ini
[Unit]
Description=Risco Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Ejecutar como root para usar puerto 502
User=root
WorkingDirectory=/home/pi/risco_stack_RPi/risco/app
ExecStart=/usr/bin/node /home/pi/risco_stack_RPi/risco/app/dist/main.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now risco-gateway
```
- Si prefieres no usar root, puedes dar capacidad al binario node:  
  `sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node`  
  y en el servicio usar `User=pi`.

3) Cambio de IP del host desde la UI (opcional)
- Crear script `/usr/local/bin/set-ip-rpi.sh` que escriba `/etc/dhcpcd.conf` y reinicie `dhcpcd`.
- Dar sudo sin contraseña al usuario del servicio (root no lo necesita):
  `/etc/sudoers.d/risco-ip` con  
  `pi ALL=(root) NOPASSWD:/usr/local/bin/set-ip-rpi.sh`
- En la página `/config`, usar el bloque “IP del Gateway” (IP/CIDR/Gateway). Si el script no existe, mostrará “no soportado”.
- Script de ejemplo (`/usr/local/bin/set-ip-rpi.sh`):
```bash
#!/bin/sh
IP="$1"
CIDR="$2"
GW="$3"
CONF=/etc/dhcpcd.conf
if [ -z "$IP" ] || [ -z "$CIDR" ] || [ -z "$GW" ]; then
  echo "missing args"
  exit 1
fi
cat <<EOF > "$CONF"
interface eth0
static ip_address=${IP}/${CIDR}
static routers=${GW}
static domain_name_servers=${GW}
EOF
systemctl restart dhcpcd
```
Dar permisos: `sudo chmod +x /usr/local/bin/set-ip-rpi.sh`

## Configuración y credenciales
- Runtime lee `/data/config.json` (montado desde `./risco/data`). Si falta, se copia `config.default.json`.
- Login web: `admin` / `Admin123` (hash en `/data/users.json`).
- UI de configuración en `/config`: IP/puerto panel, puertos Web/Modbus, nivel de log, heartbeat, cambio de IP del host (opcional).
- Botones: Guardar, Guardar y reiniciar, Reiniciar servicio, Restablecer a fábrica, Cambiar contraseña admin.

## Modbus (resumen)
- Holding particiones regs 1-32 (uint16): `0=disarmed, 1=armed(home/away), 2=triggered, 3=Ready, 4=NotReady`.
- Holding zonas regs 33-544 (uint16): `0=cerrada, 1=abierta, 2=bypass`.
- Discrete inputs: bits 0-31 particiones alarmadas; bits 32-543 zonas abiertas.
- Escritura: partición reg=0/1 desarma/arma; zona reg=2 aplica bypass (0 quita).

## Logs
- `log`: `error|warn|info|verbose|debug`.
- `logColorize`: true/false.
- `heartbeat_interval_ms`: latido opcional para monitoreo externo.

## Evitar suspensión/reposo en Raspberry Pi
- Desactivar ahorro de energía de pantalla/DPMS (si aplica):
  ```bash
  sudo raspi-config  # Interface Options -> Deshabilitar screen blanking
  ```
  o en cli:  
  `sudo sed -i 's/^BLANK_TIME=.*/BLANK_TIME=0/' /etc/kbd/config`  
  `sudo systemctl restart console-setup.service`
- Evitar sleep del wifi (opcional): añadir a `/etc/NetworkManager/conf.d/default-wifi-powersave-on.conf`  
  ```
  [connection]
  wifi.powersave = 2
  ```
  y reiniciar NetworkManager o reboot.
- Asegurar servicio siempre activo: `Restart=on-failure` (ya en systemd) y sin cron de apagado.

## Migrar a otro equipo
- Copia el repo y el contenido de `risco/data` (ahora en `risco_stack_RPi`), luego levanta con Docker o Node como arriba.
- Para empaquetar Docker multi-arch:
```bash
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  -f risco/Dockerfile.risco \
  -t tuuser/risco-gateway:latest \
  risco
```

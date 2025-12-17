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


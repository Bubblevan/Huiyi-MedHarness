#!/usr/bin/env sh
set -eu

IFACE="${1:-wg0}"
PEER_IP="${2:-10.77.0.2}"

command -v wg >/dev/null 2>&1 || { echo "wg command not installed" >&2; exit 2; }
command -v ip >/dev/null 2>&1 || { echo "ip command not installed" >&2; exit 2; }
wg show "$IFACE" >/dev/null || { echo "WireGuard interface $IFACE is not up" >&2; exit 1; }
ip route get "$PEER_IP" | grep -q "dev $IFACE" || { echo "No route to $PEER_IP through $IFACE" >&2; exit 1; }
wg show "$IFACE" latest-handshakes | awk -v peer="$PEER_IP" 'NR==1 {next} {if ($2 > latest) latest=$2} END {if (latest == 0) exit 1}' || {
  echo "No recent WireGuard peer handshake; inspect `wg show $IFACE`" >&2
  exit 1
}
echo "WireGuard route and peer handshake are present."

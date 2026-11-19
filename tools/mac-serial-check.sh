#!/bin/sh
# Diagnose a serial line on macOS/Linux without the DSH plugin.
#
#   ./mac-serial-check.sh [/dev/cu.usbserial-110] [115200] [8N1]
#
# Prints the driver state before and after applying the same termios the
# plugin applies, then dumps 200 raw bytes so "garbage" can be told apart from
# a plugin-side problem.

set -u

DEV=${1:-}
BAUD=${2:-115200}
FRAME=${3:-8N1}

if [ -z "$DEV" ]; then
  echo "usage: $0 /dev/cu.usbserial-110 [baud] [8N1]" >&2
  echo "" >&2
  echo "available ports:" >&2
  ls -1 /dev/cu.* /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/* 2>/dev/null || true
  exit 2
fi

[ -c "$DEV" ] || { echo "not a character device: $DEV" >&2; exit 2; }

# stty spelling differs: BSD (macOS) uses -f, GNU (Linux) uses -F.
case "$(uname -s)" in
  Darwin) STTY_F=-f ;;
  *)      STTY_F=-F ;;
esac

BITS=$(printf '%s' "$FRAME" | cut -c1)
PARITY=$(printf '%s' "$FRAME" | cut -c2)
STOP=$(printf '%s' "$FRAME" | cut -c3)

case "$PARITY" in
  N|n) PAR_TOKENS='-parenb' ;;
  E|e) PAR_TOKENS='parenb -parodd' ;;
  O|o) PAR_TOKENS='parenb parodd' ;;
  *)   echo "unsupported parity in $FRAME" >&2; exit 2 ;;
esac

case "$STOP" in
  1) STOP_TOKENS='-cstopb' ;;
  2) STOP_TOKENS='cstopb' ;;
  *) echo "unsupported stop bits in $FRAME" >&2; exit 2 ;;
esac

echo "== device: $DEV   target: $BAUD $FRAME =="
echo ""
echo "-- before --"
stty "$STTY_F" "$DEV" -a 2>&1 || echo "(stty could not read the device)"

echo ""
echo "-- applying the plugin's line settings --"
# shellcheck disable=SC2086
stty "$STTY_F" "$DEV" "$BAUD" ispeed "$BAUD" ospeed "$BAUD" raw \
  -ignbrk -brkint -parmrk -echo -echoe -echok -echonl -iexten \
  -ixon -ixoff -istrip -inlcr -igncr -icrnl -opost -isig -icanon \
  -crtscts clocal hupcl "cs$BITS" $PAR_TOKENS $STOP_TOKENS min 1 time 0
echo "stty exit: $?"

echo ""
echo "-- after --"
stty "$STTY_F" "$DEV" -a 2>&1 || echo "(stty could not read the device)"

echo ""
echo "-- 200 raw bytes (xxd) --"
# Read for at most 3 seconds; head quits early once it has 200 bytes.
if command -v xxd >/dev/null 2>&1; then
  ( dd if="$DEV" bs=1 count=200 2>/dev/null & DD=$!
    sleep 3
    kill "$DD" 2>/dev/null ) | xxd
else
  ( dd if="$DEV" bs=1 count=200 2>/dev/null & DD=$!
    sleep 3
    kill "$DD" 2>/dev/null ) | od -An -tx1 -c
fi

echo ""
echo "-- cross-check with pyserial, if present --"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$DEV" "$BAUD" "$BITS" "$PARITY" "$STOP" <<'PY' 2>&1 || echo "(pyserial not available)"
import sys
try:
    import serial
except Exception:
    sys.exit(1)
dev, baud, bits, parity, stop = sys.argv[1:6]
parity_map = {'N': serial.PARITY_NONE, 'E': serial.PARITY_EVEN, 'O': serial.PARITY_ODD}
stop_map = {'1': serial.STOPBITS_ONE, '2': serial.STOPBITS_TWO}
s = serial.Serial(dev, int(baud), bytesize=int(bits),
                  parity=parity_map[parity.upper()],
                  stopbits=stop_map[stop], timeout=2)
print('pyserial settings:', s.get_settings())
print('pyserial bytes  :', s.read(100))
s.close()
PY
fi

echo ""
echo "How to read this:"
echo "  * 'after' must show speed=$BAUD, cs$BITS, and the parity/stop flags above."
echo "  * If the xxd dump is still garbage here, the problem is below the plugin"
echo "    (device rate, cable, adapter firmware, another program holding the port)."
echo "  * If the dump is clean text but the plugin shows garbage, send the plugin's"
echo "    'line: ...' log line and this script's 'before'/'after' output."

"""Dialog 06 (Checkout-Dialog 06 PC) scale driver for Mettler-Toledo checkout scales.

Protocol spec:
- Serial: 9600, 7 data bits, even parity, 1 stop bit (7E1)
- Full Dialog 06 command set: CMD_03, CMD_08, CMD_10
- Checksum handshake via CMD_10
- On-demand auto-terminating weighing: CMD_03 init → ENQ polling → auto-stop on removal
"""

import logging
import time
from enum import Enum

import serial

from hivelab_iot_nano.drivers.serial_base_driver import (
    SerialProtocol,
    serial_connection,
)
from hivelab_iot_nano.event import device_changed
from hivelab_iot_nano.drivers.serial_scale_driver import ScaleDriver

_logger = logging.getLogger(__name__)

Dialog06Protocol = SerialProtocol(
    name='Dialog 06',
    baudrate=9600,
    bytesize=serial.SEVENBITS,
    stopbits=serial.STOPBITS_ONE,
    parity=serial.PARITY_EVEN,
    timeout=1,
    writeTimeout=1,
    measureRegexp=None,
    statusRegexp=None,
    commandDelay=0.2,
    measureDelay=0.2,
    newMeasureDelay=0.2,
    commandTerminator=b'',
    measureCommand=None,
    emptyAnswerValid=False,
)

# --- Control characters ---
EOT = 0x04
STX = 0x02
ETX = 0x03
ESC = 0x1B
ENQ_BYTE = 0x05
ACK = 0x06
NAK = 0x15

# Dialog 06 response delimiters
_DELIMITERS = {ETX, ACK, NAK}

# Scale unit codes (Record 02)
SCALE_UNITS = {
    0x30: 'lb:oz',
    0x31: 'lb/0.01',
    0x32: 'lb/0.005',
    0x33: 'kg',
}

# Status codes (Record 09)
STATUS_CODES = {
    '00': 'no error',
    '01': 'general error',
    '02': 'parity error or buffer overflow',
    '10': 'invalid record number',
    '11': 'invalid unit price',
    '12': 'invalid tare value',
    '13': 'invalid article text',
    '20': 'scale in motion (unstable)',
    '21': 'no weight change since last weighing',
    '22': 'no valid article data available',
    '30': 'weight < 1d (net weight <= 0)',
    '31': 'under-load',
    '32': 'overloaded',
    '33': 'overflow of selling price',
    '34': 'invalid weight',
}

# Checksum constants
CS_LEFT = 0x4711
CS_RIGHT = 0xF336


class WeighState(Enum):
    IDLE = 'idle'           # No polling, waiting for weigh action
    INIT = 'init'           # Send CMD_03(tare) on next cycle
    WAITING = 'waiting'     # ENQ polling, no object yet (status 30 = normal)
    WEIGHING = 'weighing'   # Object detected (weight > 0), monitoring
    STOPPING = 'stopping'   # Status 30 after weighing → CMD_03(tare=0) → IDLE


class Dialog06Driver(ScaleDriver):
    """Driver for Dialog 06 protocol scales (Mettler-Toledo Ariva).

    On-demand auto-terminating weighing:
    - weigh action → INIT → CMD_03(tare) → WAITING (ENQ poll)
    - Object placed (weight > 0) → WEIGHING (ENQ poll, notify POS)
    - Object removed (status 30 after weighing) → STOPPING → CMD_03(tare=0) → IDLE
    """

    _protocol = Dialog06Protocol
    priority = 2

    def __init__(self, identifier, device):
        super().__init__(identifier, device)
        self.device_manufacturer = 'Mettler-Toledo'
        self._tare_value = 0
        self._weigh_state = WeighState.IDLE

    def _set_actions(self):
        super()._set_actions()
        self._actions.update({
            'weigh': self._weigh_action,
            'tare_set': self._tare_set_action,
            'stop': self._stop_action,
        })
        # Dialog06 uses on-demand weigh action, not start/stop_reading
        self._actions.pop('start_reading', None)
        self._actions.pop('stop_reading', None)

    # === Low-level I/O (override points for 8N1 subclass) ===

    def _send_cmd(self, cmd):
        """Write raw command bytes to the serial connection."""
        self._connection.write(cmd)

    def _read_response(self, timeout_s=2.0):
        """Read bytes until a delimiter (ETX/ACK/NAK)."""
        buf = []
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            raw = self._connection.read(1)
            if not raw:
                continue
            b = raw[0]
            buf.append(b)
            if b in _DELIMITERS:
                break
        return buf

    # === Helpers ===

    @staticmethod
    def _format_value(value, length):
        """Zero-padded ASCII representation of an integer."""
        s = str(value).zfill(length)
        if len(s) > length:
            s = s[-length:]
        return s.encode('ascii')

    @staticmethod
    def _rotl(v, bits):
        """Rotate left 16-bit value."""
        v &= 0xFFFF
        bits &= 0xF
        return ((v << bits) | (v >> (16 - bits))) & 0xFFFF

    @staticmethod
    def _rotr(v, bits):
        """Rotate right 16-bit value."""
        v &= 0xFFFF
        bits &= 0xF
        return ((v >> bits) | (v << (16 - bits))) & 0xFFFF

    # === Protocol commands ===

    def _cmd_03(self, price=0, tare=0):
        """CMD_03: transmit unit price and preset tare."""
        self._connection.reset_input_buffer()
        self._connection.reset_output_buffer()
        frame = (bytes([EOT, EOT, STX]) + b'03' + bytes([ESC])
                 + self._format_value(price, 6) + bytes([ESC])
                 + self._format_value(tare, 4) + bytes([ETX]))
        self._send_cmd(frame)
        return self._read_response(timeout_s=2.0)

    def _cmd_08(self):
        """CMD_08: request status information."""
        self._connection.reset_input_buffer()
        self._connection.reset_output_buffer()
        frame = bytes([EOT, EOT, STX]) + b'08' + bytes([ETX])
        self._send_cmd(frame)
        return self._read_response(timeout_s=2.0)

    def _cmd_10(self, cs_kw_pairs):
        """CMD_10: transmit checksum CS/KW pairs."""
        self._connection.reset_input_buffer()
        self._connection.reset_output_buffer()
        payload = b''
        for cs_str, kw_str in cs_kw_pairs:
            payload += cs_str.encode('ascii') + kw_str.encode('ascii')
        frame = (bytes([EOT, EOT, STX]) + b'10' + bytes([ESC])
                 + payload + bytes([ETX]))
        self._send_cmd(frame)
        return self._read_response(timeout_s=2.0)

    def _cmd_20(self, on=True):
        """CMD_20: logic version number ON/OFF."""
        self._connection.reset_input_buffer()
        self._connection.reset_output_buffer()
        d0 = 0x31 if on else 0x30
        frame = bytes([EOT, EOT, STX]) + b'20' + bytes([ESC, d0, ETX])
        self._send_cmd(frame)
        return self._read_response(timeout_s=2.0)

    def _enq(self):
        """ENQ: request weight result."""
        frame = bytes([EOT, EOT, ENQ_BYTE])
        self._send_cmd(frame)
        return self._read_response(timeout_s=2.0)

    # === Parsers ===

    def _parse_record_02(self, frame):
        """Parse Record 02 (valid weight result).

        Returns {'weight': kg_float, 'unit': str} or None.
        """
        if len(frame) < 20:
            return None
        if not (frame[0] == STX and frame[1] == 0x30 and frame[2] == 0x32
                and frame[3] == ESC and frame[5] == ESC
                and frame[11] == ESC and frame[18] == ESC
                and frame[-1] == ETX):
            return None
        unit_byte = frame[4]
        unit = SCALE_UNITS.get(unit_byte, f'unknown(0x{unit_byte:02X})')
        weight_str = ''.join(chr(b) for b in frame[6:11])
        try:
            weight = int(weight_str)
            return {'weight': weight / 1000.0, 'unit': unit}
        except ValueError:
            _logger.debug("Record 02 weight parse error, frame=%s", frame)
            return None

    def _parse_record_09(self, frame):
        """Parse Record 09 (status information).

        Returns {'code': str, 'description': str} or None.
        """
        if len(frame) < 6:
            return None
        if not (frame[0] == STX and frame[1] == 0x30 and frame[2] == 0x39
                and frame[3] == ESC and frame[-1] == ETX):
            return None
        code = chr(frame[4]) + chr(frame[5])
        desc = STATUS_CODES.get(code, 'unknown status')
        _logger.debug("Record 09 status: %s (%s)", code, desc)
        return {'code': code, 'description': desc}

    def _parse_record_11(self, frame):
        """Parse Record 11 (checksum challenge/result).

        Returns dict or None.
        """
        if len(frame) < 6:
            return None
        if not (frame[0] == STX and frame[1] == 0x31 and frame[2] == 0x31
                and frame[3] == ESC and frame[-1] == ETX):
            return None
        d0 = frame[4]
        if d0 == 0x30:
            return {'type': 'failed'}
        elif d0 == 0x31:
            return {'type': 'ok'}
        elif d0 == 0x32:
            rand_str = ''.join(chr(b) for b in frame[5:-1])
            rand_val = int(rand_str, 16)
            z1 = (rand_val >> 4) & 0x0F
            z2 = rand_val & 0x0F
            _logger.debug("Record 11 CS/KW challenge: Z1=%d, Z2=%d", z1, z2)
            return {'type': 'challenge', 'z1': z1, 'z2': z2}
        return None

    def _classify_response(self, frame):
        """Auto-detect response type. Returns (type_str, parsed_data_or_None)."""
        if not frame:
            return ('timeout', None)
        if len(frame) == 1 and frame[0] == ACK:
            return ('ack', None)
        if len(frame) == 1 and frame[0] == NAK:
            return ('nak', None)
        if len(frame) >= 3 and frame[0] == STX:
            rec_id = chr(frame[1]) + chr(frame[2])
            if rec_id == '02':
                return ('record_02', self._parse_record_02(frame))
            elif rec_id == '09':
                return ('record_09', self._parse_record_09(frame))
            elif rec_id == '11':
                return ('record_11', self._parse_record_11(frame))
        return ('unknown', None)

    # === High-level sequences ===

    def _do_checksum_handshake(self, z1, z2):
        """Perform Dialog 06 checksum handshake (CMD_10 + ENQ confirmation)."""
        cs_enc = format(self._rotl(CS_LEFT, z1) & 0xFFFF, 'X')
        kw_enc = format(self._rotr(CS_RIGHT, z2) & 0xFFFF, 'X')
        _logger.debug("Checksum handshake: Z1=%d, Z2=%d, CS=%s, KW=%s",
                       z1, z2, cs_enc, kw_enc)

        resp = self._cmd_10([(cs_enc, kw_enc)])
        rtype, _ = self._classify_response(resp)
        if rtype != 'ack':
            _logger.debug("Checksum CMD_10: %s (expected ACK)", rtype)
            return False

        resp2 = self._enq()
        rtype2, data2 = self._classify_response(resp2)
        if rtype2 == 'record_11' and data2:
            if data2['type'] == 'ok':
                _logger.debug("Checksum PASSED")
                return True
            if data2['type'] == 'failed':
                _logger.debug("Checksum FAILED")
                return False
        _logger.debug("Checksum: unexpected confirmation response: %s", rtype2)
        return False

    def _get_status(self):
        """CMD_08 → parse Record 09.

        Returns {'code': str, 'description': str} or None.
        """
        resp = self._cmd_08()
        rtype, data = self._classify_response(resp)
        if rtype == 'record_09' and data:
            return data
        _logger.debug("_get_status: unexpected response: %s", rtype)
        return None

    # === State machine (on-demand, auto-terminating) ===

    def _take_measure(self):
        state = self._weigh_state
        if state == WeighState.IDLE:
            return

        with self._device_lock:
            # Re-read under lock — state may have changed between the
            # unlocked check above and lock acquisition (e.g. weigh/tare_set
            # action running concurrently in the action thread).
            state = self._weigh_state
            if state == WeighState.IDLE:
                return

            if state == WeighState.INIT:
                _logger.debug("[D06] _take_measure INIT → _start_weighing (tare=%d)",
                              self._tare_value)
                if self._start_weighing():
                    self._weigh_state = WeighState.WAITING
                self._notify_if_changed()
                return

            if state in (WeighState.WAITING, WeighState.WEIGHING):
                self._poll_weight()
                self._notify_if_changed()
                return

            if state == WeighState.STOPPING:
                _logger.debug("[D06] STOPPING → CMD_03(tare=0)")
                self._cmd_03(tare=0)
                self._tare_value = 0
                self._weigh_state = WeighState.IDLE
                self.data = {'result': 0, 'weight': 0, 'status': self._status}
                self._notify_if_changed()

    def _start_weighing(self):
        """CMD_03(tare) → ACK. Returns True if weighing session started."""
        resp = self._cmd_03(tare=self._tare_value)
        rtype, data = self._classify_response(resp)
        _logger.debug("[D06] _start_weighing CMD_03(tare=%d) → %s",
                      self._tare_value, rtype)

        # Checksum challenge
        if rtype == 'record_11' and data and data['type'] == 'challenge':
            self._do_checksum_handshake(data['z1'], data['z2'])
            resp = self._cmd_03(tare=self._tare_value)
            rtype, data = self._classify_response(resp)

        if rtype == 'ack':
            _logger.debug("[D06] _start_weighing OK → WAITING")
            return True

        if rtype == 'nak':
            status = self._get_status()
            _logger.debug("[D06] _start_weighing NAK (status=%s)",
                          status['code'] if status else '?')
        else:
            _logger.debug("[D06] _start_weighing unexpected: %s", rtype)

        self.data = {'result': 0, 'weight': 0, 'status': self._status}
        return False

    def _poll_weight(self):
        """Single ENQ poll. Updates self.data and weigh state."""
        time.sleep(0.35)
        resp = self._enq()
        rtype, data = self._classify_response(resp)

        if rtype == 'record_02' and data:
            weight = float(data['weight'])
            _logger.debug("[D06] _poll_weight Record02 weight=%.3f state=%s",
                          weight, self._weigh_state.value)
            self.data = {
                'result': weight,
                'weight': weight,
                'status': self._status,
            }
            if weight > 0:
                self._weigh_state = WeighState.WEIGHING
            return

        if rtype == 'nak':
            status = self._get_status()
            code = status['code'] if status else '?'
            _logger.debug("[D06] _poll_weight NAK status=%s state=%s",
                          code, self._weigh_state.value)
            if status and status['code'] == '30':
                if self._weigh_state == WeighState.WEIGHING:
                    # Had weight → returned to 0 → auto-stop
                    _logger.debug("[D06] _poll_weight WEIGHING→STOPPING (product removed)")
                    self.data = {'result': 0, 'weight': 0, 'status': self._status}
                    self._weigh_state = WeighState.STOPPING
                # else: WAITING → no object yet → continue polling
                return
            if status and status['code'] in ('22', '21'):
                # No article data / no weight change → re-init CMD_03
                self._weigh_state = WeighState.INIT
                return
            # Status 20 (in motion) or other → retry next cycle
            return

        if rtype == 'record_11' and data and data['type'] == 'challenge':
            self._do_checksum_handshake(data['z1'], data['z2'])
            self._weigh_state = WeighState.INIT  # Re-CMD_03 after checksum
            return

        _logger.debug("[D06] _poll_weight %s → retry next cycle", rtype)

    def _notify_if_changed(self):
        """Emit device_changed if value changed or status is error."""
        current = self.data['result']
        if current != self.last_sent_value or \
                self._status['status'] == self.STATUS_ERROR:
            _logger.debug("[D06] _notify_if_changed EMIT weight=%.3f (was %.3f) state=%s",
                          current, self.last_sent_value, self._weigh_state.value)
            self.last_sent_value = current
            device_changed(self)
        else:
            _logger.debug("[D06] _notify_if_changed SKIP weight=%.3f == last_sent state=%s",
                          current, self._weigh_state.value)

    # === Actions ===

    def action(self, data):
        """Execute action without automatic device_changed.

        The Dialog06 state machine emits notifications via _notify_if_changed()
        only when the weight genuinely changes. The unconditional device_changed()
        in SerialDriver.action() would emit spurious weight=0 events when
        session-control actions (weigh, tare_set) reset self.data.
        """
        _logger.debug("[D06] action=%s state=%s", data.get('action'), self._weigh_state.value)
        self.data['owner'] = data.get('session_id')
        self.data['action_args'] = {**data}
        with self._device_lock:
            if self._connection and self._connection.isOpen():
                self._execute_action(data)
            else:
                with serial_connection(self.device_identifier, self._protocol) as connection:
                    self._connection = connection
                    self._execute_action(data)

    def _weigh_action(self, data):
        """Start an on-demand, auto-terminating weighing session."""
        tare = int(data.get('tare', data.get('weight', 0)))
        _logger.debug("[D06] _weigh_action tare=%d → state=INIT", tare)
        self._tare_value = tare
        self._weigh_state = WeighState.INIT
        self.data = {'result': 0, 'weight': 0, 'status': self._status}
        self.last_sent_value = 0

    def _stop_action(self, data):
        """Stop the current weighing session and return to IDLE."""
        if self._weigh_state == WeighState.IDLE:
            return
        _logger.info("[D06] _stop_action state=%s → CMD_03(tare=0) → IDLE",
                     self._weigh_state.value)
        self._cmd_03(tare=0)
        self._tare_value = 0
        self._weigh_state = WeighState.IDLE
        self.data = {'result': 0, 'weight': 0, 'status': self._status}
        self.last_sent_value = 0
        device_changed(self)

    def _tare_set_action(self, data):
        """Set software tare value. Forces CMD_03 re-init on next cycle."""
        tare_value = int(data.get('weight', 0))
        _logger.debug("[D06] _tare_set_action tare=%d g → state=INIT", tare_value)
        self._tare_value = tare_value
        self._weigh_state = WeighState.INIT
        self.data = {'result': 0, 'weight': 0, 'status': self._status}
        self.last_sent_value = 0
        return 0

    def _read_once_action(self, data):
        """One-shot real reading via CMD_03 + ENQ.

        Do NOT set last_sent_value here. If read_once runs concurrently with
        a weigh session (race at startup), clobbering last_sent_value prevents
        the state machine from detecting the first weight change.
        """
        _logger.debug("[D06] _read_once_action weigh_state=%s", self._weigh_state.value)
        self._read_weight()
        _logger.debug("[D06] _read_once_action result=%.3f", self.data.get('result', 0))

    # === One-shot reading (for read_once action) ===

    def _read_weight(self):
        """One-shot CMD_03 → ENQ reading with retries."""
        resp = self._cmd_03(tare=self._tare_value)
        rtype, rdata = self._classify_response(resp)
        if rtype == 'record_11' and rdata and rdata['type'] == 'challenge':
            self._do_checksum_handshake(rdata['z1'], rdata['z2'])
            resp = self._cmd_03(tare=self._tare_value)
            rtype, rdata = self._classify_response(resp)
        if rtype == 'ack':
            for _ in range(10):
                time.sleep(0.35)
                resp2 = self._enq()
                rtype2, data2 = self._classify_response(resp2)
                if rtype2 == 'record_02' and data2:
                    self.data = {
                        'result': float(data2['weight']),
                        'weight': float(data2['weight']),
                        'status': self._status,
                    }
                    return
                if rtype2 == 'nak':
                    status = self._get_status()
                    if status and status['code'] == '30':
                        break  # net weight <= 0, return 0
                    # status 20 (in motion) → retry
                    continue
                if rtype2 == 'record_11' and data2 and data2['type'] == 'challenge':
                    self._do_checksum_handshake(data2['z1'], data2['z2'])
                    continue
        self.data = {'result': 0, 'weight': 0, 'status': self._status}

    # === Probe ===

    @classmethod
    def supported(cls, device):
        """Probe: CMD_20 ON → check ACK/STX..ETX → CMD_20 OFF."""
        protocol = cls._protocol
        port = device['identifier']
        _logger.info("Dialog06 probe START on %s", port)
        try:
            with serial_connection(port, protocol, is_probing=True) as connection:
                connection.reset_input_buffer()
                connection.reset_output_buffer()
                # CMD_20 ON (double EOT per protocol spec)
                cmd_20_on = bytes([EOT, EOT, STX]) + b'20' + bytes([ESC, 0x31, ETX])
                connection.write(cmd_20_on)
                connection.flush()
                time.sleep(0.5)
                answer = connection.read(100)
                _logger.info("Dialog06 probe READ: %r (%d bytes)",
                             answer, len(answer) if answer else 0)
                found = False
                if answer and (b'\x06' in answer or
                               (b'\x02' in answer and b'\x03' in answer)):
                    _logger.info("Dialog06 probe OK (CMD_20): %r", answer)
                    found = True
                elif answer:
                    _logger.info("Dialog06 probe NO MATCH: %r", answer)
                else:
                    _logger.info("Dialog06 probe: no response (0 bytes)")
                # CMD_20 OFF (cleanup)
                cmd_20_off = bytes([EOT, EOT, STX]) + b'20' + bytes([ESC, 0x30, ETX])
                connection.write(cmd_20_off)
                connection.flush()
                time.sleep(0.5)
                connection.read(100)
                return found
        except serial.serialutil.SerialTimeoutException:
            _logger.info("Dialog06 probe TIMEOUT on %s", port)
        except Exception:
            _logger.info('Dialog06 probe EXCEPTION on %s', port, exc_info=True)
        return False

    def _read_status(self, answer):
        pass

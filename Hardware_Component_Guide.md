# VSTY Submersible Micro Robot (Project Aqua) — Hardware Integration & Safety Guide

This guide documents the confirmed physical architecture, wiring, electrical safety rules, firmware protocol (`VSTY/1`), and incremental bench-testing workflow for the **VSTY Submersible Micro Robot**.

---

## 1. Confirmed Hardware Inventory & Status

| Subsystem | Component | Interface / Address | Status in Current Build |
| :--- | :--- | :--- | :--- |
| **Master Controller** | **Arduino UNO R3** (ATmega328P, 5V, 2KB SRAM) | USB Serial (`115200` baud, `VSTY/1` protocol) | Supported (`firmware/vsty_uno_controller/vsty_uno_controller.ino`) |
| **Host Computer** | Laptop / PC (Windows/Linux) or Raspberry Pi | Node.js Express Backend (`hardware/*`) | Active (communicates over USB Serial + LAN Wi-Fi) |
| **6-Axis IMU** | **MPU-6500** (`WHO_AM_I` = `0x70`) | I2C (`0x68`) — UNO `A4` (SDA), `A5` (SCL) | Tested & supported via direct register reads (no MPU6050 library lock-in) |
| **Turbidity Sensor** | Analog Gravity Turbidity Sensor | Analog Input `A0` (`0–1023` ADC, `0–5.0V` ref) | Supported (raw ADC + voltage + rail fault detection; optional 2-point NTU calibration) |
| **Vision Module** | **AI-Thinker ESP32-CAM** + ESP32-CAM-MB | Wi-Fi HTTP `:81/stream` (MJPEG), `:80/capture` (JPEG) | Supported (`firmware/vsty_esp32_cam/vsty_esp32_cam.ino` + backend LAN proxy/extractor) |
| **Propulsion Motors** | 4x **R385** Brushed DC Motors / Pumps (6–12V) | Driven via **L298N** Dual H-Bridge Driver(s) | **Stage-1 Bench Gated** (1 motor on Channel 1: `ENA=D5, IN1=D7, IN2=D8`) |
| **Vectoring Servos** | 4x **MG90S** Micro Servos (4.8–6.0V) | PWM Signal (`D9` for Stage-1 Servo 1) | **Stage-1 Bench Gated** (requires dedicated 5V UBEC; never power from UNO 5V) |
| **Main Battery** | **Orange Plus 3S LiPo** (`11.1V` nominal, `12.6V` full, `2200mAh`, `30C`) | Powers L298N `12V` input + 5V UBEC inputs via inline fuse | Requires pre-connect inspection, inline 10A–15A fuse, and LiPo cell checker |
| **Optional Sensors** | DS18B20 Temp, pH Probe, Depth Sensor, JSN-SR04T, NEO-6M GPS | Disabled by default (`*_INSTALLED="false"`) | Reported honestly as `NOT_INSTALLED` in `REAL` mode until physically wired |

> **Important Note on Previous Documentation:** Earlier drafts referenced an Arduino Nano and an `MPU6050` library. The actual master controller is the **Arduino UNO R3**, and the physical IMU returns `WHO_AM_I = 0x70` (**MPU-6500**). Standard `MPU6050` libraries that assert `WHO_AM_I == 0x68` will fail; the VSTY firmware communicates directly with registers `0x75`, `0x6B`, `0x3B..0x48` with hardware I2C timeout protection (`Wire.setWireTimeout`).

---

## 2. Arduino UNO R3 Pin Mapping & Timer Constraints

### Critical ATmega328P Hardware Constraint (`Servo.h` vs PWM)
On the Arduino UNO R3 (ATmega328P), the standard `Servo` library uses **16-bit Timer1**, which permanently disables hardware `analogWrite()` PWM on pins **`D9` and `D10`** whenever any servo is attached.
Therefore, only **4 hardware PWM pins (`D3, D5, D6, D11`)** remain available for L298N `ENA`/`ENB` motor speed control.

### Verified Pin Assignment (`firmware/vsty_uno_controller/vsty_uno_controller.ino`)

| Arduino UNO R3 Pin | Signal / Function | Connected Device | Notes |
| :--- | :--- | :--- | :--- |
| **`A0`** | `PIN_TURBIDITY_ADC` | Turbidity Sensor Analog Out (`AOUT`) | 10-bit ADC (`0..1023`), `5.0V` reference |
| **`A4` (SDA)** | I2C Data | MPU-6500 `SDA` | Address `0x68` (`AD0` tied to `GND`) |
| **`A5` (SCL)** | I2C Clock | MPU-6500 `SCL` | `100 kHz` standard I2C + `25ms` bus timeout |
| **`D5` (PWM)** | `PIN_MOTOR1_ENA` | L298N #1 `ENA` (Channel 1 Speed) | Timer0 PWM (unaffected by `Servo.h`) |
| **`D7`** | `PIN_MOTOR1_IN1` | L298N #1 `IN1` (Channel 1 Direction A) | Digital Output |
| **`D8`** | `PIN_MOTOR1_IN2` | L298N #1 `IN2` (Channel 1 Direction B) | Digital Output |
| **`D9`** | `PIN_SERVO1_SIG` | MG90S Servo #1 Signal (Orange/Yellow) | Driven by `Servo.h` (`1000..2000us`), bounded `30°..150°` |
| **`GND`** | Common Signal Ground | L298N `GND`, 5V UBEC `-`, Sensors `GND` | **Mandatory common reference across all subsystems** |

### Why Multi-Motor Operation Is Gated After Stage-1
1. **L298N Channel Capacity:** One L298N module contains **only 2 H-bridge channels** (`OUT1/OUT2` and `OUT3/OUT4`), rated at **2.0A continuous / 3.0A peak per channel**.
2. **R385 Current Draw:** An R385 motor draws `~0.8A–1.5A` under load and **`~2.5A–3.5A` stall/inrush current** at `11.1V–12V`. Wiring two R385 motors in parallel onto a single L298N channel risks immediate thermal shutdown or permanent H-bridge failure on direction reversal.
3. **Full 4-Motor Requirement:** Independent control of 4 R385 motors requires **two L298N modules** (or higher-efficiency MOSFET drivers such as TB6612FNG / BTS7960) and either an I2C PWM expander (PCA9685) or a Mega 2560 if 4 PWM channels + 4 direction pairs + 4 servos + sensors are used simultaneously.

---

## 3. Power Distribution & Electrical Safety Checklist

```
[3S LiPo 11.1V 2200mAh 30C]
   │
   ├──► [10A-15A Inline Fuse] ──► [Master Kill Switch]
   │                                  │
   │                                  ├──► L298N VMS (+12V Motor Supply)
   │                                  │      (Remove 5V regulator jumper if >12V or use external 5V logic)
   │                                  │
   │                                  ├──► 5V / 3A UBEC #1 ──► 4x MG90S Servo V+ (Red)
   │                                  │
   │                                  └──► 5V / 2A UBEC #2 ──► AI-Thinker ESP32-CAM 5V Pin
   │
   └──► Common GND Bus Bar ◄── Arduino UNO GND + L298N GND + UBEC GND + ESP32-CAM GND
```

### Mandatory Pre-Power Verification
1. **LiPo Health:** Measure individual cell voltages (`3.7V–4.2V` per cell; never discharge below `3.5V/cell` under load). Inspect for puffing or damaged leads.
2. **Never Power Servos or Motors from Arduino 5V:** Four MG90S servos can draw `2.5A–3.2A` peak when stalling; the Arduino UNO USB/onboard 5V regulator will brown out and reset the MCU. Always power servos from a dedicated **5V UBEC** with common `GND`.
3. **ESP32-CAM Brownout Prevention:** Power the ESP32-CAM via its `5V` pin from a stable 5V supply (`>= 1A` peak capability) or its dedicated USB-MB dock.
4. **Dry Bench Testing First:** Keep all electronics dry and props/impellers clear during Stage-1 testing. Standard R385 pumps/motors are **not waterproof** for direct immersion without a sealed housing and shaft seal.

---

## 4. Serial Communication Protocol (`VSTY/1`)

The Node.js backend (`hardware/controllerService.ts`) and Arduino UNO firmware (`firmware/vsty_uno_controller/vsty_uno_controller.ino`) communicate over USB Serial at **`115200` baud (`8N1`)** using newline-delimited (`\n`) ASCII frames.

### Controller-to-Host Frames
- **Handshake / Boot Greeting:**
  ```text
  VSTY/1 HELLO fw=1.0.0 board=UNO_R3 imu=0x70
  ```
- **Periodic Telemetry (`5 Hz` / every `200ms`):**
  ```text
  VSTY/1 TELEM uptime=<ms> mode=<DISARMED|ARMED|ESTOP> turb_adc=<0..1023> turb_v=<0.000..5.000> imu_ok=<0|1> who=<0x70> ax=<g> ay=<g> az=<g> gx=<dps> gy=<dps> gz=<dps> roll=<deg> pitch=<deg> yaw=<deg> m1_pwm=<-255..255> s1_deg=<0..180>
  ```
- **Command Acknowledgement / Error:**
  ```text
  VSTY/1 ACK seq=<n> cmd=<CMD> <key=value ...>
  VSTY/1 ERR seq=<n> code=<REASON> msg=<DETAIL>
  ```
- **Asynchronous Safety Events (e.g., Watchdog Expiry):**
  ```text
  VSTY/1 EVENT code=WATCHDOG_TIMEOUT msg=MOTOR_NEUTRALIZED
  ```

### Host-to-Controller Commands
All commands include a monotonically increasing sequence number `<seq>` and must receive a matching `ACK seq=<seq>` within `SERIAL_COMMAND_TIMEOUT_MS` (`1500ms` default):
- `VSTY/1 CMD <seq> PING` — Resets the 2000ms controller hardware watchdog.
- `VSTY/1 CMD <seq> HELLO` — Requests immediate `HELLO` identity response.
- `VSTY/1 CMD <seq> ESTOP` — Latches `ESTOP` state, forces L298N `ENA=0, IN1=LOW, IN2=LOW`, centers Servo 1 to `90°`.
- `VSTY/1 CMD <seq> STOP` — Stops Motor 1 (`ENA=0, IN1=LOW, IN2=LOW`) and centers Servo 1 (`90°`).
- `VSTY/1 CMD <seq> CLEAR_ESTOP` — Transitions from `ESTOP` to `DISARMED` with outputs neutral.
- `VSTY/1 CMD <seq> ARM` — Arms Stage-1 bench control (allowed only when not in `ESTOP`).
- `VSTY/1 CMD <seq> DISARM` — Neutralizes outputs and returns to `DISARMED`.
- `VSTY/1 CMD <seq> M1 <F|R|STOP> <pwm:0..180> <duration_ms:50..3000>` — Runs Stage-1 Motor 1 for a bounded duration; firmware automatically stops the motor when `duration_ms` elapses or if the `2000ms` watchdog expires.
- `VSTY/1 CMD <seq> S1 <angle_deg:30..150>` — Moves Stage-1 Servo 1 within safe mechanical bounds (`30°..150°`).

---

## 5. Backend Operating Modes & Diagnostic Endpoints

The backend defaults to `HARDWARE_MODE="SIMULATION"` so development and cloud deployments remain non-breaking.

### Local Hardware Bench API (`/api/hardware/*`)
When running locally on the host computer (`npm run dev`), the following endpoints inspect and operate the physical hardware adapter:

- `GET /api/hardware/status` — Full diagnostics: operating mode, discovered OS serial ports, controller connection/handshake state, armed/ESTOP state, raw & calibrated turbidity telemetry, MPU-6500 IMU status, uninstalled sensor flags, and ESP32-CAM reachability.
- `POST /api/hardware/mode` — Switch between `{"mode": "SIMULATION"}` and `{"mode": "REAL"}`.
- `POST /api/hardware/connect` — Connect and verify `VSTY/1` handshake on `{"port": "COM3"}` (or `SERIAL_PORT` from `.env`).
- `POST /api/hardware/disconnect` — Safely neutralizes outputs and closes the serial port.
- `POST /api/hardware/arm` — Explicitly arms Stage-1 propulsion (requires `REAL` mode, verified controller handshake, and `PROPULSION_CONFIRMED="true"`).
- `POST /api/hardware/disarm` — Disarms propulsion and zeroes outputs.
- `POST /api/hardware/clear-estop` — Clears a latched emergency stop back to `DISARMED`.
- `POST /api/hardware/motor-test` — Bounded Stage-1 single-motor test: `{"direction": "F", "pwm": 90, "durationMs": 600}`.
- `POST /api/hardware/servo-test` — Bounded Stage-1 single-servo test: `{"angleDeg": 90}`.
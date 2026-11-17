# VSTY ESP32-CAM Live Video Stream Guide

Complete, step-by-step instructions to configure, flash, and run live video on your **VSTY Submersible Micro Robot** Mission Control dashboard using an **AI-Thinker ESP32-CAM (OV2640)**.

---

## 1. Hardware Requirements

| Component | Description |
|---|---|
| **ESP32-CAM Module** | AI-Thinker model with OV2640 camera sensor & external PSRAM chip |
| **Programmer** | **ESP32-CAM-MB** (Micro-USB shield) **OR** standard **FTDI USB-to-TTL programmer** (3.3V/5V) |
| **Power Supply** | Clean 5V with at least **2A** current (ESP32 Wi-Fi bursts draw up to 800mA) |
| **Jumper Wires** | Required if using FTDI programmer (especially GPIO 0 to GND) |

---

## 2. Programmer Wiring

### Option A: Using ESP32-CAM-MB Shield (Recommended & Easiest)
1. Snap the ESP32-CAM onto the ESP32-CAM-MB shield.
2. Plug the Micro-USB cable into your laptop.
3. No jumper wires required! The shield automatically handles GPIO 0 and reset.

---

### Option B: Using FTDI USB-to-TTL Programmer

| FTDI Programmer Pin | ESP32-CAM Pin | Note |
|---|---|---|
| **VCC (5V)** | **5V** | Do NOT use 3.3V pin; power drops trigger brownout resets |
| **GND** | **GND** | Ground connection |
| **TX** | **U0R (GPIO 3)** | Programmer TX connects to ESP32 RX |
| **RX** | **U0T (GPIO 1)** | Programmer RX connects to ESP32 TX |
| **GPIO 0** | **GND** | **MUST BE CONNECTED DURING FIRMWARE UPLOAD** |

> [!IMPORTANT]
> **GPIO 0 must be connected to GND** when pressing Upload in Arduino IDE. Once upload completes ("Done uploading"), **disconnect GPIO 0 from GND** and press the **RST (Reset)** button on the ESP32-CAM.

---

## 3. Arduino IDE Setup & Configuration

1. Install **Arduino IDE** (version 2.x or 1.8.x).
2. Go to **File -> Preferences** and add the ESP32 board URL to *Additional Boards Manager URLs*:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Open **Tools -> Board -> Boards Manager**, search for `esp32` by Espressif Systems, and click **Install**.
4. Open the firmware file:
   [`firmware/vsty_esp32_cam/vsty_esp32_cam.ino`](file:///firmware/vsty_esp32_cam/vsty_esp32_cam.ino)
5. Select these **exact board settings** under the **Tools** menu:
   - **Board:** `AI Thinker ESP32-CAM`
   - **CPU Frequency:** `240MHz (WiFi/BT)`
   - **Flash Frequency:** `80MHz`
   - **Flash Mode:** `QIO`
   - **Partition Scheme:** `Huge APP (3MB No OTA/1MB SPIFFS)`
   - **Core Debug Level:** `None` (or `Info` for debugging)
   - **PSRAM:** `Enabled` *(Crucial for fluid 30 FPS double-buffering)*
   - **Port:** Select the COM port corresponding to your programmer (e.g. `COM3`, `COM5`).

---

## 4. Flash the Firmware

1. In [`vsty_esp32_cam.ino`](file:///firmware/vsty_esp32_cam/vsty_esp32_cam.ino), update your Wi-Fi credentials:
   ```cpp
   const char* WIFI_SSID     = "Your_WiFi_Or_Hotspot_Name";
   const char* WIFI_PASSWORD = "Your_WiFi_Password";
   ```
   *(Note: Hotspot must be 2.4 GHz; ESP32 does not support 5 GHz).*
2. Connect **GPIO 0 to GND** (if using FTDI).
3. Click the **Upload** button in Arduino IDE.
4. When you see `Connecting........____....`, press the **RST** button on the ESP32 once.
5. Wait until `Done uploading` appears.
6. **Disconnect GPIO 0 from GND** and press **RST**.

---

## 5. Verify Camera Operation in Serial Monitor

1. Open **Tools -> Serial Monitor** in Arduino IDE.
2. Set the baud rate to **115200**.
3. Press the **RST** button on the ESP32-CAM.
4. You will see the initialization output:
   ```text
   ========================================================
     VSTY SUBMERSIBLE MICRO ROBOT — ESP32-CAM READY
   ========================================================
     Wi-Fi Mode:          Station (Connected to Wi-Fi Network)
     ESP32-CAM IP:        192.168.1.184
     Mission Control IP:  192.168.1.184
     Stream URL (Port 81): http://192.168.1.184:81/stream
     Capture URL (Port 80):http://192.168.1.184/capture
     Diagnostic Webpage:   http://192.168.1.184
   ========================================================
   ```
5. Open `http://<ESP32-CAM-IP>` (e.g. `http://192.168.1.184`) in your browser to verify the live video preview and flash light controls directly on the hardware!

---

## 6. Run Live Video in VSTY Mission Control

### Mode A: Running Locally (Local Gateway Mode)
1. Open your terminal in the repository folder:
   ```bash
   npm run build
   node dist/server.cjs
   ```
2. Open `http://localhost:3000` in your web browser.
3. Go to **Mission Camera Control**.
4. In the **CAM IP:** field, enter your ESP32-CAM IP (e.g. `192.168.1.184` or `http://192.168.1.184:81`).
5. Click **Test Connection**:
   - Status badge turns green: **Connected**.
   - Latency displays in the telemetry ribbon.
   - Live video stream appears instantly in the viewport!
6. Click **Save Config** to permanently remember this IP for your operator account.

---

### Mode B: Cloud Deployment on Render (Live Gateway Relay)
When accessing the cloud deployment at `https://submersible-micro-robot.onrender.com`:
Render cannot reach your local Wi-Fi private IP (`192.168.x.x`) directly over the internet. The project includes an automatic, high-speed Python gateway:

1. In the VSTY Mission Control dashboard on Render, open **Mission Camera Control** -> **Settings (gear icon)** -> click **Copy Gateway Token**.
2. Open PowerShell in the project directory:
   ```powershell
   $env:VSTY_AUTH_TOKEN = "PASTE_YOUR_COPIED_TOKEN_HERE"
   py tools/camera_gateway.py --camera-url "http://192.168.1.184:81/stream" --fps 30
   ```
3. The gateway streams frames from your local ESP32-CAM directly into Render, and the dashboard displays the live feed!

---

## 7. Troubleshooting Checklist

| Issue | Root Cause | Solution |
|---|---|---|
| `Timed out waiting for packet header` | ESP32 is not in bootloader mode | Connect GPIO 0 to GND, press RST, then click Upload. |
| `esp_camera_init failed 0x20001` | Sensor ribbon disconnected | Reseat the 24-pin ribbon cable in the connector with contacts facing PCB. |
| `Brownout detector was triggered` | Insufficient current on 5V rail | Use a dedicated 5V 2A power source or powered USB hub. |
| Stream drops after a few seconds | Inactivity timeout | Fixed in backend proxy with keep-alive and socket timeout removal. |
| Wi-Fi fails to connect | 5 GHz band or wrong password | Ensure phone hotspot or router is 2.4 GHz; if it fails, connect laptop directly to `VSTY-ROBOT-CAM` AP mode (`192.168.4.1`). |

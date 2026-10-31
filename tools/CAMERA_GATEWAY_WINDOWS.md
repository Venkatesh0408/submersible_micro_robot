# VSTY ESP32-CAM Gateway (Windows)

This gateway is required when the dashboard is hosted on Render and the ESP32-CAM is on your phone hotspot. Render cannot connect directly to a private hotspot IP. The laptop reads the local MJPEG stream and uploads individual JPEG frames to the authenticated Render relay. The existing dashboard displays the Render MJPEG stream.

## 1. Connect both devices to the same hotspot

1. Set your phone hotspot to **2.4 GHz**.
2. Connect the laptop to that hotspot.
3. Configure the ESP32-CAM Wi-Fi as a **station (STA) client** of the same hotspot.
4. Read the ESP32-CAM's new DHCP IP from Serial Monitor. The old 192.168.4.10 address may be its own access-point address and can change after joining the phone hotspot.
5. On the laptop, test http://CAMERA_IP:81/stream in a browser. Continue only when the MJPEG stream opens.

## 2. Install the gateway

Open PowerShell in the repository folder and run:

    py -m pip install -r tools/requirements-camera.txt

## 3. Get your own login token

1. Sign in to the VSTY dashboard and open Mission Camera Control.
2. Click **Copy Gateway Token**. The private login token is copied to your clipboard.
3. Treat it like a password. Never send it in chat or commit it to GitHub. If the copy button is unavailable, use browser DevTools -> Application -> Local Storage -> the Render site -> token.

In the same PowerShell window, set it for this session:

    $env:VSTY_AUTH_TOKEN = "PASTE_YOUR_OWN_TOKEN_HERE"

## 4. Start the camera relay

Replace CAMERA_IP with the current IP printed by the ESP32-CAM:

    py tools/camera_gateway.py --camera-url "http://CAMERA_IP:81/stream" --fps 40

Keep this PowerShell window open while using the dashboard. The script reconnects automatically if the camera stream drops. Press Ctrl+C to stop it.

## 5. View the video in VSTY

1. Open the VSTY dashboard and go to Mission Camera Control.
2. Enter the current ESP32-CAM IP and press **Save Config**.
3. Wait a few seconds for the gateway to upload frames.
4. Press **Test Connection**. The status should change to Connected and the existing camera panel should show the stream.

## Performance tuning

- For the highest frame rate, configure the ESP32-CAM for QVGA (320x240), JPEG output, and a moderate JPEG quality setting; try 30 FPS first, then 40 FPS if the stream remains stable.
- For a clearer image, use VGA (640x480) and start around 15-20 FPS; the camera sensor and Wi-Fi link may not sustain 40 FPS at VGA.
- The gateway supports up to 40 FPS, matching the server-side 40 FPS safety ceiling. This is a ceiling, not a guarantee. If uploads cannot keep up, measured FPS will be lower.
- Keep the laptop close to the 2.4 GHz hotspot and avoid other heavy uploads while streaming.
- The displayed FPS is measured from frames received by Render, not a promised camera sensor frame rate.
- Actual FPS depends on ESP32-CAM sensor settings, JPEG size, hotspot quality, laptop upload bandwidth, and Render service capacity.

## Security and operation

- The upload endpoint requires a valid VSTY login JWT and accepts only structurally valid JPEG frames up to 512 KB.
- The token is read from the VSTY_AUTH_TOKEN environment variable and is not stored in this script.
- Keep the token private. If it expires, sign in again and set the refreshed token.
- The laptop and ESP32-CAM must be able to communicate locally over the hotspot. Some phone hotspots isolate clients; if the browser cannot open the camera IP, the gateway cannot reach it either.

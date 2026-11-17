/*
 * ============================================================================
 * VSTY — Submersible Micro Robot (Project Aqua)
 * AI-Thinker ESP32-CAM (OV2640) High-Performance Live Video Stream Firmware
 * ============================================================================
 *
 * EXPOSES:
 * - Port 81 `/stream`  : Multi-client MJPEG live video stream (Mission Control default)
 * - Port 80 `/stream`  : Port 80 stream fallback (for single-port configurations)
 * - Port 80 `/capture` : Single JPEG snapshot endpoint
 * - Port 80 `/shot.jpg`: Snapshot alias for phone camera applications
 * - Port 80 `/status`  : JSON health, RSSI, Free Heap & PSRAM status
 * - Port 80 `/flash`   : Onboard high-power illumination LED toggle (?state=1 or 0)
 * - Port 80 `/`        : Web-based diagnostics & live test preview page
 *
 * DUAL WI-FI OPERATION:
 * 1. Station (STA) Mode: Connects to your 2.4 GHz Home Wi-Fi or Phone Hotspot.
 * 2. SoftAP Fallback:    If STA fails to connect within 15 seconds, automatically
 *    creates a direct access point ("VSTY-ROBOT-CAM" / IP: 192.168.4.1) for field use.
 *
 * HARDWARE CONFIGURATION & FLASHING GUIDE:
 * - Board: "AI Thinker ESP32-CAM"
 * - CPU Frequency: 240MHz (WiFi/BT)
 * - Flash Frequency: 80MHz
 * - Flash Mode: QIO
 * - Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
 * - PSRAM: "Enabled" (Crucial for smooth VGA double-buffering)
 *
 * FLASHING WIRING (using FTDI / USB-to-TTL programmer):
 * - FTDI 5V   -> ESP32-CAM 5V (Requires >= 2A clean power)
 * - FTDI GND  -> ESP32-CAM GND
 * - FTDI TX   -> ESP32-CAM U0R (GPIO 3)
 * - FTDI RX   -> ESP32-CAM U0T (GPIO 1)
 * - FLASH JUMPER: Connect GPIO 0 to GND while uploading firmware.
 * - After upload completes: Disconnect GPIO 0 from GND and press RST button.
 * ============================================================================
 */

#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

// ============================================================================
// 1. WI-FI CONFIGURATION
// ============================================================================
// Replace with your 2.4 GHz Wi-Fi Router or Phone Hotspot credentials:
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Wi-Fi Access Point fallback (used when router/hotspot is unreachable)
const char* AP_SSID       = "VSTY-ROBOT-CAM";
const char* AP_PASSWORD   = "submersible123"; // Minimum 8 characters

// Maximum connection attempts before falling back to SoftAP (30 * 500ms = 15s)
#define WIFI_MAX_ATTEMPTS 30

// ============================================================================
// 2. HARDWARE PIN DEFINITIONS (AI-Thinker ESP32-CAM)
// ============================================================================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// Onboard high-power white LED flash on GPIO 4
#define FLASH_LED_PIN      4

// ============================================================================
// 3. MJPEG STREAM DEFINITIONS & BUFFERS
// ============================================================================
#define PART_BOUNDARY "frame"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static httpd_handle_t camera_httpd = NULL;
static httpd_handle_t stream_httpd = NULL;
static bool servers_started = false;

// ============================================================================
// 4. HTTP REQUEST HANDLERS
// ============================================================================

// Diagnostic Test Webpage
static esp_err_t index_handler(httpd_req_t *req) {
  IPAddress ip = (WiFi.getMode() == WIFI_AP) ? WiFi.softAPIP() : WiFi.localIP();
  char ipStr[20];
  snprintf(ipStr, sizeof(ipStr), "%s", ip.toString().c_str());

  String html = F("<!DOCTYPE html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>VSTY Robot - ESP32-CAM</title>"
    "<style>"
    "body{background:#070d18;color:#22d3ee;font-family:system-ui,sans-serif;text-align:center;margin:0;padding:20px;}"
    "h1{color:#38bdf8;margin-bottom:4px;font-size:22px;letter-spacing:1px;}"
    "p.sub{color:#64748b;font-size:13px;margin-top:0;}"
    ".box{max-width:640px;margin:15px auto;border:2px solid rgba(34,211,238,0.4);border-radius:12px;overflow:hidden;background:#000;box-shadow:0 0 25px rgba(34,211,238,0.25);}"
    "img{width:100%;height:auto;display:block;}"
    ".btn-row{margin:15px 0;display:flex;justify-content:center;gap:10px;flex-wrap:wrap;}"
    "button,a.btn{background:#16203a;color:#38bdf8;border:1px solid #38bdf8;padding:9px 16px;border-radius:8px;font-weight:bold;cursor:pointer;text-decoration:none;font-size:13px;}"
    "button:hover,a.btn:hover{background:#0284c7;color:#fff;}"
    ".card{max-width:600px;margin:15px auto;background:#0c1527;border:1px solid #1e293b;border-radius:8px;padding:14px;font-size:13px;font-family:monospace;color:#94a3b8;text-align:left;line-height:1.6;}"
    ".card b{color:#38bdf8;}"
    "</style></head><body>"
    "<h1>VSTY SUBMERSIBLE MICRO ROBOT</h1>"
    "<p class='sub'>AI-Thinker ESP32-CAM (OV2640) Live Stream Server</p>"
    "<div class='box'><img src='/stream' alt='Live Video Stream'></div>"
    "<div class='btn-row'>"
    "<button onclick=\"fetch('/flash?state=1')\">Flash Light ON</button>"
    "<button onclick=\"fetch('/flash?state=0')\">Flash Light OFF</button>"
    "<a href='/capture' class='btn' target='_blank'>Capture Still Frame</a>"
    "<a href='/status' class='btn' target='_blank'>JSON Status</a>"
    "</div>"
    "<div class='card'>"
    "<div>Enter CAM IP in Mission Control: <b>");
  html += ipStr;
  html += F("</b></div>"
    "<div>Live Stream URL (Port 81):  <b>http://");
  html += ipStr;
  html += F(":81/stream</b></div>"
    "<div>Snapshot URL (Port 80):     <b>http://");
  html += ipStr;
  html += F("/capture</b></div>"
    "</div></body></html>");

  httpd_resp_set_type(req, "text/html");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, html.c_str(), html.length());
}

// Single JPEG snapshot handler (/capture and /shot.jpg)
static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, OPTIONS");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

// Health and telemetry JSON status handler (/status)
static esp_err_t status_handler(httpd_req_t *req) {
  char json[256];
  IPAddress ip = (WiFi.getMode() == WIFI_AP) ? WiFi.softAPIP() : WiFi.localIP();
  snprintf(json, sizeof(json),
           "{\"online\":true,\"mode\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"psram\":%s,\"freeHeap\":%u,\"flashState\":%d}",
           (WiFi.getMode() == WIFI_AP) ? "AP" : "STA",
           ip.toString().c_str(),
           (WiFi.getMode() == WIFI_AP) ? 0 : WiFi.RSSI(),
           psramFound() ? "true" : "false",
           ESP.getFreeHeap(),
           digitalRead(FLASH_LED_PIN));
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, strlen(json));
}

// Flash illumination LED controller (/flash?state=1 or /flash?state=0)
static esp_err_t flash_handler(httpd_req_t *req) {
  char query[32];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
    char val[8];
    if (httpd_query_key_value(query, "state", val, sizeof(val)) == ESP_OK) {
      int state = atoi(val);
      digitalWrite(FLASH_LED_PIN, state ? HIGH : LOW);
    }
  }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char resp[64];
  snprintf(resp, sizeof(resp), "{\"flash\":%d}", digitalRead(FLASH_LED_PIN));
  return httpd_resp_send(req, resp, strlen(resp));
}

// Continuous MJPEG live stream handler (/stream)
static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;
  char part_buf[64];

  res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;

  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, OPTIONS");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "30");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      res = ESP_FAIL;
    } else {
      size_t hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART, fb->len);
      res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, part_buf, hlen);
      if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
      esp_camera_fb_return(fb);
    }
    if (res != ESP_OK) break;
  }
  return res;
}

// ============================================================================
// 5. HTTP SERVER INITIALIZATION
// ============================================================================
static void startCameraServers() {
  if (servers_started) return;

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_uri_handlers = 8;

  // URIs for Port 80 (Web UI, capture, status, flash, and port 80 stream fallback)
  httpd_uri_t index_uri   = { .uri = "/",        .method = HTTP_GET, .handler = index_handler,   .user_ctx = NULL };
  httpd_uri_t capture_uri = { .uri = "/capture",  .method = HTTP_GET, .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t shot_uri    = { .uri = "/shot.jpg", .method = HTTP_GET, .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t status_uri  = { .uri = "/status",   .method = HTTP_GET, .handler = status_handler,  .user_ctx = NULL };
  httpd_uri_t flash_uri   = { .uri = "/flash",    .method = HTTP_GET, .handler = flash_handler,   .user_ctx = NULL };
  httpd_uri_t stream80_uri= { .uri = "/stream",   .method = HTTP_GET, .handler = stream_handler,  .user_ctx = NULL };
  httpd_uri_t video80_uri = { .uri = "/video",    .method = HTTP_GET, .handler = stream_handler,  .user_ctx = NULL };

  config.server_port = 80;
  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &index_uri);
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &shot_uri);
    httpd_register_uri_handler(camera_httpd, &status_uri);
    httpd_register_uri_handler(camera_httpd, &flash_uri);
    httpd_register_uri_handler(camera_httpd, &stream80_uri);
    httpd_register_uri_handler(camera_httpd, &video80_uri);
  }

  // URIs for Port 81 (High-Speed MJPEG stream server)
  httpd_uri_t stream81_uri = { .uri = "/stream", .method = HTTP_GET, .handler = stream_handler, .user_ctx = NULL };
  httpd_uri_t video81_uri  = { .uri = "/video",  .method = HTTP_GET, .handler = stream_handler, .user_ctx = NULL };

  config.server_port = 81;
  config.ctrl_port   = 32769;
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream81_uri);
    httpd_register_uri_handler(stream_httpd, &video81_uri);
    servers_started = true;
  }
}

// ============================================================================
// 6. WI-FI CONNECTION & FALLBACK
// ============================================================================
static void printConnectionBanner(IPAddress ip, const char* modeName) {
  Serial.println("\n========================================================");
  Serial.println("  VSTY SUBMERSIBLE MICRO ROBOT — ESP32-CAM READY");
  Serial.println("========================================================");
  Serial.print("  Wi-Fi Mode:          "); Serial.println(modeName);
  Serial.print("  ESP32-CAM IP:        "); Serial.println(ip);
  Serial.print("  Mission Control IP:  "); Serial.println(ip);
  Serial.print("  Stream URL (Port 81): http://"); Serial.print(ip); Serial.println(":81/stream");
  Serial.print("  Capture URL (Port 80):http://"); Serial.print(ip); Serial.println("/capture");
  Serial.print("  Diagnostic Webpage:   http://"); Serial.println(ip);
  Serial.println("========================================================\n");
}

static bool setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to Wi-Fi SSID '%s'...", WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < WIFI_MAX_ATTEMPTS) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    printConnectionBanner(WiFi.localIP(), "Station (Connected to Wi-Fi Network)");
    return true;
  }

  // Fallback to SoftAP Access Point Mode
  Serial.println("\n[Wi-Fi] Unable to connect to router/hotspot.");
  Serial.printf("[Wi-Fi] Starting fallback Access Point: '%s'...\n", AP_SSID);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  delay(100);

  printConnectionBanner(WiFi.softAPIP(), "Access Point (Connect laptop directly to VSTY-ROBOT-CAM)");
  return true;
}

// ============================================================================
// 7. SETUP & MAIN LOOP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n\n>>> Initializing VSTY ESP32-CAM Submersible Robot System <<<");

  // Initialize flash illumination LED pin as OUTPUT and turn it off
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);

  // Configure camera parameters
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.sccb_i2c_port = 0;

  // PSRAM buffer allocation check
  if (psramFound()) {
    Serial.println("[PSRAM] Found PSRAM. Using dual VGA frame buffers (30 FPS).");
    config.frame_size   = FRAMESIZE_VGA;      // 640x480 (sharp and responsive)
    config.jpeg_quality = 10;                 // 10-12 provides great clarity & high FPS
    config.fb_count     = 2;                  // Double-buffering for fluid streaming
    config.fb_location  = CAMERA_FB_IN_PSRAM;
    config.grab_mode    = CAMERA_GRAB_LATEST; // Lowest latency (drops stale frames)
  } else {
    Serial.println("[PSRAM] PSRAM NOT detected. Using DRAM buffer.");
    Serial.println("  TIP: In Arduino IDE, set Tools -> PSRAM: 'Enabled'.");
    config.frame_size   = FRAMESIZE_QVGA;     // 320x240 for systems without PSRAM
    config.jpeg_quality = 12;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  }

  // Camera sensor initialization
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[ERROR] esp_camera_init failed: 0x%x\n", err);
    Serial.println("Troubleshooting Checklist:");
    Serial.println(" 1. Camera Sensor: Ensure OV2640 is connected (OV7670 is not supported).");
    Serial.println(" 2. Ribbon Cable: Verify 24-pin ribbon is straight and locked in socket.");
    Serial.println(" 3. Power Supply: Ensure a 5V 2A power supply is connected.");
    return;
  }

  // Optimize camera image settings for aquatic / underwater environments
  sensor_t *s = esp_camera_sensor_get();
  if (s != NULL) {
    s->set_brightness(s, 1);     // Slight boost for dark underwater inspection
    s->set_contrast(s, 1);       // Sharp edge contrast for subsea pipelines
    s->set_saturation(s, 0);     // Balanced color saturation
    s->set_whitebal(s, 1);       // Enable auto white balance
    s->set_awb_gain(s, 1);       // Enable auto white balance gain
    s->set_wb_mode(s, 0);        // Auto white balance mode
  }

  Serial.println("[Camera] OV2640 Initialized successfully.");

  // Connect to Wi-Fi and start streaming servers
  setupWiFi();
  startCameraServers();
}

void loop() {
  // If in STA mode and connection dropped, reconnect automatically every 10 seconds
  if (WiFi.getMode() == WIFI_STA && WiFi.status() != WL_CONNECTED) {
    static unsigned long lastRetry = 0;
    if (millis() - lastRetry > 10000) {
      lastRetry = millis();
      Serial.println("[Wi-Fi] Disconnected from network. Attempting reconnection...");
      WiFi.reconnect();
    }
  }
  delay(1000);
}

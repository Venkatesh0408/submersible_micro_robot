/*
 * VSTY — Submersible Micro Robot (Project Aqua)
 * AI-Thinker ESP32-CAM (with ESP32-CAM-MB USB programmer) Reference Firmware
 *
 * Exposes:
 * - Port 81 `/stream`  : Multipart MJPEG live video stream (compatible with /api/camera/stream)
 * - Port 80 `/capture` : Single JPEG snapshot endpoint (compatible with /api/camera/snapshot)
 * - Port 80 `/status`  : JSON health & RSSI status endpoint
 *
 * HARDWARE / COMPATIBILITY NOTES:
 * 1. Image Sensor: Requires OV2640 with hardware JPEG compression (PIXFORMAT_JPEG).
 *    Note: OV7670 does NOT have hardware JPEG encoding and will fail initialization.
 * 2. Ribbon Cable: Verify the 24-pin ribbon cable is firmly seated with golden contacts
 *    facing toward the PCB, and the latch is closed.
 * 3. PSRAM: In Arduino IDE, verify Tools -> PSRAM is set to "Enabled".
 * 4. Power Supply: Requires clean 5V with minimum 2A peak current (especially during Wi-Fi transmission).
 *
 * SECURITY RULE:
 * Never commit real Wi-Fi SSIDs or passwords to Git. Replace placeholders locally before flashing.
 */

#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

// Replace locally before uploading — DO NOT commit real Wi-Fi credentials
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Maximum Wi-Fi connection attempts before backoff retry (30 * 500ms = 15 seconds)
#define WIFI_MAX_ATTEMPTS 30

// AI-Thinker ESP32-CAM Pin Map
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

#define PART_BOUNDARY "frame"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static httpd_handle_t camera_httpd = NULL;
static httpd_handle_t stream_httpd = NULL;
static bool servers_started = false;

static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

static esp_err_t status_handler(httpd_req_t *req) {
  char json[128];
  snprintf(json, sizeof(json), "{\"online\":true,\"rssi\":%d,\"psram\":%s}", 
           WiFi.RSSI(), psramFound() ? "true" : "false");
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, strlen(json));
}

static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;
  char part_buf[64];

  res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

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

static void startCameraServers() {
  if (servers_started) return;

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t capture_uri = { .uri = "/capture", .method = HTTP_GET, .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t status_uri  = { .uri = "/status",  .method = HTTP_GET, .handler = status_handler,  .user_ctx = NULL };
  httpd_uri_t stream_uri  = { .uri = "/stream",  .method = HTTP_GET, .handler = stream_handler,  .user_ctx = NULL };

  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &status_uri);
  }

  config.server_port = 81;
  config.ctrl_port   = 32769;
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    servers_started = true;
  }
}

static bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi SSID: ");
  Serial.print(WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < WIFI_MAX_ATTEMPTS) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi Connected successfully!");
    Serial.print("ESP32-CAM Local IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("Live Stream URL: http://");
    Serial.print(WiFi.localIP());
    Serial.println(":81/stream");
    return true;
  } else {
    Serial.println("Wi-Fi connection timed out. Check SSID/password and ensure hotspot is active.");
    return false;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n--- VSTY Submersible Micro Robot Camera Firmware ---");

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

  if (psramFound()) {
    Serial.println("[PSRAM] Found. Using high-resolution VGA buffer.");
    config.frame_size   = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
    config.grab_mode    = CAMERA_GRAB_LATEST;
  } else {
    Serial.println("[PSRAM] NOT found. Falling back to CIF frame buffer.");
    Serial.println("TIP: In Arduino IDE, ensure Tools -> PSRAM is set to 'Enabled'.");
    config.frame_size   = FRAMESIZE_CIF;
    config.jpeg_quality = 14;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[ERROR] esp_camera_init failed with error code: 0x%x\n", err);
    Serial.println("Troubleshooting Checklist:");
    Serial.println(" 1. Camera sensor: Ensure OV2640 is connected. OV7670 is NOT compatible (no JPEG engine).");
    Serial.println(" 2. Ribbon cable: Check the 24-pin FPC ribbon seating and gold contacts orientation.");
    Serial.println(" 3. Power supply: Supply at least 5V 2A via ESP32-CAM-MB USB board.");
    return;
  }

  Serial.println("[Camera] Initialized successfully.");
  if (connectWiFi()) {
    startCameraServers();
  }
}

void loop() {
  // If disconnected, retry Wi-Fi every 10 seconds without locking the loop
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastRetry = 0;
    if (millis() - lastRetry > 10000) {
      lastRetry = millis();
      Serial.println("[Wi-Fi] Reconnecting...");
      if (connectWiFi()) {
        startCameraServers();
      }
    }
  }
  delay(1000);
}

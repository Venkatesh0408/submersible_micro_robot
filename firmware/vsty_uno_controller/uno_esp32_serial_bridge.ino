#include <SoftwareSerial.h>

// Connect: Pin 10 (UNO RX) <- ESP32 TX (GPIO 14)
//          Pin 11 (UNO TX) -> ESP32 RX (GPIO 15)
SoftwareSerial espSerial(10, 11);

void setup() {
  Serial.begin(115200);     // USB Monitor to PC
  espSerial.begin(9600);    // Serial link to ESP32-CAM
  Serial.println(F("[UNO] Submersible controller serial bridge online."));
}

void loop() {
  // Relay data received from ESP32-CAM to PC Serial Monitor
  if (espSerial.available()) {
    char c = espSerial.read();
    Serial.write(c);
  }

  // Relay commands from PC Serial Monitor to ESP32-CAM
  if (Serial.available()) {
    char c = Serial.read();
    espSerial.write(c);
  }
}

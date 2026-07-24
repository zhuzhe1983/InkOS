#include "network_adapter.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>

#include <algorithm>
#include <memory>

namespace inkos::paper {
namespace {

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

} // namespace

bool NetworkAdapter::connect(const char *ssid, const char *password,
                             uint32_t timeoutMs, std::string &error) {
  if (!ssid || ssid[0] == '\0') {
    return fail(error, "Wi-Fi SSID is not configured");
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password ? password : "");
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) {
    delay(50);
  }
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect(false, false);
    return fail(error, "Wi-Fi connection timed out");
  }
  return true;
}

bool NetworkAdapter::connected() const { return WiFi.status() == WL_CONNECTED; }

bool NetworkAdapter::download(fs::FS &fs, const std::string &url,
                              const std::string &destinationPath,
                              uint64_t maximumBytes, const char *rootCa,
                              std::string &error) {
  if (!connected()) {
    return fail(error, "Network is not connected");
  }
  const bool secure = url.rfind("https://", 0) == 0;
  const bool plain = url.rfind("http://", 0) == 0;
  if (!secure && !plain) {
    return fail(error, "Only HTTP(S) package URLs are supported");
  }
  if (secure && (!rootCa || rootCa[0] == '\0')) {
    return fail(error, "HTTPS package download requires a trusted root CA");
  }

  std::unique_ptr<WiFiClient> client;
  if (secure) {
    auto tls = std::make_unique<WiFiClientSecure>();
    tls->setCACert(rootCa);
    client = std::move(tls);
  } else {
    client = std::make_unique<WiFiClient>();
  }

  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if (!http.begin(*client, String(url.c_str()))) {
    return fail(error, "Cannot initialize content OTA request");
  }
  const int status = http.GET();
  if (status != HTTP_CODE_OK) {
    http.end();
    return fail(error, "Content OTA HTTP status " + std::to_string(status));
  }
  const int advertised = http.getSize();
  if (advertised == 0 ||
      (advertised > 0 && static_cast<uint64_t>(advertised) > maximumBytes)) {
    http.end();
    return fail(error, "Content OTA response exceeds compressed size limit");
  }

  fs.remove(destinationPath.c_str());
  File output = fs.open(destinationPath.c_str(), FILE_WRITE);
  if (!output) {
    http.end();
    return fail(error, "Cannot create temporary content OTA file");
  }
  WiFiClient *stream = http.getStreamPtr();
  uint8_t buffer[4096];
  uint64_t written = 0;
  int remaining = advertised;
  uint32_t lastProgress = millis();
  bool success = true;
  while (http.connected() && (remaining > 0 || remaining == -1)) {
    const size_t available = stream->available();
    if (available == 0) {
      if (millis() - lastProgress > 15000) {
        success = false;
        error = "Content OTA stream timed out";
        break;
      }
      delay(2);
      continue;
    }
    const size_t requested = std::min(available, sizeof(buffer));
    const int count = stream->readBytes(buffer, requested);
    if (count <= 0 || written + count > maximumBytes ||
        output.write(buffer, count) != static_cast<size_t>(count)) {
      success = false;
      error = "Content OTA stream write failed or exceeded limit";
      break;
    }
    written += count;
    if (remaining > 0) {
      remaining -= count;
    }
    lastProgress = millis();
  }
  output.flush();
  output.close();
  http.end();
  if (advertised > 0 && written != static_cast<uint64_t>(advertised)) {
    success = false;
    error = "Content OTA response length changed during transfer";
  }
  if (!success || written == 0) {
    fs.remove(destinationPath.c_str());
    return false;
  }
  return true;
}

} // namespace inkos::paper

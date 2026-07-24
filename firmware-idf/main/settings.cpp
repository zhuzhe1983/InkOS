#include "settings.h"

#include <nvs.h>
#include <nvs_flash.h>

#include <esp_log.h>
#include <lwip/inet.h>
#include <lwip/sockets.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>

namespace inkos::idf {
namespace {

constexpr const char *kNamespace = "inkos";
constexpr const char *kTag = "inkos-settings";

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

std::string readString(nvs_handle_t handle, const char *key) {
  size_t size = 0;
  if (nvs_get_str(handle, key, nullptr, &size) != ESP_OK || size == 0 ||
      size > 2049) {
    return {};
  }
  std::string result(size - 1, '\0');
  if (nvs_get_str(handle, key, result.data(), &size) != ESP_OK) return {};
  return result;
}

bool writeString(nvs_handle_t handle, const char *key,
                 const std::string &value, std::string &error) {
  const esp_err_t status = nvs_set_str(handle, key, value.c_str());
  if (status != ESP_OK) {
    return fail(error, std::string("NVS write failed for ") + key + ": " +
                           esp_err_to_name(status));
  }
  return true;
}

bool containsUnsafeTextByte(const std::string &value) {
  return std::any_of(value.begin(), value.end(), [](char character) {
    const auto byte = static_cast<unsigned char>(character);
    return byte < 0x20 || byte == 0x7f;
  });
}

std::string trimAsciiWhitespace(const std::string &value) {
  size_t begin = 0;
  while (begin < value.size() &&
         std::isspace(static_cast<unsigned char>(value[begin]))) {
    ++begin;
  }
  size_t end = value.size();
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(value[end - 1]))) {
    --end;
  }
  return value.substr(begin, end - begin);
}

bool validDnsOrIpv4Host(const std::string &host) {
  if (host.empty() || host.size() > 253 || host.front() == '.' ||
      host.back() == '.') {
    return false;
  }
  size_t cursor = 0;
  while (cursor < host.size()) {
    const size_t dot = host.find('.', cursor);
    const size_t end = dot == std::string::npos ? host.size() : dot;
    const size_t bytes = end - cursor;
    if (bytes == 0 || bytes > 63 ||
        !std::isalnum(static_cast<unsigned char>(host[cursor])) ||
        !std::isalnum(static_cast<unsigned char>(host[end - 1]))) {
      return false;
    }
    for (size_t index = cursor; index < end; ++index) {
      const char character = host[index];
      if (!std::isalnum(static_cast<unsigned char>(character)) &&
          character != '-') {
        return false;
      }
    }
    if (dot == std::string::npos) break;
    cursor = dot + 1;
  }
  return true;
}

bool validBracketedIpv6Host(const std::string &host) {
  in6_addr parsed{};
  return !host.empty() && inet_pton(AF_INET6, host.c_str(), &parsed) == 1;
}

bool validPort(const std::string &port, std::string &error) {
  if (port.empty() || port.size() > 5 ||
      !std::all_of(port.begin(), port.end(), [](char character) {
        return std::isdigit(static_cast<unsigned char>(character));
      })) {
    return fail(error, "Renderer URL port is invalid");
  }
  const unsigned long parsed = std::strtoul(port.c_str(), nullptr, 10);
  if (parsed == 0 || parsed > 65535) {
    return fail(error, "Renderer URL port is outside 1..65535");
  }
  return true;
}

} // namespace

bool initializeSettingsStore(std::string &error) {
  esp_err_t status = nvs_flash_init();
  if (status == ESP_ERR_NVS_NO_FREE_PAGES ||
      status == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    status = nvs_flash_erase();
    if (status == ESP_OK) status = nvs_flash_init();
  }
  if (status != ESP_OK) {
    return fail(error, std::string("NVS initialization failed: ") +
                           esp_err_to_name(status));
  }
  return true;
}

bool loadSettings(DeviceSettings &settings, std::string &error) {
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (opened == ESP_ERR_NVS_NOT_FOUND) {
    settings = {};
    return true;
  }
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS open failed: ") +
                           esp_err_to_name(opened));
  }
  DeviceSettings loaded;
  loaded.wifiSsid = readString(handle, "wifi_ssid");
  loaded.wifiPassword = readString(handle, "wifi_pass");
  loaded.serverBaseUrl = readString(handle, "server_url");
  uint8_t orientationMode = 0;
  uint8_t manualOrientation = 0;
  int8_t fontLevel = 0;
  nvs_get_u8(handle, "orient_mode", &orientationMode);
  nvs_get_u8(handle, "orientation", &manualOrientation);
  nvs_get_i8(handle, "font_level", &fontLevel);
  // Inversion was removed from the PaperS3 client because the panel's dark
  // waveform was not stable enough for a persistent reading mode. Erase the
  // legacy key while loading so devices that once stored invert=true migrate
  // to the only supported state instead of reviving it on a later build.
  const esp_err_t legacyInvert = nvs_erase_key(handle, "invert");
  if (legacyInvert == ESP_OK) {
    const esp_err_t committed = nvs_commit(handle);
    if (committed != ESP_OK) {
      ESP_LOGW(kTag, "legacy inversion migration was not persisted: %s",
               esp_err_to_name(committed));
    }
  } else if (legacyInvert != ESP_ERR_NVS_NOT_FOUND) {
    // Inversion is ignored by this firmware, so a damaged legacy key must not
    // prevent the embedded home and configuration portal from starting.
    ESP_LOGW(kTag, "legacy inversion key could not be removed: %s",
             esp_err_to_name(legacyInvert));
  }
  nvs_close(handle);

  bool repaired = false;
  if (loaded.wifiSsid.size() > 32 ||
      containsUnsafeTextByte(loaded.wifiSsid)) {
    loaded.wifiSsid.clear();
    loaded.wifiPassword.clear();
    repaired = true;
  }
  if (loaded.wifiPassword.size() > 63 ||
      containsUnsafeTextByte(loaded.wifiPassword) ||
      (loaded.wifiSsid.empty() && !loaded.wifiPassword.empty())) {
    loaded.wifiPassword.clear();
    repaired = true;
  }
  if (!loaded.serverBaseUrl.empty()) {
    std::string normalized;
    std::string validationError;
    if (!validServerBaseUrl(loaded.serverBaseUrl, normalized,
                            validationError)) {
      ESP_LOGW(kTag, "discarding unsafe stored renderer URL: %s",
               validationError.c_str());
      loaded.serverBaseUrl.clear();
      repaired = true;
    } else if (normalized != loaded.serverBaseUrl) {
      loaded.serverBaseUrl = std::move(normalized);
      repaired = true;
    }
  }
  if (orientationMode > 1 || manualOrientation > 1 || fontLevel < -2 ||
      fontLevel > 2) {
    repaired = true;
  }
  loaded.orientationMode = orientationMode == 1 ? OrientationMode::Automatic
                                                 : OrientationMode::Manual;
  loaded.manualOrientation = manualOrientation == 1
                                 ? Orientation::Landscape
                                 : Orientation::Portrait;
  loaded.fontLevel = std::clamp<int8_t>(fontLevel, -2, 2);
  if (repaired) {
    std::string repairError;
    if (!saveSettings(loaded, repairError)) {
      // The sanitized in-memory values are still safe. A transient NVS write
      // problem should not turn recoverable user input into a boot failure.
      ESP_LOGW(kTag, "sanitized settings could not be persisted: %s",
               repairError.c_str());
    } else {
      ESP_LOGW(kTag, "repaired invalid persisted user settings");
    }
  }
  settings = std::move(loaded);
  error.clear();
  return true;
}

bool saveSettings(const DeviceSettings &settings, std::string &error) {
  if (settings.wifiSsid.size() > 32 || settings.wifiPassword.size() > 63 ||
      containsUnsafeTextByte(settings.wifiSsid) ||
      containsUnsafeTextByte(settings.wifiPassword) ||
      (settings.wifiSsid.empty() && !settings.wifiPassword.empty()) ||
      (settings.orientationMode != OrientationMode::Manual &&
       settings.orientationMode != OrientationMode::Automatic) ||
      (settings.manualOrientation != Orientation::Portrait &&
       settings.manualOrientation != Orientation::Landscape) ||
      settings.fontLevel < -2 || settings.fontLevel > 2) {
    return fail(error, "Settings are outside PaperS3 limits");
  }
  std::string normalized;
  if (!settings.serverBaseUrl.empty() &&
      !validServerBaseUrl(settings.serverBaseUrl, normalized, error)) {
    return false;
  }
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS open failed: ") +
                           esp_err_to_name(opened));
  }
  const esp_err_t legacyInvert = nvs_erase_key(handle, "invert");
  const bool legacyRemoved =
      legacyInvert == ESP_OK || legacyInvert == ESP_ERR_NVS_NOT_FOUND;
  bool ok = legacyRemoved &&
            writeString(handle, "wifi_ssid", settings.wifiSsid, error) &&
            writeString(handle, "wifi_pass", settings.wifiPassword, error) &&
            writeString(handle, "server_url", normalized, error) &&
            nvs_set_u8(handle, "orient_mode",
                       settings.orientationMode == OrientationMode::Automatic)
                    == ESP_OK &&
            nvs_set_u8(handle, "orientation",
                       settings.manualOrientation == Orientation::Landscape)
                    == ESP_OK &&
            nvs_set_i8(handle, "font_level", settings.fontLevel) == ESP_OK &&
            nvs_commit(handle) == ESP_OK;
  nvs_close(handle);
  if (!ok && error.empty()) error = "NVS commit failed";
  return ok;
}

bool clearNetworkSettings(std::string &error) {
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS open failed: ") +
                           esp_err_to_name(opened));
  }
  const esp_err_t ssid = nvs_erase_key(handle, "wifi_ssid");
  const esp_err_t pass = nvs_erase_key(handle, "wifi_pass");
  const esp_err_t server = nvs_erase_key(handle, "server_url");
  const esp_err_t committed = nvs_commit(handle);
  nvs_close(handle);
  const auto benign = [](esp_err_t value) {
    return value == ESP_OK || value == ESP_ERR_NVS_NOT_FOUND;
  };
  if (!benign(ssid) || !benign(pass) || !benign(server) ||
      committed != ESP_OK) {
    return fail(error, "Could not clear Wi-Fi/server settings");
  }
  return true;
}

bool validServerBaseUrl(const std::string &value, std::string &normalized,
                        std::string &error) {
  const std::string candidate = trimAsciiWhitespace(value);
  if (candidate.empty() || candidate.size() > 512 ||
      containsUnsafeTextByte(candidate) ||
      std::any_of(candidate.begin(), candidate.end(), [](char character) {
        return std::isspace(static_cast<unsigned char>(character));
      })) {
    return fail(error, "Renderer URL must be a non-empty HTTP(S) URL");
  }
  size_t schemeBytes = 0;
  if (candidate.rfind("http://", 0) == 0) {
    schemeBytes = 7;
  } else if (candidate.rfind("https://", 0) == 0) {
    schemeBytes = 8;
  } else {
    return fail(error, "Renderer URL must begin with http:// or https://");
  }
  const size_t authorityEnd = candidate.find_first_of("/?#", schemeBytes);
  const std::string authority = candidate.substr(
      schemeBytes, authorityEnd == std::string::npos
                       ? std::string::npos
                       : authorityEnd - schemeBytes);
  if (authority.empty() || authority.find('@') != std::string::npos) {
    return fail(error, "Renderer URL has an invalid host");
  }
  if (authorityEnd != std::string::npos) {
    const std::string suffix = candidate.substr(authorityEnd);
    if (suffix != "/") {
      return fail(error, "Renderer URL must not contain a path, query or fragment");
    }
  }

  if (authority.front() == '[') {
    const size_t close = authority.find(']');
    if (close == std::string::npos || close == 1 ||
        authority.find('[', 1) != std::string::npos ||
        authority.find(']', close + 1) != std::string::npos ||
        !validBracketedIpv6Host(authority.substr(1, close - 1))) {
      return fail(error, "Renderer URL has an invalid IPv6 host");
    }
    const std::string remainder = authority.substr(close + 1);
    if (!remainder.empty()) {
      if (remainder.front() != ':') {
        return fail(error, "Renderer URL port is invalid");
      }
      if (!validPort(remainder.substr(1), error)) return false;
    }
  } else {
    if (authority.find('[') != std::string::npos ||
        authority.find(']') != std::string::npos ||
        std::count(authority.begin(), authority.end(), ':') > 1) {
      return fail(error, "Renderer URL has an invalid host");
    }
    const size_t separator = authority.find(':');
    const std::string host = authority.substr(0, separator);
    if (!validDnsOrIpv4Host(host)) {
      return fail(error, "Renderer URL has an invalid host");
    }
    if (separator != std::string::npos &&
        !validPort(authority.substr(separator + 1), error)) {
      return false;
    }
  }

  normalized = candidate;
  if (normalized.back() == '/') normalized.pop_back();
  error.clear();
  return true;
}

} // namespace inkos::idf

#pragma once

#include "ink_types.h"

#include <string>

namespace inkos::idf {

bool initializeSettingsStore(std::string &error);
bool loadSettings(DeviceSettings &settings, std::string &error);
bool saveSettings(const DeviceSettings &settings, std::string &error);
bool clearNetworkSettings(std::string &error);
bool validServerBaseUrl(const std::string &value, std::string &normalized,
                        std::string &error);

} // namespace inkos::idf

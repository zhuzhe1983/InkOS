#include "runtime.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <string>

namespace {
constexpr const char *kTag = "inkos";
}

extern "C" void app_main(void) {
  static inkos::idf::InkRuntime runtime;
  std::string error;
  if (!runtime.begin(error)) {
    ESP_LOGE(kTag, "startup failed: %s", error.c_str());
  }
  while (true) {
    runtime.loop();
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

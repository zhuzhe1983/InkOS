set(INKOS_COMPONENT_REQUIRES
    m5unified
    json
    esp_event
    esp_http_client
    esp_http_server
    esp_partition
    esp_netif
    esp_psram
    esp_rom
    esp_timer
    esp_wifi
    lwip
    mbedtls
    nvs_flash
)

if(CONFIG_INKOS_RSS_SERIAL_HARNESS)
  list(APPEND INKOS_COMPONENT_REQUIRES esp_driver_usb_serial_jtag)
endif()

idf_component_register(
  SRCS
    "app_main.cpp"
    "display.cpp"
    "device_storage.cpp"
    "fast_text_pixel_policy.cpp"
    "frame_refresh_hint_policy.cpp"
    "http.cpp"
    "ink_archive.cpp"
    "ink_protocol.cpp"
    "jpeg_frame_policy.cpp"
    "navigation_observability.cpp"
    "png_frame_policy.cpp"
    "runtime.cpp"
    "settings.cpp"
    "wifi.cpp"
  INCLUDE_DIRS "include"
  REQUIRES ${INKOS_COMPONENT_REQUIRES}
)

set(EMBEDDED_HOME_VERIFY_STAMP
    "${CMAKE_CURRENT_BINARY_DIR}/embedded_home_verified.stamp")
add_custom_command(
  OUTPUT "${EMBEDDED_HOME_VERIFY_STAMP}"
  COMMAND "${PYTHON}" "${CMAKE_CURRENT_LIST_DIR}/../tools/verify_embedded_home.py"
          --archive "${CMAKE_CURRENT_LIST_DIR}/assets/home.ink"
          --metadata "${CMAKE_CURRENT_LIST_DIR}/assets/home.version.json"
  COMMAND "${CMAKE_COMMAND}" -E touch "${EMBEDDED_HOME_VERIFY_STAMP}"
  DEPENDS
    "${CMAKE_CURRENT_LIST_DIR}/assets/home.ink"
    "${CMAKE_CURRENT_LIST_DIR}/assets/home.version.json"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/verify_embedded_home.py"
  COMMENT "Verifying embedded PaperS3 home package"
  VERBATIM
)
add_custom_target(verify_embedded_home DEPENDS "${EMBEDDED_HOME_VERIFY_STAMP}")
add_dependencies(${COMPONENT_LIB} verify_embedded_home)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror=return-type)

target_add_binary_data(${COMPONENT_LIB} "assets/home.ink" BINARY)
target_add_binary_data(${COMPONENT_LIB} "assets/home.version.json" TEXT)

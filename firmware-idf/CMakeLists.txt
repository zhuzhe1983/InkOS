cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(inkos_papers3_idf VERSION 1.0.0)

# On-demand PaperS3 responses carry bounded base64url frame metadata and a
# sidecar in headers. Keep the parser ceiling slightly above the application's
# explicit 2 MiB aggregate-header limit; the 16 KiB socket buffer may stream
# one header through multiple reads.
idf_build_set_property(COMPILE_DEFINITIONS
  "HTTP_MAX_HEADER_SIZE=2359296" APPEND)

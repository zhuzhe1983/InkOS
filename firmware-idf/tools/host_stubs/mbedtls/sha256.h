#pragma once

#include <stddef.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

// parseOnDemandFrame does not hash data. This host-only stub allows the whole
// production parser translation unit to link without substituting parser code.
static inline int mbedtls_sha256(const unsigned char *input, size_t ilen,
                                 unsigned char output[32], int is224) {
  (void)input;
  (void)ilen;
  (void)is224;
  memset(output, 0, 32);
  return 0;
}

#ifdef __cplusplus
}
#endif

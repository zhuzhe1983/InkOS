#pragma once

#include <cJSON.h>

#include <cstddef>
#include <string>

namespace inkos::idf {

// cJSON's default parser accepts bytes after a valid JSON value and permits a
// much deeper recursive parse than the PaperS3 HTTP task stack can safely
// absorb. Scan strings/escapes iteratively first, then require the parser to
// consume the terminating NUL supplied by std::string::c_str().
inline cJSON *parseStrictBoundedJson(const std::string &json,
                                     size_t maximumDepth = 24) {
  if (json.empty() || maximumDepth == 0) return nullptr;
  size_t depth = 0;
  bool inString = false;
  bool escaped = false;
  for (size_t index = 0; index < json.size(); ++index) {
    const char character = json[index];
    const auto byte = static_cast<unsigned char>(character);
    if (inString) {
      if (escaped) {
        // cJSON stores decoded strings as NUL-terminated char buffers. Without
        // this guard, "safe\u0000hidden" would silently become "safe" before
        // field and allowlist validation.
        if (character == 'u' && index + 4 < json.size() &&
            json[index + 1] == '0' && json[index + 2] == '0' &&
            json[index + 3] == '0' && json[index + 4] == '0') {
          return nullptr;
        }
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        inString = false;
      } else if (byte < 0x20) {
        return nullptr;
      }
      continue;
    }
    if (character == '"') {
      inString = true;
    } else if (character == '{' || character == '[') {
      if (++depth > maximumDepth) return nullptr;
    } else if (character == '}' || character == ']') {
      if (depth == 0) return nullptr;
      --depth;
    } else if (byte == 0 || byte == 0x7f ||
               (byte < 0x20 && character != ' ' && character != '\t' &&
                character != '\r' && character != '\n')) {
      return nullptr;
    }
  }
  if (inString || escaped || depth != 0) return nullptr;
  const char *parseEnd = nullptr;
  return cJSON_ParseWithLengthOpts(json.c_str(), json.size() + 1, &parseEnd,
                                   true);
}

} // namespace inkos::idf

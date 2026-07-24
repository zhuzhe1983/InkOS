#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace inkos::idf {

enum class RssHarnessCommandResult {
  Ok,
  InvalidFormat,
  ChallengeMismatch,
};

inline bool isLowerHexToken(std::string_view value, size_t expectedBytes) {
  if (value.size() != expectedBytes) return false;
  for (const char character : value) {
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return true;
}

inline RssHarnessCommandResult
parseRssHarnessCommand(std::string_view line, std::string_view challenge,
                       std::string &runId) {
  constexpr std::string_view prefix = "INKOS_TEST/1 RSS_NAV ";
  constexpr size_t challengeBytes = 8;
  constexpr size_t runIdBytes = 16;
  constexpr size_t commandBytes =
      prefix.size() + challengeBytes + 1 + runIdBytes;

  runId.clear();
  if (line.size() != commandBytes || challenge.size() != challengeBytes ||
      line.compare(0, prefix.size(), prefix) != 0 ||
      line[prefix.size() + challengeBytes] != ' ') {
    return RssHarnessCommandResult::InvalidFormat;
  }
  const std::string_view suppliedChallenge =
      line.substr(prefix.size(), challengeBytes);
  const std::string_view suppliedRunId =
      line.substr(prefix.size() + challengeBytes + 1, runIdBytes);
  if (!isLowerHexToken(suppliedChallenge, challengeBytes) ||
      !isLowerHexToken(suppliedRunId, runIdBytes)) {
    return RssHarnessCommandResult::InvalidFormat;
  }
  if (suppliedChallenge != challenge) {
    return RssHarnessCommandResult::ChallengeMismatch;
  }
  runId.assign(suppliedRunId);
  return RssHarnessCommandResult::Ok;
}

} // namespace inkos::idf

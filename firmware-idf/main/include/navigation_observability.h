#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace inkos::idf {

// Stable, low-cardinality failure codes for serial navigation telemetry.
// Human-readable errors remain available to the local UI, but must not be
// copied into structured serial events because remote responses can contain
// private URLs or untrusted text.
enum class NavigationFailureCode : uint8_t {
  Unknown,
  NetworkUnavailable,
  AllocationFailed,
  SerializationFailed,
  TransportFailed,
  ResponseTooLarge,
  HeaderTooLarge,
  HttpStatus,
  ContentLengthMismatch,
  IntegrityMismatch,
  RevisionChanged,
  ContentTypeMismatch,
  JsonInvalid,
  ManifestInvalid,
  DocumentInvalid,
  SidecarInvalid,
  FrameInvalid,
  DisplayFailed,
  SourceInvalid,
  SourceJobFailed,
  SourceJobCancelled,
  SourceJobTimeout,
  LocalContentUnavailable,
  RequestInvalid,
};

const char *navigationFailureCodeName(NavigationFailureCode code);
NavigationFailureCode classifyNavigationFailure(std::string_view error);

enum class NavigationTargetKind : uint8_t {
  None,
  PackageDocument,
  SourceHttps,
  RssCollection,
  WebsiteCollection,
  ImageViewer,
  BaiduMap,
  Settings,
  OtherInternal,
  Invalid,
};

const char *navigationTargetKindName(NavigationTargetKind kind);
NavigationTargetKind classifyNavigationTarget(std::string_view targetUrl,
                                              std::string_view targetUuid);

// Only the finite server job states are emitted. Unknown/untrusted values are
// collapsed to "invalid" instead of being copied to the serial stream.
const char *safeSourceJobStatus(const char *status);

// Generator error codes are useful for diagnosis, but they originate in a
// remote JSON body. Emit one only when it is a bounded telemetry token.
std::string safeTelemetryCode(const char *code,
                              const char *fallback = "REMOTE_FAILURE");

} // namespace inkos::idf

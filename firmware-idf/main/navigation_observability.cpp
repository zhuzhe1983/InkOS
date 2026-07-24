#include "navigation_observability.h"

#include <algorithm>
#include <cctype>
#include <cstring>

namespace inkos::idf {
namespace {

bool contains(std::string_view value, std::string_view needle) {
  return value.find(needle) != std::string_view::npos;
}

std::string lowercase(std::string_view value) {
  std::string result(value);
  std::transform(result.begin(), result.end(), result.begin(), [](char value) {
    return static_cast<char>(
        std::tolower(static_cast<unsigned char>(value)));
  });
  return result;
}

} // namespace

const char *navigationFailureCodeName(NavigationFailureCode code) {
  switch (code) {
  case NavigationFailureCode::NetworkUnavailable:
    return "NETWORK_UNAVAILABLE";
  case NavigationFailureCode::AllocationFailed:
    return "ALLOCATION_FAILED";
  case NavigationFailureCode::SerializationFailed:
    return "SERIALIZATION_FAILED";
  case NavigationFailureCode::TransportFailed:
    return "TRANSPORT_FAILED";
  case NavigationFailureCode::ResponseTooLarge:
    return "RESPONSE_TOO_LARGE";
  case NavigationFailureCode::HeaderTooLarge:
    return "HEADER_TOO_LARGE";
  case NavigationFailureCode::HttpStatus:
    return "HTTP_STATUS";
  case NavigationFailureCode::ContentLengthMismatch:
    return "CONTENT_LENGTH_MISMATCH";
  case NavigationFailureCode::IntegrityMismatch:
    return "INTEGRITY_MISMATCH";
  case NavigationFailureCode::RevisionChanged:
    return "REVISION_CHANGED";
  case NavigationFailureCode::ContentTypeMismatch:
    return "CONTENT_TYPE_MISMATCH";
  case NavigationFailureCode::JsonInvalid:
    return "JSON_INVALID";
  case NavigationFailureCode::ManifestInvalid:
    return "MANIFEST_INVALID";
  case NavigationFailureCode::DocumentInvalid:
    return "DOCUMENT_INVALID";
  case NavigationFailureCode::SidecarInvalid:
    return "SIDECAR_INVALID";
  case NavigationFailureCode::FrameInvalid:
    return "FRAME_INVALID";
  case NavigationFailureCode::DisplayFailed:
    return "DISPLAY_FAILED";
  case NavigationFailureCode::SourceInvalid:
    return "SOURCE_INVALID";
  case NavigationFailureCode::SourceJobFailed:
    return "SOURCE_JOB_FAILED";
  case NavigationFailureCode::SourceJobCancelled:
    return "SOURCE_JOB_CANCELLED";
  case NavigationFailureCode::SourceJobTimeout:
    return "SOURCE_JOB_TIMEOUT";
  case NavigationFailureCode::LocalContentUnavailable:
    return "LOCAL_CONTENT_UNAVAILABLE";
  case NavigationFailureCode::RequestInvalid:
    return "REQUEST_INVALID";
  case NavigationFailureCode::Unknown:
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

NavigationFailureCode classifyNavigationFailure(std::string_view error) {
  if (error.empty()) return NavigationFailureCode::Unknown;
  const std::string value = lowercase(error);

  if (contains(value, "source generation timed out")) {
    return NavigationFailureCode::SourceJobTimeout;
  }
  if (contains(value, "source generation failed") ||
      contains(value, "source generation did not complete")) {
    return NavigationFailureCode::SourceJobFailed;
  }
  if (contains(value, "source generation cancelled") ||
      contains(value, "source job cancelled")) {
    return NavigationFailureCode::SourceJobCancelled;
  }
  if (contains(value, "requires the configured server") ||
      contains(value, "requires an online renderer") ||
      contains(value, "renderer service is not connected")) {
    return NavigationFailureCode::NetworkUnavailable;
  }
  if (contains(value, "cannot allocate")) {
    return NavigationFailureCode::AllocationFailed;
  }
  if (contains(value, "cannot serialize")) {
    return NavigationFailureCode::SerializationFailed;
  }
  if (contains(value, "response headers exceed")) {
    return NavigationFailureCode::HeaderTooLarge;
  }
  if (contains(value, "response exceeds")) {
    return NavigationFailureCode::ResponseTooLarge;
  }
  if (contains(value, "content-length")) {
    return NavigationFailureCode::ContentLengthMismatch;
  }
  if (contains(value, "transport failed") ||
      contains(value, "esp_http_client_init failed")) {
    return NavigationFailureCode::TransportFailed;
  }
  if (contains(value, "http status") ||
      contains(value, "http/integrity failure")) {
    return NavigationFailureCode::HttpStatus;
  }
  if (contains(value, "package_revision_changed") ||
      contains(value, "kept changing") ||
      contains(value, "revision boundary")) {
    return NavigationFailureCode::RevisionChanged;
  }
  if (contains(value, "sha-256") || contains(value, "etag") ||
      contains(value, "identity headers") ||
      contains(value, "lineage/headers")) {
    return NavigationFailureCode::IntegrityMismatch;
  }
  if (contains(value, "content-type") ||
      contains(value, "content type")) {
    return NavigationFailureCode::ContentTypeMismatch;
  }
  if (contains(value, "invalid json")) {
    return NavigationFailureCode::JsonInvalid;
  }
  if (contains(value, "source url") ||
      contains(value, "resolved source") ||
      contains(value, "source job has no status url")) {
    return NavigationFailureCode::SourceInvalid;
  }
  if (contains(value, "manifest")) {
    return NavigationFailureCode::ManifestInvalid;
  }
  if (contains(value, "document") || contains(value, "target uuid")) {
    return NavigationFailureCode::DocumentInvalid;
  }
  if (contains(value, "sidecar")) {
    return NavigationFailureCode::SidecarInvalid;
  }
  if (contains(value, "frame") || contains(value, "png") ||
      contains(value, "display tuple") ||
      contains(value, "target page")) {
    return NavigationFailureCode::FrameInvalid;
  }
  if (contains(value, "display")) {
    return NavigationFailureCode::DisplayFailed;
  }
  if (contains(value, "local home") ||
      contains(value, "uploaded home") ||
      contains(value, "mapped")) {
    return NavigationFailureCode::LocalContentUnavailable;
  }
  if (contains(value, "invalid url") ||
      contains(value, "outside the configured") ||
      contains(value, "not in the exact client whitelist")) {
    return NavigationFailureCode::RequestInvalid;
  }
  return NavigationFailureCode::Unknown;
}

const char *navigationTargetKindName(NavigationTargetKind kind) {
  switch (kind) {
  case NavigationTargetKind::PackageDocument:
    return "package-document";
  case NavigationTargetKind::SourceHttps:
    return "https-source";
  case NavigationTargetKind::RssCollection:
    return "rss-collection";
  case NavigationTargetKind::WebsiteCollection:
    return "website-collection";
  case NavigationTargetKind::ImageViewer:
    return "image-viewer";
  case NavigationTargetKind::BaiduMap:
    return "baidu-map";
  case NavigationTargetKind::Settings:
    return "settings";
  case NavigationTargetKind::OtherInternal:
    return "internal";
  case NavigationTargetKind::Invalid:
    return "invalid";
  case NavigationTargetKind::None:
    return "none";
  }
  return "invalid";
}

NavigationTargetKind classifyNavigationTarget(std::string_view targetUrl,
                                              std::string_view targetUuid) {
  if (targetUrl.empty()) {
    return targetUuid.empty() ? NavigationTargetKind::None
                              : NavigationTargetKind::PackageDocument;
  }
  if (targetUrl == "inkos://collection/rss") {
    return NavigationTargetKind::RssCollection;
  }
  if (targetUrl == "inkos://collection/website" ||
      targetUrl == "inkos://collection/other") {
    return NavigationTargetKind::WebsiteCollection;
  }
  if (targetUrl == "inkos://app/random-image") {
    return NavigationTargetKind::ImageViewer;
  }
  if (targetUrl == "inkos://app/baidu-map") {
    return NavigationTargetKind::BaiduMap;
  }
  if (targetUrl == "inkos://device/settings") {
    return NavigationTargetKind::Settings;
  }
  if (targetUrl.rfind("https://", 0) == 0) {
    return NavigationTargetKind::SourceHttps;
  }
  if (targetUrl.rfind("inkos://", 0) == 0) {
    return NavigationTargetKind::OtherInternal;
  }
  return NavigationTargetKind::Invalid;
}

const char *safeSourceJobStatus(const char *status) {
  if (!status) return "invalid";
  for (const char *allowed :
       {"queued", "running", "complete", "failed", "cancelled"}) {
    if (std::strcmp(status, allowed) == 0) return allowed;
  }
  return "invalid";
}

std::string safeTelemetryCode(const char *code, const char *fallback) {
  const std::string safeFallback =
      fallback && fallback[0] != '\0' ? fallback : "REMOTE_FAILURE";
  if (!code) return safeFallback;
  const size_t length = std::strlen(code);
  if (length == 0 || length > 48) return safeFallback;
  for (size_t index = 0; index < length; ++index) {
    const unsigned char value = static_cast<unsigned char>(code[index]);
    if (!(value == '_' || (value >= 'A' && value <= 'Z') ||
          (value >= '0' && value <= '9'))) {
      return safeFallback;
    }
  }
  return std::string(code, length);
}

} // namespace inkos::idf

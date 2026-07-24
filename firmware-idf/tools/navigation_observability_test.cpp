#include "navigation_observability.h"

#include <cassert>
#include <string>

using inkos::idf::NavigationFailureCode;
using inkos::idf::NavigationTargetKind;
using inkos::idf::classifyNavigationFailure;
using inkos::idf::classifyNavigationTarget;
using inkos::idf::navigationFailureCodeName;
using inkos::idf::navigationTargetKindName;
using inkos::idf::safeSourceJobStatus;
using inkos::idf::safeTelemetryCode;

int main() {
  assert(classifyNavigationFailure(
             "Source generation timed out after 180 seconds") ==
         NavigationFailureCode::SourceJobTimeout);
  assert(classifyNavigationFailure(
             "Source generation failed: upstream refused") ==
         NavigationFailureCode::SourceJobFailed);
  assert(classifyNavigationFailure(
             "Source generation cancelled") ==
         NavigationFailureCode::SourceJobCancelled);
  assert(classifyNavigationFailure(
             "HTTP Content-Length does not match received bytes") ==
         NavigationFailureCode::ContentLengthMismatch);
  assert(classifyNavigationFailure(
             "HTTP transport failed: ESP_ERR_HTTP_CONNECT") ==
         NavigationFailureCode::TransportFailed);
  assert(classifyNavigationFailure("PACKAGE_REVISION_CHANGED") ==
         NavigationFailureCode::RevisionChanged);
  assert(classifyNavigationFailure(
             "Collection PNG failed ETag/SHA-256 verification") ==
         NavigationFailureCode::IntegrityMismatch);
  assert(classifyNavigationFailure(
             "Target UUID is absent from the manifest") ==
         NavigationFailureCode::ManifestInvalid);
  assert(std::string(navigationFailureCodeName(
             NavigationFailureCode::SidecarInvalid)) == "SIDECAR_INVALID");

  assert(classifyNavigationTarget("inkos://collection/rss", {}) ==
         NavigationTargetKind::RssCollection);
  assert(classifyNavigationTarget("inkos://collection/website", {}) ==
         NavigationTargetKind::WebsiteCollection);
  assert(classifyNavigationTarget("https://private.example/feed?token=secret",
                                  {}) ==
         NavigationTargetKind::SourceHttps);
  assert(classifyNavigationTarget({}, "document-uuid") ==
         NavigationTargetKind::PackageDocument);
  assert(classifyNavigationTarget("http://unsafe.example", {}) ==
         NavigationTargetKind::Invalid);
  assert(std::string(navigationTargetKindName(
             NavigationTargetKind::SourceHttps)) == "https-source");

  assert(std::string(safeSourceJobStatus("queued")) == "queued");
  assert(std::string(safeSourceJobStatus("running")) == "running");
  assert(std::string(safeSourceJobStatus("complete")) == "complete");
  assert(std::string(safeSourceJobStatus("failed\nurl=https://secret")) ==
         "invalid");

  assert(safeTelemetryCode("FETCH_FAILED") == "FETCH_FAILED");
  assert(safeTelemetryCode("SOURCE_UNREACHABLE") == "SOURCE_UNREACHABLE");
  assert(safeTelemetryCode("fetch_failed") == "REMOTE_FAILURE");
  assert(safeTelemetryCode("FETCH_FAILED\nhttps://secret") ==
         "REMOTE_FAILURE");
  assert(safeTelemetryCode(
             "THIS_CODE_IS_DELIBERATELY_LONGER_THAN_FORTY_EIGHT_CHARACTERS") ==
         "REMOTE_FAILURE");
  return 0;
}

#include <Arduino.h>
#include <SD.h>
#include <M5Unified.h>

#include "content_store.h"
#include "clock_runtime.h"
#include "network_adapter.h"
#include "package_catalog.h"
#include "papers3_hal.h"

#include <InkNavigation.h>

#include <memory>

#ifndef INKOS_WIFI_SSID
#define INKOS_WIFI_SSID ""
#endif
#ifndef INKOS_WIFI_PASSWORD
#define INKOS_WIFI_PASSWORD ""
#endif
#ifndef INKOS_PACKAGE_URL
#define INKOS_PACKAGE_URL ""
#endif
#ifndef INKOS_PACKAGE_SHA256
#define INKOS_PACKAGE_SHA256 ""
#endif
#ifndef INKOS_PACKAGE_BYTES
#define INKOS_PACKAGE_BYTES 0
#endif
#ifndef INKOS_ROOT_CA
#define INKOS_ROOT_CA ""
#endif

namespace {

using inkos::NavigationAction;
using inkos::NavigationCore;
using inkos::TransitionKind;
using namespace inkos::paper;

PaperS3Display display;
PaperS3Touch touch;
ContentStore contentStore;
SettingsStore settingsStore;
RuntimeStateStore runtimeStore;
NetworkAdapter network;
ClockRuntime clockRuntime;
PackageCatalog catalog;
DisplaySettings settings;
DisplaySettings pendingSettings;
FrameSidecar activeSidecar;
std::unique_ptr<NavigationCore> navigation;
bool settingsOpen = false;
bool applicationReady = false;

void logError(const char *context, const std::string &error) {
  Serial.printf("[InkOS] %s: %s\n", context, error.c_str());
}

void activateDynamicRegions() {
  std::string warning;
  clockRuntime.activate(activeSidecar, display, network, INKOS_WIFI_SSID,
                        INKOS_WIFI_PASSWORD, warning);
  if (!warning.empty()) {
    logError("local clock fallback retained", warning);
  }
}

bool readDigestFile(const char *path, std::string &digest) {
  File file = SD.open(path, FILE_READ);
  if (!file || file.isDirectory() || file.size() > 256) {
    if (file) {
      file.close();
    }
    return false;
  }
  String value = file.readStringUntil('\n');
  file.close();
  value.trim();
  digest = value.c_str();
  return digest.size() == 64;
}

bool selectConfiguredVariant(PackageCatalog &target, std::string &error) {
  return target.selectExactVariant(settings, error);
}

bool probeStagedEntry(StagedPackage &staged, std::string &error) {
  if (!staged.catalog.selectExactVariant(settings, error)) {
    return false;
  }
  const DisplayVariant *variant = staged.catalog.activeVariant();
  const FrameRef *frame = staged.catalog.frame(staged.catalog.entryUuid(), 0);
  if (!variant || !frame) {
    error = "Staged package has no selected entry frame";
    return false;
  }
  if (!display.probeFrame(
          contentStore.filesystem(),
          joinPath(staged.catalog.rootPath(), frame->imagePath), *variant,
          error)) {
    return false;
  }
  staged.entryDecoded = true;
  return true;
}

bool installArchive(const std::string &archivePath,
                    const std::string &expectedSha, uint64_t expectedBytes,
                    std::string &error) {
  StagedPackage staged;
  if (!contentStore.stageArchive(archivePath, expectedSha, expectedBytes, staged,
                                 error) ||
      !probeStagedEntry(staged, error)) {
    contentStore.discardStaging();
    return false;
  }

  char previousSlot = contentStore.activeSlot();
  if (!contentStore.commitStaged(staged, previousSlot, error)) {
    return false;
  }

  PackageCatalog activated;
  if (!contentStore.loadActive(activated, error) ||
      !activated.selectExactVariant(settings, error)) {
    std::string rollbackError;
    contentStore.rollbackTo(previousSlot, rollbackError);
    if (!rollbackError.empty()) {
      error += "; rollback: " + rollbackError;
    }
    return false;
  }

  const DisplayVariant *variant = activated.activeVariant();
  const FrameRef *frame = activated.frame(activated.entryUuid(), 0);
  if (!variant || !frame ||
      !display.showFrame(contentStore.filesystem(),
                         joinPath(activated.rootPath(), frame->imagePath),
                         *variant, error)) {
    std::string rollbackError;
    contentStore.rollbackTo(previousSlot, rollbackError);
    if (!rollbackError.empty()) {
      error += "; rollback: " + rollbackError;
    }
    return false;
  }
  catalog = std::move(activated);
  return true;
}

void installOfflineInboxIfPresent() {
  static constexpr const char *archivePath = "/inkos/inbox/update.ink";
  if (!SD.exists(archivePath)) {
    return;
  }
  std::string digest;
  readDigestFile("/inkos/inbox/update.ink.sha256", digest);
  std::string error;
  if (!installArchive(archivePath, digest, 0, error)) {
    logError("offline content OTA rejected", error);
    return;
  }
  SD.remove("/inkos/inbox/update.applied");
  SD.rename(archivePath, "/inkos/inbox/update.applied");
  SD.remove("/inkos/inbox/update.ink.sha256");
  Serial.println("[InkOS] offline content OTA activated");
}

void installOnlinePackageIfConfigured() {
  if (settings.offline || INKOS_PACKAGE_URL[0] == '\0') {
    return;
  }
  if (INKOS_PACKAGE_SHA256[0] == '\0') {
    logError("online content OTA skipped",
             "INKOS_PACKAGE_SHA256 is required for remote activation");
    return;
  }
  std::string error;
  if (!network.connect(INKOS_WIFI_SSID, INKOS_WIFI_PASSWORD, 15000, error)) {
    logError("online content OTA Wi-Fi", error);
    return;
  }
  static constexpr const char *temporary = "/inkos/incoming.tmp";
  if (!network.download(contentStore.filesystem(), INKOS_PACKAGE_URL, temporary,
                        128ULL * 1024ULL * 1024ULL, INKOS_ROOT_CA, error) ||
      !installArchive(temporary, INKOS_PACKAGE_SHA256, INKOS_PACKAGE_BYTES,
                      error)) {
    logError("online content OTA rejected", error);
  } else {
    Serial.println("[InkOS] online content OTA activated");
  }
  SD.remove(temporary);
}

bool renderCandidate(NavigationCore &candidate, FrameSidecar &loadedSidecar,
                     std::string &error) {
  if (!candidate.ready()) {
    error = "Navigation candidate is not ready";
    return false;
  }
  const auto &state = candidate.state();
  if (!catalog.loadActiveSidecar(state.documentUuid, state.pageIndex,
                                 loadedSidecar, error) ||
      loadedSidecar.documentUuid != state.documentUuid ||
      loadedSidecar.pageIndex != state.pageIndex) {
    if (error.empty()) {
      error = "STALE_FRAME: sidecar does not describe candidate state";
    }
    return false;
  }
  const DisplayVariant *variant = catalog.activeVariant();
  const FrameRef *frame = catalog.frame(state.documentUuid, state.pageIndex);
  if (!variant || !frame) {
    error = "Candidate frame or display variant is unavailable";
    return false;
  }
  return display.showFrame(contentStore.filesystem(),
                           joinPath(catalog.rootPath(), frame->imagePath),
                           *variant, error);
}

void persistSuccessfulFrame() {
  const auto &state = navigation->state();
  if (!runtimeStore.save({catalog.packageId(), state.documentUuid,
                          state.pageIndex})) {
    Serial.println("[InkOS] warning: runtime position was not persisted");
  }
}

bool openInitialFrame(std::string &error) {
  if (!selectConfiguredVariant(catalog, error)) {
    return false;
  }
  navigation = std::make_unique<NavigationCore>(catalog);
  const RuntimePosition saved = runtimeStore.load();
  const bool restored = saved.packageId == catalog.packageId() &&
                        navigation->resetTo(saved.documentUuid, saved.pageIndex);
  if (!restored && !navigation->reset(catalog.entryUuid())) {
    error = "Cannot initialize package entry navigation state";
    return false;
  }
  FrameSidecar sidecar;
  if (!renderCandidate(*navigation, sidecar, error)) {
    return false;
  }
  activeSidecar = std::move(sidecar);
  persistSuccessfulFrame();
  return true;
}

void executeNavigation(InputType input, int32_t x, int32_t y) {
  if (!applicationReady || !navigation) {
    return;
  }
  if (activeSidecar.documentUuid != navigation->state().documentUuid ||
      activeSidecar.pageIndex != navigation->state().pageIndex) {
    logError("navigation rejected",
             "STALE_FRAME: sidecar does not describe active state");
    return;
  }
  auto candidate = std::make_unique<NavigationCore>(*navigation);
  inkos::Transition transition;
  switch (input) {
  case InputType::SwipeLeft:
    transition = candidate->dispatch(NavigationAction::SwipeLeft);
    break;
  case InputType::SwipeUp:
    transition = candidate->dispatch(NavigationAction::SwipeUp);
    break;
  case InputType::SwipeDown:
    transition = candidate->dispatch(NavigationAction::SwipeDown);
    break;
  case InputType::Tap:
    transition = candidate->tap(x, y, activeSidecar.interactions);
    break;
  default:
    return;
  }
  if (transition.kind == TransitionKind::Noop) {
    return;
  }
  FrameSidecar candidateSidecar;
  std::string error;
  if (!renderCandidate(*candidate, candidateSidecar, error)) {
    logError("navigation retained previous frame", error);
    return;
  }
  navigation = std::move(candidate);
  activeSidecar = std::move(candidateSidecar);
  persistSuccessfulFrame();
  activateDynamicRegions();
}

bool applyPendingSettings(std::string &error) {
  if (pendingSettings.fontLevel == settings.fontLevel &&
      pendingSettings.invert == settings.invert) {
    auto candidate = std::make_unique<NavigationCore>(*navigation);
    FrameSidecar candidateSidecar;
    if (!renderCandidate(*candidate, candidateSidecar, error)) {
      return false;
    }
    settings = pendingSettings;
    navigation = std::move(candidate);
    activeSidecar = std::move(candidateSidecar);
    if (!settingsStore.save(settings)) {
      Serial.println("[InkOS] warning: display settings were not persisted");
    }
    persistSuccessfulFrame();
    activateDynamicRegions();
    return true;
  }
  if (!catalog.selectExactVariant(pendingSettings, error)) {
    return false;
  }
  auto candidate = std::make_unique<NavigationCore>(*navigation);
  if (!candidate->reconcileCatalog()) {
    catalog.selectExactVariant(settings, error);
    error = "VARIANT_UNAVAILABLE for active document";
    return false;
  }
  FrameSidecar candidateSidecar;
  if (!renderCandidate(*candidate, candidateSidecar, error)) {
    std::string restoreError;
    catalog.selectExactVariant(settings, restoreError);
    if (!restoreError.empty()) {
      error += "; restore: " + restoreError;
    }
    return false;
  }
  settings = pendingSettings;
  navigation = std::move(candidate);
  activeSidecar = std::move(candidateSidecar);
  if (!settingsStore.save(settings)) {
    Serial.println("[InkOS] warning: display settings were not persisted");
  }
  persistSuccessfulFrame();
  activateDynamicRegions();
  return true;
}

void handleSettings(const InputEvent &event) {
  if (event.type == InputType::LongPress) {
    std::string error;
    if (applyPendingSettings(error)) {
      settingsOpen = false;
    } else {
      logError("settings unchanged", error);
      pendingSettings = settings;
      display.showSettings(pendingSettings, catalog.title());
    }
    return;
  }
  if (event.type != InputType::Tap) {
    return;
  }
  const int32_t row = (event.y - 132) / 96;
  if (event.y < 132 || row < 0 || row > 2) {
    return;
  }
  if (row == 0) {
    pendingSettings.fontLevel =
        pendingSettings.fontLevel == 2 ? -2 : pendingSettings.fontLevel + 1;
  } else if (row == 1) {
    pendingSettings.invert = !pendingSettings.invert;
  } else {
    pendingSettings.offline = !pendingSettings.offline;
  }
  display.showSettings(pendingSettings, catalog.title());
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.printf("[InkOS] PaperS3 client %s starting\n", kClientVersion);

  std::string error;
  if (!display.begin(error)) {
    logError("PaperS3 initialization", error);
    return;
  }
  if (!settingsStore.begin(settings) || !runtimeStore.begin()) {
    display.showStatus("InkOS settings error", "NVS preferences unavailable");
    return;
  }
  if (!contentStore.begin(error)) {
    display.showStatus("InkOS storage error", error);
    return;
  }

  installOfflineInboxIfPresent();
  installOnlinePackageIfConfigured();

  if (!contentStore.loadActive(catalog, error) || !openInitialFrame(error)) {
    logError("no usable package", error);
    display.showStatus(
        "No verified InkOS package",
        "Copy update.ink (and optionally update.ink.sha256) to "
        "/inkos/inbox/ on a FAT32 microSD card, then restart.");
    return;
  }
  applicationReady = true;
  activateDynamicRegions();
  Serial.printf("[InkOS] active package %s revision %lu\n",
                catalog.packageId().c_str(),
                static_cast<unsigned long>(catalog.revision()));
}

void loop() {
  if (!applicationReady) {
    M5.update();
    delay(20);
    return;
  }
  const InputEvent event = touch.poll(display.width(), display.height());
  if (event.type == InputType::None) {
    if (!settingsOpen && !touch.active()) {
      std::string error;
      if (!clockRuntime.tick(display, error)) {
        logError("local clock refresh", error);
      }
    }
    delay(5);
    return;
  }
  if (settingsOpen) {
    handleSettings(event);
    return;
  }
  if (event.type == InputType::LongPress) {
    clockRuntime.stop(display);
    pendingSettings = settings;
    settingsOpen = true;
    display.showSettings(pendingSettings, catalog.title());
    return;
  }
  executeNavigation(event.type, event.x, event.y);
}

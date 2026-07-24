#pragma once

#include "display.h"
#include "device_storage.h"
#include "http.h"
#include "ink_archive.h"
#include "ink_protocol.h"
#include "ink_types.h"
#include "wifi.h"

#include <string>
#include <vector>

#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
#include <array>
#include <cstddef>
#endif

namespace inkos::idf {

class InkRuntime {
public:
  bool begin(std::string &error);
  void loop();

private:
  bool loadEmbeddedHome(FrameTransaction &result, std::string &error);
  bool loadEmbedded(const std::string &documentUuid, uint16_t pageIndex,
                    const DisplayMeta &meta, FrameTransaction &result,
                    std::string &error);
  bool loadStoredHome(FrameTransaction &result, std::string &error);
  bool loadStored(const std::string &documentUuid, uint16_t pageIndex,
                  const DisplayMeta &meta, FrameTransaction &result,
                  std::string &error);
  bool loadPackaged(InkArchive &archive, const Manifest &manifest,
                    const std::string &documentUuid, uint16_t pageIndex,
                    const DisplayMeta &meta, bool embedded, bool stored,
                    FrameTransaction &result, std::string &error);
  bool activateLatestStoredHome(std::string &error);
  bool activateEmbeddedHome(std::string &error);
  bool renderCollection(CollectionKind kind, uint16_t pageIndex,
                        const DisplayMeta &meta, FrameTransaction &result,
                        std::string &error);
  bool renderApp(const std::string &action, uint16_t pageIndex,
                 const DisplayMeta &meta, FrameTransaction &result,
                 bool freshIdentity,
                 std::string &error);
  bool fetchManifest(const std::string &packageId, Manifest &result,
                     bool cacheBypass, std::string &error);
  bool loadOnline(const std::string &packageId, const std::string &documentUuid,
                  uint16_t pageIndex, const DisplayMeta &meta,
                  FrameTransaction &result, std::string &error,
                  uint8_t revisionRetriesRemaining = 3,
                  const Manifest *verifiedManifest = nullptr);
  bool renderOnline(const Manifest &manifest, const DocumentRef &document,
                    uint64_t documentRevision, uint16_t pageIndex,
                    const DisplayMeta &meta,
                    FrameTransaction &result, bool &revisionChanged,
                    std::string &error);
  bool activate(FrameTransaction &&transaction, const Location &location,
                bool recordHistory, std::string &error);
  bool navigateTo(const Location &location, bool recordHistory,
                  std::string &error, const char *cause = "runtime-refresh");
  bool resolveSource(const std::string &url, Location &location,
                     std::string &error);
  void handleInput(const InputEvent &event);
  void openSettings();
  void handleSettingsInput(const InputEvent &event);
  bool applySettings(std::string &error);
  void resetClockPaintState();
  void tickClock();
  void tickOrientation();
  void configureNetwork();
  DisplayMeta displayMeta() const;
  const DisplayVariant *activeVariant() const;

#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
  bool initializeRssSerialHarness(std::string &error);
  bool pollRssSerialHarness();
  bool runRssSerialHarness(const std::string &runId);

  std::array<char, 96> rssHarnessLine_{};
  size_t rssHarnessLineBytes_ = 0;
  bool rssHarnessDiscardLine_ = false;
  bool rssHarnessArmed_ = false;
  std::string rssHarnessChallenge_;
#endif

  PaperS3Display display_;
  HttpClient http_;
  CaptivePortal portal_;
  InkArchive embeddedArchive_;
  Manifest embeddedManifest_;
  StoredHomeMapping storedMapping_;
  InkArchive storedArchive_;
  Manifest storedManifest_;
  DeviceCollections collections_;
  FrameTransaction active_;
  Location location_;
  std::vector<Location> backHistory_;
  std::vector<Location> forwardHistory_;
  DeviceSettings settings_;
  DeviceSettings settingsDraft_;
  bool settingsOpen_ = false;
  bool initialized_ = false;
  bool networkReady_ = false;
  int64_t nextReconnectUs_ = 0;
  std::vector<int64_t> clockNextUs_;
  std::vector<std::string> clockValues_;
  std::string activeAppAction_;
  std::string activeAppNonce_;
  uint64_t activeAppRequestedAtMs_ = 0;
  uint32_t navigationSequence_ = 0;
  uint32_t sourceSequence_ = 0;
};

} // namespace inkos::idf

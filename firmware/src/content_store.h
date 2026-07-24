#pragma once

#include "package_catalog.h"

#include <Preferences.h>
#include <SD.h>
#include <SPI.h>

#include <cstdint>
#include <string>

namespace inkos::paper {

struct StagedPackage {
  char targetSlot = 'b';
  PackageCatalog catalog;
  bool ready = false;
  bool entryDecoded = false;
};

class ContentStore {
public:
  bool begin(std::string &error);
  fs::FS &filesystem() { return SD; }

  bool loadActive(PackageCatalog &catalog, std::string &error);
  bool stageArchive(const std::string &archivePath,
                    const std::string &expectedSha256,
                    uint64_t expectedBytes, StagedPackage &staged,
                    std::string &error);
  bool commitStaged(StagedPackage &staged, char &previousSlot,
                    std::string &error);
  bool rollbackTo(char previousSlot, std::string &error);
  void discardStaging();

  char activeSlot() const { return activeSlot_; }
  std::string activeRoot() const;
  std::string slotRoot(char slot) const;

private:
  bool extractArchive(const std::string &archivePath,
                      const std::string &destinationRoot,
                      std::string &error);
  bool setActiveSlot(char slot, std::string &error);

  Preferences preferences_;
  char activeSlot_ = 'a';
  bool started_ = false;
};

class SettingsStore {
public:
  bool begin(DisplaySettings &settings);
  bool save(const DisplaySettings &settings);

private:
  Preferences preferences_;
  bool started_ = false;
};

struct RuntimePosition {
  std::string packageId;
  std::string documentUuid;
  uint16_t pageIndex = 0;
};

class RuntimeStateStore {
public:
  bool begin();
  RuntimePosition load() const;
  bool save(const RuntimePosition &position);

private:
  mutable Preferences preferences_;
  bool started_ = false;
};

} // namespace inkos::paper

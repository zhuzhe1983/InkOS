#include "content_store.h"

#include <miniz.h>

#include <algorithm>
#include <cstring>
#include <vector>

namespace inkos::paper {
namespace {

constexpr uint8_t kSdCs = 47;
constexpr uint8_t kSdClock = 39;
constexpr uint8_t kSdMosi = 38;
constexpr uint8_t kSdMiso = 40;
constexpr uint32_t kSdFrequency = 25000000;

constexpr uint64_t kMaxArchiveBytes = 128ULL * 1024ULL * 1024ULL;
constexpr uint64_t kMaxExpandedBytes = 512ULL * 1024ULL * 1024ULL;
constexpr uint64_t kMaxEntryBytes = 32ULL * 1024ULL * 1024ULL;
constexpr uint32_t kMaxEntries = 8192;

const std::string kBase = "/inkos";
const std::string kSlots = "/inkos/slots";
const std::string kStaging = "/inkos/staging";
const std::string kInbox = "/inkos/inbox";

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

bool ensureDirectory(fs::FS &fs, const std::string &path) {
  if (path.empty() || path == "/") {
    return true;
  }
  File existing = fs.open(path.c_str(), FILE_READ);
  if (existing) {
    const bool directory = existing.isDirectory();
    existing.close();
    return directory;
  }
  const size_t separator = path.find_last_of('/');
  if (separator != std::string::npos && separator > 0 &&
      !ensureDirectory(fs, path.substr(0, separator))) {
    return false;
  }
  return fs.mkdir(path.c_str());
}

bool removeTree(fs::FS &fs, const std::string &path) {
  File entry = fs.open(path.c_str(), FILE_READ);
  if (!entry) {
    return true;
  }
  if (!entry.isDirectory()) {
    entry.close();
    return fs.remove(path.c_str());
  }
  File child = entry.openNextFile();
  while (child) {
    const std::string childPath = child.path();
    child.close();
    if (!removeTree(fs, childPath)) {
      entry.close();
      return false;
    }
    child = entry.openNextFile();
  }
  entry.close();
  return fs.rmdir(path.c_str());
}

bool isSymlink(const mz_zip_archive_file_stat &stat) {
  const uint32_t unixMode = stat.m_external_attr >> 16U;
  return (unixMode & 0170000U) == 0120000U;
}

std::string withoutTrailingSlash(std::string value) {
  while (!value.empty() && value.back() == '/') {
    value.pop_back();
  }
  return value;
}

std::string vfsPath(const std::string &sdPath) {
  return std::string("/sd") + sdPath;
}

} // namespace

bool ContentStore::begin(std::string &error) {
  SPI.begin(kSdClock, kSdMiso, kSdMosi, kSdCs);
  if (!SD.begin(kSdCs, SPI, kSdFrequency)) {
    return fail(error, "PaperS3 microSD initialization failed");
  }
  if (!ensureDirectory(SD, kBase) || !ensureDirectory(SD, kSlots) ||
      !ensureDirectory(SD, kInbox)) {
    return fail(error, "Cannot create InkOS content directories");
  }
  if (!preferences_.begin("inkos-content", false)) {
    return fail(error, "Cannot open content slot preferences");
  }
  const String stored = preferences_.getString("active", "a");
  activeSlot_ = stored == "b" ? 'b' : 'a';
  started_ = true;
  return true;
}

std::string ContentStore::slotRoot(char slot) const {
  return kSlots + "/" + (slot == 'b' ? "b" : "a");
}

std::string ContentStore::activeRoot() const { return slotRoot(activeSlot_); }

bool ContentStore::setActiveSlot(char slot, std::string &error) {
  if (!started_ || (slot != 'a' && slot != 'b')) {
    return fail(error, "Invalid content slot activation");
  }
  const char value[] = {slot, '\0'};
  if (preferences_.putString("active", value) != 1) {
    return fail(error, "Failed to atomically persist active content slot");
  }
  activeSlot_ = slot;
  return true;
}

bool ContentStore::loadActive(PackageCatalog &catalog, std::string &error) {
  if (!started_) {
    return fail(error, "Content store is not initialized");
  }
  std::string activeError;
  if (catalog.loadAndVerify(SD, activeRoot(), activeError)) {
    return true;
  }
  // A damaged or interrupted active slot may recover from the other fully
  // verified slot. The marker is changed only after verification succeeds.
  const char fallback = activeSlot_ == 'a' ? 'b' : 'a';
  PackageCatalog fallbackCatalog;
  std::string fallbackError;
  if (fallbackCatalog.loadAndVerify(SD, slotRoot(fallback), fallbackError) &&
      setActiveSlot(fallback, error)) {
    catalog = std::move(fallbackCatalog);
    return true;
  }
  return fail(error, "No verified content slot (active: " + activeError +
                         "; fallback: " + fallbackError + ")");
}

bool ContentStore::extractArchive(const std::string &archivePath,
                                  const std::string &destinationRoot,
                                  std::string &error) {
  File archiveFile = SD.open(archivePath.c_str(), FILE_READ);
  if (!archiveFile || archiveFile.isDirectory()) {
    return fail(error, "Content OTA archive is missing: " + archivePath);
  }
  const uint64_t archiveSize = archiveFile.size();
  archiveFile.close();
  if (archiveSize == 0 || archiveSize > kMaxArchiveBytes) {
    return fail(error, "Content OTA archive exceeds compressed size limit");
  }

  if (!removeTree(SD, destinationRoot) ||
      !ensureDirectory(SD, destinationRoot)) {
    return fail(error, "Cannot prepare inactive staging directory");
  }

  mz_zip_archive archive{};
  const std::string archiveVfs = vfsPath(archivePath);
  if (!mz_zip_reader_init_file(&archive, archiveVfs.c_str(), 0)) {
    removeTree(SD, destinationRoot);
    return fail(error, "Invalid ZIP container");
  }
  if (mz_zip_is_zip64(&archive)) {
    mz_zip_reader_end(&archive);
    removeTree(SD, destinationRoot);
    return fail(error, "ZIP64 content packages are not supported");
  }

  bool success = true;
  const mz_uint count = mz_zip_reader_get_num_files(&archive);
  uint64_t expandedBytes = 0;
  std::vector<std::string> paths;
  if (count == 0 || count > kMaxEntries) {
    success = fail(error, "ZIP entry count exceeds limit");
  }

  for (mz_uint index = 0; success && index < count; ++index) {
    mz_zip_archive_file_stat stat{};
    if (!mz_zip_reader_file_stat(&archive, index, &stat)) {
      success = fail(error, "Cannot read ZIP central directory entry");
      break;
    }
    const mz_uint filenameBytes =
        mz_zip_reader_get_filename(&archive, index, nullptr, 0);
    if (filenameBytes <= 1 || filenameBytes > 513) {
      success = fail(error, "ZIP entry path exceeds normalized path limit");
      break;
    }
    std::vector<char> filename(filenameBytes);
    if (mz_zip_reader_get_filename(&archive, index, filename.data(),
                                   filenameBytes) != filenameBytes) {
      success = fail(error, "Cannot read complete ZIP entry path");
      break;
    }
    const std::string relative = withoutTrailingSlash(
        std::string(filename.data(), filenameBytes - 1));
    if (!isNormalizedArchivePath(relative) ||
        std::find(paths.begin(), paths.end(), relative) != paths.end()) {
      success = fail(error, "ZIP contains unsafe or duplicate path");
      break;
    }
    paths.push_back(relative);
    const bool directoryEntry = stat.m_is_directory;
    if (stat.m_is_encrypted || !stat.m_is_supported || isSymlink(stat) ||
        (stat.m_method != 0 && stat.m_method != MZ_DEFLATED) ||
        stat.m_version_needed >= 45) {
      success = fail(error, "ZIP uses encryption, ZIP64, symlink, or unsupported compression");
      break;
    }
    if (stat.m_uncomp_size > kMaxEntryBytes ||
        expandedBytes + stat.m_uncomp_size > kMaxExpandedBytes) {
      success = fail(error, "ZIP expanded size exceeds limit");
      break;
    }
    expandedBytes += stat.m_uncomp_size;
    const std::string destination = joinPath(destinationRoot, relative);
    if (directoryEntry) {
      if (!ensureDirectory(SD, destination)) {
        success = fail(error, "Cannot create staged archive directory");
      }
      continue;
    }
    const size_t separator = destination.find_last_of('/');
    if (separator == std::string::npos ||
        !ensureDirectory(SD, destination.substr(0, separator))) {
      success = fail(error, "Cannot create staged artifact parent directory");
      break;
    }
    const std::string destinationVfs = vfsPath(destination);
    if (!mz_zip_reader_extract_to_file(&archive, index,
                                       destinationVfs.c_str(), 0)) {
      success = fail(error, "ZIP extraction or CRC verification failed");
      break;
    }
  }
  mz_zip_reader_end(&archive);
  if (!success) {
    removeTree(SD, destinationRoot);
  }
  return success;
}

bool ContentStore::stageArchive(const std::string &archivePath,
                                const std::string &expectedSha256,
                                uint64_t expectedBytes, StagedPackage &staged,
                                std::string &error) {
  staged = {};
  if (!started_) {
    return fail(error, "Content store is not initialized");
  }
  File archive = SD.open(archivePath.c_str(), FILE_READ);
  if (!archive || archive.isDirectory()) {
    return fail(error, "Content OTA archive is unavailable");
  }
  const uint64_t actualBytes = archive.size();
  archive.close();
  if (expectedBytes != 0 && actualBytes != expectedBytes) {
    return fail(error, "Content OTA archive length mismatch");
  }
  if (!expectedSha256.empty()) {
    std::string actualSha;
    if (!sha256File(SD, archivePath, actualSha, error)) {
      return false;
    }
    if (actualSha != expectedSha256) {
      return fail(error, "Content OTA archive SHA-256 mismatch");
    }
  }
  if (!extractArchive(archivePath, kStaging, error) ||
      !staged.catalog.loadAndVerify(SD, kStaging, error)) {
    removeTree(SD, kStaging);
    return false;
  }
  staged.targetSlot = activeSlot_ == 'a' ? 'b' : 'a';
  staged.ready = true;
  return true;
}

bool ContentStore::commitStaged(StagedPackage &staged, char &previousSlot,
                                std::string &error) {
  if (!started_ || !staged.ready || !staged.entryDecoded ||
      (staged.targetSlot != 'a' && staged.targetSlot != 'b')) {
    return fail(error, "Staged package is not verified and entry-decoded");
  }
  const std::string target = slotRoot(staged.targetSlot);
  if (!removeTree(SD, target) || !SD.rename(kStaging.c_str(), target.c_str())) {
    return fail(error, "Cannot promote staging directory into inactive slot");
  }
  previousSlot = activeSlot_;
  if (!setActiveSlot(staged.targetSlot, error)) {
    // The previous active directory was never touched. The promoted package
    // simply remains inactive and can be retried later.
    return false;
  }
  staged.ready = false;
  return true;
}

bool ContentStore::rollbackTo(char previousSlot, std::string &error) {
  return setActiveSlot(previousSlot, error);
}

void ContentStore::discardStaging() { removeTree(SD, kStaging); }

bool SettingsStore::begin(DisplaySettings &settings) {
  if (!preferences_.begin("inkos-settings", false)) {
    return false;
  }
  started_ = true;
  const int32_t fontLevel = preferences_.getInt("font", 0);
  settings.fontLevel =
      fontLevel < -2 || fontLevel > 2 ? 0 : static_cast<int8_t>(fontLevel);
  settings.invert = preferences_.getBool("invert", false);
  settings.offline = preferences_.getBool("offline", true);
  settings.orientation = INKOS_ORIENTATION;
  return true;
}

bool SettingsStore::save(const DisplaySettings &settings) {
  if (!started_ || settings.fontLevel < -2 || settings.fontLevel > 2) {
    return false;
  }
  return preferences_.putInt("font", settings.fontLevel) == sizeof(int32_t) &&
         preferences_.putBool("invert", settings.invert) == sizeof(bool) &&
         preferences_.putBool("offline", settings.offline) == sizeof(bool);
}

bool RuntimeStateStore::begin() {
  started_ = preferences_.begin("inkos-runtime", false);
  return started_;
}

RuntimePosition RuntimeStateStore::load() const {
  if (!started_) {
    return {};
  }
  return {
      preferences_.getString("package", "").c_str(),
      preferences_.getString("document", "").c_str(),
      static_cast<uint16_t>(preferences_.getUInt("page", 0)),
  };
}

bool RuntimeStateStore::save(const RuntimePosition &position) {
  if (!started_) {
    return false;
  }
  return preferences_.putString("package", position.packageId.c_str()) ==
             position.packageId.size() &&
         preferences_.putString("document", position.documentUuid.c_str()) ==
             position.documentUuid.size() &&
         preferences_.putUInt("page", position.pageIndex) == sizeof(uint32_t);
}

} // namespace inkos::paper

#include "wifi.h"

#include "device_storage.h"
#include "safe_json.h"
#include "settings.h"

#include <cJSON.h>
#include <esp_event.h>
#include <esp_heap_caps.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_memory_utils.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lwip/inet.h>
#include <lwip/sockets.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <map>
#include <memory>
#include <new>
#include <sstream>
#include <utility>
#include <vector>

namespace inkos::idf {
namespace {

constexpr EventBits_t kConnectedBit = BIT0;
constexpr EventBits_t kFailedBit = BIT1;
constexpr EventBits_t kStationIdleBit = BIT2;
constexpr const char *kTag = "inkos-wifi";
constexpr int64_t kRequestReceiveIdleTimeoutUs = 8LL * 1000LL * 1000LL;
constexpr int64_t kRequestReceiveTotalTimeoutUs = 25LL * 1000LL * 1000LL;
constexpr int64_t kHomeReceiveTotalTimeoutUs = 120LL * 1000LL * 1000LL;
constexpr size_t kHomeReceiveCheckpointBytes = 256U * 1024U;
constexpr size_t kHomeReceiveChunkBytes = 64U * 1024U;
constexpr size_t kHomeWorkerChunkBytes = 8U * 1024U;
EventGroupHandle_t gEvents = nullptr;
esp_netif_t *gStationNetif = nullptr;
esp_netif_t *gApNetif = nullptr;
bool gInitialized = false;
bool gPortalRunning = false;
bool gConnecting = false;
DeviceSettings gPortalCurrent;
DeviceSettings gSavedSettings;
bool gSavedPending = false;
SemaphoreHandle_t gPortalStateMutex = nullptr;

enum class HomeJobPhase : uint8_t {
  Idle,
  Receiving,
  Queued,
  Writing,
  Verifying,
  Succeeded,
  Failed,
};

struct HomeJobStatus {
  uint32_t id = 0;
  HomeJobPhase phase = HomeJobPhase::Idle;
  size_t totalBytes = 0;
  size_t receivedBytes = 0;
  size_t writtenBytes = 0;
  int64_t acceptedAtUs = 0;
  int64_t startedAtUs = 0;
  int64_t finishedAtUs = 0;
  std::string error;
  StoredHomeInfo activated;
};

struct PendingHomeJob {
  uint32_t id = 0;
  uint8_t *body = nullptr;
  size_t bytes = 0;
  HomeUpload upload;
  bool cancelled = false;
};

HomeJobStatus gHomeJob;
uint32_t gNextHomeJobId = 1;

using JsonPtr = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

const char *homeJobPhaseName(HomeJobPhase phase) {
  switch (phase) {
  case HomeJobPhase::Idle: return "idle";
  case HomeJobPhase::Receiving: return "receiving";
  case HomeJobPhase::Queued: return "queued";
  case HomeJobPhase::Writing: return "writing";
  case HomeJobPhase::Verifying: return "verifying";
  case HomeJobPhase::Succeeded: return "succeeded";
  case HomeJobPhase::Failed: return "failed";
  }
  return "failed";
}

bool homeJobActive(HomeJobPhase phase) {
  return phase == HomeJobPhase::Receiving || phase == HomeJobPhase::Queued ||
         phase == HomeJobPhase::Writing || phase == HomeJobPhase::Verifying;
}

bool snapshotHomeJob(HomeJobStatus &status) {
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    return false;
  }
  status = gHomeJob;
  xSemaphoreGive(gPortalStateMutex);
  return true;
}

bool reserveHomeJob(size_t totalBytes, uint32_t &id, std::string &error) {
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    return fail(error, "Home upload status is busy");
  }
  if (homeJobActive(gHomeJob.phase)) {
    xSemaphoreGive(gPortalStateMutex);
    return fail(error, "Another home upload is still active");
  }
  id = gNextHomeJobId++;
  if (gNextHomeJobId == 0) gNextHomeJobId = 1;
  gHomeJob = {};
  gHomeJob.id = id;
  gHomeJob.phase = HomeJobPhase::Receiving;
  gHomeJob.totalBytes = totalBytes;
  gHomeJob.acceptedAtUs = esp_timer_get_time();
  xSemaphoreGive(gPortalStateMutex);
  return true;
}

void updateHomeJob(uint32_t id, HomeJobPhase phase, size_t receivedBytes,
                   size_t writtenBytes) {
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    return;
  }
  if (gHomeJob.id == id) {
    gHomeJob.phase = phase;
    gHomeJob.receivedBytes = receivedBytes;
    gHomeJob.writtenBytes = writtenBytes;
    if (phase == HomeJobPhase::Writing && gHomeJob.startedAtUs == 0) {
      gHomeJob.startedAtUs = esp_timer_get_time();
    }
  }
  xSemaphoreGive(gPortalStateMutex);
}

void failHomeJob(uint32_t id, const std::string &error) {
  ESP_LOGE(kTag, "home upload job %u failed: %s",
           static_cast<unsigned>(id), error.c_str());
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    return;
  }
  if (gHomeJob.id == id) {
    gHomeJob.phase = HomeJobPhase::Failed;
    gHomeJob.error = error;
    gHomeJob.finishedAtUs = esp_timer_get_time();
  }
  xSemaphoreGive(gPortalStateMutex);
}

void succeedHomeJob(uint32_t id, const StoredHomeInfo &activated) {
  ESP_LOGI(kTag, "home upload job %u activated slot=%c bytes=%u",
           static_cast<unsigned>(id), activated.slot,
           static_cast<unsigned>(activated.archiveBytes));
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    return;
  }
  if (gHomeJob.id == id) {
    gHomeJob.phase = HomeJobPhase::Succeeded;
    gHomeJob.receivedBytes = gHomeJob.totalBytes;
    gHomeJob.writtenBytes = gHomeJob.totalBytes;
    gHomeJob.activated = activated;
    gHomeJob.finishedAtUs = esp_timer_get_time();
  }
  xSemaphoreGive(gPortalStateMutex);
}

bool homeJobStatusJson(std::string &json) {
  HomeJobStatus status;
  if (!snapshotHomeJob(status)) return false;
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "schemaVersion", "inkos.home-upload/v1");
  cJSON_AddNumberToObject(root, "jobId", status.id);
  cJSON_AddStringToObject(root, "phase", homeJobPhaseName(status.phase));
  cJSON_AddBoolToObject(root, "active", homeJobActive(status.phase));
  cJSON_AddNumberToObject(root, "totalBytes", status.totalBytes);
  cJSON_AddNumberToObject(root, "receivedBytes", status.receivedBytes);
  cJSON_AddNumberToObject(root, "writtenBytes", status.writtenBytes);
  const int64_t end = status.finishedAtUs > 0 ? status.finishedAtUs
                                             : esp_timer_get_time();
  const int64_t elapsed = status.acceptedAtUs > 0
                              ? std::max<int64_t>(0, end - status.acceptedAtUs)
                              : 0;
  cJSON_AddNumberToObject(root, "elapsedMs", elapsed / 1000);
  if (!status.error.empty()) {
    cJSON_AddStringToObject(root, "error", status.error.c_str());
  }
  if (status.activated.active) {
    cJSON *activated = cJSON_AddObjectToObject(root, "activatedHome");
    char slot[2] = {status.activated.slot, '\0'};
    cJSON_AddStringToObject(activated, "slot", slot);
    cJSON_AddNumberToObject(activated, "archiveBytes",
                            status.activated.archiveBytes);
    cJSON_AddStringToObject(activated, "archiveSha256",
                            status.activated.archiveSha256.c_str());
    cJSON_AddStringToObject(activated, "packageId",
                            status.activated.packageId.c_str());
    cJSON_AddStringToObject(activated, "entryUuid",
                            status.activated.entryUuid.c_str());
    cJSON_AddNumberToObject(activated, "revision",
                            status.activated.revision);
  }
  // This RTC-backed checkpoint survives watchdog/software warm resets.  It is
  // intentionally reported independently of the in-RAM job state so a client
  // can reconnect after a reboot and see the last reached upload phase.
  HomeUploadDiagnostic diagnostic;
  if (loadHomeUploadDiagnostic(diagnostic)) {
    cJSON *recovery = cJSON_AddObjectToObject(root, "recoveryCheckpoint");
    cJSON_AddNumberToObject(recovery, "sequence", diagnostic.sequence);
    cJSON_AddStringToObject(recovery, "phase", diagnostic.phase.c_str());
    cJSON_AddNumberToObject(recovery, "totalBytes", diagnostic.totalBytes);
    cJSON_AddNumberToObject(recovery, "writtenBytes",
                            diagnostic.writtenBytes);
    if (diagnostic.phase == "receiving") {
      cJSON_AddNumberToObject(recovery, "receivedBytes",
                              diagnostic.writtenBytes);
    }
    cJSON_AddNumberToObject(recovery, "detailOffset",
                            diagnostic.detailOffset);
  }
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!printed) return false;
  json = printed;
  cJSON_free(printed);
  return true;
}

void runHomeJob(PendingHomeJob *pending) {
  using HeapBuffer =
      std::unique_ptr<uint8_t, decltype(&heap_caps_free)>;
  const uint32_t id = pending->id;
  const size_t bytes = pending->bytes;
  HeapBuffer body(pending->body, &heap_caps_free);
  HomeUpload upload = std::move(pending->upload);
  delete pending;
  updateHomeJob(id, HomeJobPhase::Writing, bytes, 0);
  std::string error;
  if (!beginHomeUpload(bytes, upload, error)) {
    failHomeJob(id, error);
    return;
  }
  size_t offset = 0;
  while (offset < bytes) {
    const size_t chunk = std::min(kHomeWorkerChunkBytes, bytes - offset);
    if (!appendHomeUpload(upload, body.get() + offset, chunk, error)) {
      abortHomeUpload(upload);
      failHomeJob(id, error);
      return;
    }
    offset += chunk;
    updateHomeJob(id, HomeJobPhase::Writing, bytes, offset);
  }
  body.reset();
  updateHomeJob(id, HomeJobPhase::Verifying, bytes, bytes);
  StoredHomeInfo activated;
  if (!finishHomeUpload(upload, activated, error)) {
    failHomeJob(id, error);
    return;
  }
  succeedHomeJob(id, activated);
}

void homeJobTask(void *context) {
  auto *pending = static_cast<PendingHomeJob *>(context);
  // The HTTP handler creates the task first so its internal stack is already
  // accounted for, then reserves the flash-safe DMA buffer synchronously. Do
  // not inspect the shared job until that handoff notification arrives.
  ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
  if (pending->cancelled) {
    heap_caps_free(pending->body);
    delete pending;
  } else {
    runHomeJob(pending);
  }
  constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  constexpr uint32_t psramCaps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  ESP_LOGI(kTag,
           "home upload worker exit stack_free=%u internal=%u/%u psram=%u/%u",
           static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
           static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
           static_cast<unsigned>(heap_caps_get_largest_free_block(internalCaps)),
           static_cast<unsigned>(heap_caps_get_free_size(psramCaps)),
           static_cast<unsigned>(heap_caps_get_largest_free_block(psramCaps)));
  vTaskDelete(nullptr);
}

bool publishSavedSettings(const DeviceSettings &settings) {
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
    ESP_LOGE(kTag, "could not lock saved-settings mailbox");
    return false;
  }
  gSavedSettings = settings;
  gSavedPending = true;
  gPortalCurrent = settings;
  xSemaphoreGive(gPortalStateMutex);
  return true;
}

void wifiEvent(void *, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    // Connections are started explicitly by connectStation(), after the
    // application-owned NVS settings have been copied into the driver.  Do
    // not auto-connect here: the Wi-Fi driver may otherwise start using a
    // stale config before esp_wifi_set_config(), which then fails with
    // ESP_ERR_WIFI_STATE ("sta is connecting, cannot set config").
    if (!gConnecting) xEventGroupSetBits(gEvents, kStationIdleBit);
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    xEventGroupClearBits(gEvents, kConnectedBit);
    xEventGroupSetBits(gEvents, kStationIdleBit);
    if (gConnecting) xEventGroupSetBits(gEvents, kFailedBit);
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    (void)data;
    xEventGroupClearBits(gEvents, kStationIdleBit);
    xEventGroupSetBits(gEvents, kConnectedBit);
  }
}

std::string htmlEscape(const std::string &value) {
  std::string result;
  result.reserve(value.size());
  for (char character : value) {
    switch (character) {
    case '&': result += "&amp;"; break;
    case '<': result += "&lt;"; break;
    case '>': result += "&gt;"; break;
    case '"': result += "&quot;"; break;
    case '\'': result += "&#39;"; break;
    default: result.push_back(character); break;
    }
  }
  return result;
}

int hexValue(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

std::string urlDecode(const std::string &value) {
  std::string result;
  result.reserve(value.size());
  for (size_t index = 0; index < value.size(); ++index) {
    if (value[index] == '+') {
      result.push_back(' ');
    } else if (value[index] == '%' && index + 2 < value.size()) {
      const int high = hexValue(value[index + 1]);
      const int low = hexValue(value[index + 2]);
      if (high >= 0 && low >= 0) {
        result.push_back(static_cast<char>((high << 4) | low));
        index += 2;
      } else {
        result.push_back(value[index]);
      }
    } else {
      result.push_back(value[index]);
    }
  }
  return result;
}

bool parseForm(const std::string &body,
               std::initializer_list<const char *> allowedFields,
               std::map<std::string, std::string> &result,
               std::string &error) {
  result.clear();
  size_t cursor = 0;
  while (cursor <= body.size()) {
    const size_t amp = body.find('&', cursor);
    const std::string pair = body.substr(
        cursor, amp == std::string::npos ? std::string::npos : amp - cursor);
    const size_t equal = pair.find('=');
    if (pair.empty() || equal == std::string::npos) {
      error = "Form contains an empty or malformed field";
      return false;
    }
    const std::string name = urlDecode(pair.substr(0, equal));
    const std::string decodedValue = urlDecode(pair.substr(equal + 1));
    const bool allowed = std::any_of(
        allowedFields.begin(), allowedFields.end(), [&name](const char *field) {
          return name == field;
        });
    if (!allowed || name.find('\0') != std::string::npos ||
        decodedValue.find('\0') != std::string::npos ||
        !result.emplace(name, decodedValue).second) {
      error = "Form contains an unknown or duplicate field";
      return false;
    }
    if (amp == std::string::npos) break;
    cursor = amp + 1;
  }
  error.clear();
  return true;
}

bool unsafeTextValue(const std::string &value, size_t maximum,
                     bool allowEmpty) {
  if ((!allowEmpty && value.empty()) || value.size() > maximum) return true;
  return std::any_of(value.begin(), value.end(), [](char character) {
    const auto byte = static_cast<unsigned char>(character);
    return byte < 0x20 || byte == 0x7f;
  });
}

std::string collectionLines(const std::vector<CollectionEntry> &entries) {
  std::string result;
  for (const auto &entry : entries) {
    result += entry.label + " | " + entry.url + "\n";
  }
  return result;
}

std::string portalHtml(const std::string &error = {}) {
  DeviceCollections collections;
  StoredHomeInfo home;
  std::string ignored;
  if (!loadCollections(collections, ignored)) collections = {};
  ignored.clear();
  if (!loadStoredHomeInfo(home, ignored)) home = {};
  std::ostringstream html;
  html << "<!doctype html><html lang=zh-CN><head><meta charset=utf-8>"
          "<meta name=viewport content='width=device-width,initial-scale=1,viewport-fit=cover'>"
          "<title>InkOS PaperS3 配置</title><style>"
          ":root{color-scheme:light;font-family:system-ui,-apple-system,sans-serif}"
          "*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;"
          "background:#e8e8e3;color:#080808;font-size:19px;line-height:1.55}"
          "main{width:100%;max-width:40rem;min-height:100vh;min-height:100dvh;"
          "margin:0 auto;padding:28px 22px 40px;background:#fff;"
          "padding-top:calc(28px + env(safe-area-inset-top));"
          "padding-right:calc(22px + env(safe-area-inset-right));"
          "padding-bottom:calc(40px + env(safe-area-inset-bottom));"
          "padding-left:calc(22px + env(safe-area-inset-left))}"
          "h1{margin:0 0 14px;font-size:36px;font-size:clamp(34px,9vw,44px);line-height:1.12;"
          "letter-spacing:-.02em}.hint{margin:0;line-height:1.65;color:#282828}"
          "code{display:inline-block;max-width:100%;padding:2px 5px;background:#eee;"
          "font-size:.9em;overflow-wrap:anywhere;word-break:break-all}form{margin-top:30px}"
          "h2{margin:42px 0 8px;padding-top:30px;border-top:3px solid #080808;"
          "font-size:28px;line-height:1.2}.status{padding:14px 16px;border:2px solid #080808;"
          "background:#f1f1ed;overflow-wrap:anywhere}"
          "label{display:block;margin:24px 0 8px;font-size:20px;line-height:1.35;"
          "font-weight:750}.help{display:block;margin:-2px 0 9px;color:#3d3d3d;"
          "font-size:17px;line-height:1.45}input,textarea,button{width:100%;border:2px solid #080808;"
          "border-radius:10px;font:inherit;font-size:20px;line-height:1.25}"
          "input{min-height:58px;padding:14px 15px;background:#fff;color:#000}"
          "textarea{min-height:160px;padding:14px 15px;resize:vertical;background:#fff;color:#000;"
          "font-family:ui-monospace,SFMono-Regular,monospace;font-size:17px;line-height:1.5}"
          "input::placeholder{color:#555;opacity:1}button{min-height:60px;margin-top:28px;"
          "padding:14px 18px;background:#080808;color:#fff;font-weight:800;cursor:pointer;"
          "touch-action:manipulation;-webkit-tap-highlight-color:transparent}"
          "input:focus-visible,textarea:focus-visible,button:focus-visible{outline:4px solid #2457d6;outline-offset:3px}"
          "button:active{transform:translateY(1px)}.reset{margin-top:20px;padding-top:20px;"
          "border-top:2px solid #c8c8c2}.secondary{margin-top:0;background:#fff;color:#080808}"
          ".danger{background:#fff;color:#080808}.inline{display:grid;grid-template-columns:1fr 1fr;gap:12px}"
          ".inline button{margin-top:12px}output{display:block;margin-top:14px;min-height:1.5em;font-weight:700}"
          ".error{margin:24px 0 0;padding:15px 16px;background:#fff2cf;"
          "border:2px solid #080808;border-left:8px solid #8a3700;font-weight:700}"
          "@media(min-width:42rem){body{padding:32px}main{min-height:auto;border:2px solid #080808;"
          "border-radius:14px;padding:42px}.hint{font-size:20px}}</style></head><body>"
          "<main><h1>InkOS PaperS3</h1>"
          "<p class=hint>配置设备要连接的 Wi‑Fi，以及 InkOS 渲染服务器根地址。"
          "服务器示例：<code>http://192.168.1.10:3000</code></p>";
  if (!error.empty()) html << "<p class=error>" << htmlEscape(error) << "</p>";
  html << "<form method=post action=/save>"
          "<label for=ssid>Wi‑Fi SSID</label><input id=ssid name=ssid "
          "maxlength=32 autocomplete=off required value='"
       << htmlEscape(gPortalCurrent.wifiSsid)
       << "'><label for=password>Wi‑Fi 密码</label>"
          "<span class=help>已经保存过密码时，留空会保留原密码。</span>"
          "<input id=password name=password type=password maxlength=63 "
          "autocomplete=current-password placeholder='留空则不修改'>"
          "<label for=server>渲染服务器</label>"
          "<span class=help>填写含端口的完整 HTTP 或 HTTPS 根地址。</span>"
          "<input id=server name=server type=url inputmode=url maxlength=512 "
          "autocapitalize=none autocomplete=off spellcheck=false required value='"
       << htmlEscape(gPortalCurrent.serverBaseUrl)
       << "'><button type=submit>保存并连接</button></form>"
          "<form class=reset method=post action=/reset><button class=secondary type=submit>"
          "清除已保存的网络设置</button></form>"
          "<h2>内容列表</h2><p class=hint>每行格式：<code>名称 | https://地址</code>。"
          "列表按填写顺序逐行保存；RSS/网页/图片条目由渲染服务器处理。"
          "图片查看器也保存普通 HTTPS 地址，所有行都可以修改、删除或新增。</p>"
          "<form method=post action=/collections>"
          "<label for=rss>RSS 阅读器</label><textarea id=rss name=rss placeholder='名称 | https://feed.example/rss'>"
       << htmlEscape(collectionLines(collections.rss))
       << "</textarea><label for=websites>网络阅读器</label><textarea id=websites name=websites>"
       << htmlEscape(collectionLines(collections.websites))
       << "</textarea><label for=images>图片查看器</label>"
          "<span class=help>每行对应一张全屏图片；设备内上划看下一张、下划看上一张，并保持这里的填写顺序。</span>"
          "<textarea id=images name=images "
          "placeholder='随机图片 | https://picsum.photos/540/960?random=1'>"
       << htmlEscape(collectionLines(collections.images))
       << "</textarea><button type=submit>保存内容列表</button></form>"
          "<h2>应用首页 .ink</h2><p class=status>"
       << (home.active
               ? "当前使用上传首页：" + htmlEscape(home.packageId) +
                     "，revision " + std::to_string(home.revision) +
                     "，" + std::to_string(home.archiveBytes) + " bytes"
               : "当前使用固件内置首页（安全 fallback）")
       << "</p><label for=homeFile>选择新的 .ink 文件</label>"
          "<input id=homeFile type=file accept='.ink,application/zip,application/vnd.inkos.package+zip'>"
          "<div class=inline><button id=uploadHome type=button>校验并启用</button>"
          "<button id=deleteHome class=danger type=button>恢复内置首页</button></div>"
          "<output id=homeResult aria-live=polite></output>"
          "<script>(()=>{const f=document.getElementById('homeFile'),o=document.getElementById('homeResult');"
          "const wait=ms=>new Promise(x=>setTimeout(x,ms));const poll=async()=>{for(;;){await wait(1000);"
          "const r=await fetch('/api/home/status',{cache:'no-store'}),j=await r.json();"
          "if(!r.ok){o.textContent=j.error||'读取后台进度失败';return;}"
          "if(j.phase==='succeeded'){o.textContent='首页已安全切换';setTimeout(()=>location.reload(),800);return;}"
          "if(j.phase==='failed'){o.textContent='处理失败：'+(j.error||'未知错误');return;}"
          "const p=j.totalBytes?Math.floor(100*(j.phase==='receiving'?j.receivedBytes:j.writtenBytes)/j.totalBytes):0;"
          "const n={receiving:'接收',queued:'排队',writing:'写入',verifying:'校验'}[j.phase]||j.phase;"
          "o.textContent='后台'+n+'中 '+p+'% · '+j.elapsedMs+' ms';}};"
          "document.getElementById('uploadHome').onclick=async()=>{if(!f.files.length){o.textContent='请先选择 .ink 文件';return;}"
          "o.textContent='正在接收上传文件…';try{const r=await fetch('/api/home',{method:'PUT',"
          "headers:{'Content-Type':'application/vnd.inkos.package+zip'},body:f.files[0]});"
          "const j=await r.json();if(r.status===202){o.textContent='上传已接收，转入后台处理';poll();}"
          "else{o.textContent=j.error||'上传失败';}}catch(e){o.textContent='上传连接中断：'+e;}};"
          "document.getElementById('deleteHome').onclick=async()=>{o.textContent='正在恢复内置首页…';"
          "try{const r=await fetch('/api/home',{method:'DELETE'}),j=await r.json();"
          "o.textContent=r.ok?'已恢复固件内置首页':(j.error||'操作失败');if(r.ok)setTimeout(()=>location.reload(),700);"
          "}catch(e){o.textContent='请求失败：'+e;}};"
          "fetch('/api/home/status',{cache:'no-store'}).then(async r=>{const j=await r.json();"
          "if(r.ok&&j.active){o.textContent='检测到尚未完成的后台任务，正在恢复进度…';poll();}}).catch(()=>{});"
          "})();</script>"
          "</main></body></html>";
  return html.str();
}

esp_err_t sendHtml(httpd_req_t *request, const std::string &html,
                   const char *status = "200 OK") {
  httpd_resp_set_status(request, status);
  httpd_resp_set_type(request, "text/html; charset=utf-8");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  return httpd_resp_send(request, html.data(), html.size());
}

esp_err_t sendJson(httpd_req_t *request, const std::string &json,
                   const char *status = "200 OK") {
  httpd_resp_set_status(request, status);
  httpd_resp_set_type(request, "application/json; charset=utf-8");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  return httpd_resp_send(request, json.data(), json.size());
}

esp_err_t sendJsonError(httpd_req_t *request, const std::string &error,
                        const char *status) {
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "error", error.c_str());
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  const std::string json = printed ? printed : "{\"error\":\"internal\"}";
  if (printed) cJSON_free(printed);
  return sendJson(request, json, status);
}

bool receiveBody(httpd_req_t *request, size_t maximumBytes, std::string &body,
                 std::string &error) {
  if (request->content_len <= 0 ||
      static_cast<size_t>(request->content_len) > maximumBytes) {
    error = "Request body is empty or exceeds the device limit";
    return false;
  }
  body.assign(request->content_len, '\0');
  size_t received = 0;
  const int64_t startedAtUs = esp_timer_get_time();
  int64_t lastProgressAtUs = startedAtUs;
  while (received < body.size()) {
    const int count = httpd_req_recv(request, body.data() + received,
                                     body.size() - received);
    const int64_t now = esp_timer_get_time();
    if (count == HTTPD_SOCK_ERR_TIMEOUT) {
      if (now - lastProgressAtUs >= kRequestReceiveIdleTimeoutUs ||
          now - startedAtUs >= kRequestReceiveTotalTimeoutUs) {
        error = "Request body receive timed out";
        return false;
      }
      continue;
    }
    if (count <= 0) {
      error = "Request body ended before Content-Length";
      return false;
    }
    received += static_cast<size_t>(count);
    lastProgressAtUs = now;
    if (now - startedAtUs >= kRequestReceiveTotalTimeoutUs) {
      error = "Request body exceeded the receive deadline";
      return false;
    }
  }
  return true;
}

std::string trim(std::string value) {
  size_t begin = 0;
  while (begin < value.size() &&
         std::isspace(static_cast<unsigned char>(value[begin]))) {
    ++begin;
  }
  size_t end = value.size();
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(value[end - 1]))) {
    --end;
  }
  return value.substr(begin, end - begin);
}

bool addCollectionLines(cJSON *root, const char *key, const std::string &lines,
                        size_t maximumEntries, std::string &error) {
  cJSON *array = cJSON_AddArrayToObject(root, key);
  size_t cursor = 0;
  size_t count = 0;
  while (cursor <= lines.size()) {
    const size_t newline = lines.find('\n', cursor);
    std::string line = trim(lines.substr(
        cursor, newline == std::string::npos ? std::string::npos
                                              : newline - cursor));
    if (!line.empty()) {
      const size_t separator = line.find('|');
      if (separator == std::string::npos || ++count > maximumEntries) {
        error = std::string(key) +
                " must use one 'Name | URL' entry per line";
        return false;
      }
      const std::string label = trim(line.substr(0, separator));
      const std::string url = trim(line.substr(separator + 1));
      cJSON *entry = cJSON_CreateObject();
      cJSON_AddStringToObject(entry, "label", label.c_str());
      cJSON_AddStringToObject(entry, "url", url.c_str());
      cJSON_AddItemToArray(array, entry);
    }
    if (newline == std::string::npos) break;
    cursor = newline + 1;
  }
  return true;
}

bool collectionsFromForm(const std::map<std::string, std::string> &form,
                         uint32_t revision, DeviceCollections &collections,
                         std::string &error) {
  const auto rss = form.find("rss");
  const auto websites = form.find("websites");
  const auto images = form.find("images");
  if (rss == form.end() || websites == form.end() || images == form.end()) {
    error = "The collection form is incomplete";
    return false;
  }
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "schemaVersion",
                          "inkos.device-collections/v2");
  cJSON_AddNumberToObject(root, "revision", revision);
  if (!addCollectionLines(root, "rss", rss->second,
                          kMaximumRssCollectionEntries, error) ||
      !addCollectionLines(root, "websites", websites->second,
                          kMaximumWebsiteCollectionEntries, error) ||
      !addCollectionLines(root, "images", images->second,
                          kMaximumImageCollectionEntries, error)) {
    cJSON_Delete(root);
    return false;
  }
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!printed) {
    error = "Cannot serialize collection form";
    return false;
  }
  const std::string json(printed);
  cJSON_free(printed);
  return parseCollectionsJson(json, collections, error);
}

esp_err_t rootHandler(httpd_req_t *request) {
  return sendHtml(request, portalHtml());
}

esp_err_t saveHandler(httpd_req_t *request) {
  if (request->content_len <= 0 || request->content_len > 1200) {
    return sendHtml(request, portalHtml("提交内容过大。"), "400 Bad Request");
  }
  std::string body(request->content_len, '\0');
  size_t received = 0;
  while (received < body.size()) {
    const int count = httpd_req_recv(request, body.data() + received,
                                     body.size() - received);
    if (count <= 0) {
      return sendHtml(request, portalHtml("读取提交内容失败。"),
                      "400 Bad Request");
    }
    received += count;
  }
  std::map<std::string, std::string> form;
  std::string formError;
  if (!parseForm(body, {"ssid", "password", "server"}, form, formError)) {
    return sendHtml(request, portalHtml(formError),
                    "422 Unprocessable Entity");
  }
  const auto ssid = form.find("ssid");
  const auto server = form.find("server");
  const auto password = form.find("password");
  if (ssid == form.end() || unsafeTextValue(ssid->second, 32, false) ||
      server == form.end() ||
      (password != form.end() &&
       unsafeTextValue(password->second, 63, true))) {
    return sendHtml(request, portalHtml("SSID 或服务器地址无效。"),
                    "422 Unprocessable Entity");
  }
  DeviceSettings candidate = gPortalCurrent;
  candidate.wifiSsid = ssid->second;
  if (password != form.end() && !password->second.empty()) {
    candidate.wifiPassword = password->second;
  }
  std::string normalized;
  std::string validationError;
  if (!validServerBaseUrl(server->second, normalized, validationError)) {
    return sendHtml(request, portalHtml(validationError),
                    "422 Unprocessable Entity");
  }
  candidate.serverBaseUrl = normalized;
  if (!saveSettings(candidate, validationError)) {
    return sendHtml(request, portalHtml(validationError),
                    "500 Internal Server Error");
  }
  if (!publishSavedSettings(candidate)) {
    return sendHtml(request, portalHtml("设置已保存，但无法安排立即重连。"),
                    "500 Internal Server Error");
  }
  return sendHtml(
      request,
      "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport "
      "content='width=device-width,initial-scale=1,viewport-fit=cover'><title>已保存</title>"
      "<style>:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:light}"
      "*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;"
      "padding:calc(32px + env(safe-area-inset-top)) calc(22px + env(safe-area-inset-right)) "
      "calc(40px + env(safe-area-inset-bottom)) calc(22px + env(safe-area-inset-left));"
      "background:#fff;color:#080808;"
      "font-size:20px;line-height:1.65}main{max-width:34rem;margin:0 auto}"
      "h1{margin:0 0 16px;font-size:36px;font-size:clamp(34px,9vw,44px);line-height:1.15}"
      "p{margin:0;padding:18px;border:2px solid #080808;border-left:8px solid #080808;"
      "background:#f1f1ed;font-weight:650}</style></head><body><main>"
      "<h1>设置已保存</h1><p>PaperS3 正在连接 Wi‑Fi，可以关闭此页面。</p>"
      "</main></body></html>");
}

esp_err_t resetHandler(httpd_req_t *request) {
  std::string error;
  if (!clearNetworkSettings(error)) {
    return sendHtml(request, portalHtml(error), "500 Internal Server Error");
  }
  gPortalCurrent.wifiSsid.clear();
  gPortalCurrent.wifiPassword.clear();
  gPortalCurrent.serverBaseUrl.clear();
  if (!publishSavedSettings(gPortalCurrent)) {
    return sendHtml(request, portalHtml("网络已清除；请重启设备后重新配置。"),
                    "500 Internal Server Error");
  }
  return sendHtml(request, portalHtml("已清除；请填写新的 Wi-Fi 和服务器。"));
}

esp_err_t collectionsFormHandler(httpd_req_t *request) {
  std::string body;
  std::string error;
  if (!receiveBody(request, 160U * 1024U, body, error)) {
    return sendHtml(request, portalHtml(error), "400 Bad Request");
  }
  DeviceCollections current;
  if (!loadCollections(current, error)) {
    return sendHtml(request, portalHtml(error), "500 Internal Server Error");
  }
  std::map<std::string, std::string> form;
  if (!parseForm(body, {"rss", "websites", "images"}, form, error)) {
    return sendHtml(request, portalHtml(error),
                    "422 Unprocessable Entity");
  }
  DeviceCollections candidate;
  const uint32_t nextRevision =
      current.revision == UINT32_MAX ? 1 : current.revision + 1;
  if (!collectionsFromForm(form, nextRevision, candidate, error) ||
      !saveCollections(candidate, error)) {
    return sendHtml(request, portalHtml(error),
                    "422 Unprocessable Entity");
  }
  return sendHtml(request, portalHtml("内容列表已保存到设备。"));
}

esp_err_t apiStateHandler(httpd_req_t *request) {
  DeviceCollections collections;
  StoredHomeInfo home;
  std::string error;
  if (!loadCollections(collections, error) ||
      !loadStoredHomeInfo(home, error)) {
    return sendJsonError(request, error, "500 Internal Server Error");
  }
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "schemaVersion", "inkos.device-state/v1");
  cJSON *network = cJSON_AddObjectToObject(root, "network");
  cJSON_AddStringToObject(network, "ssid", gPortalCurrent.wifiSsid.c_str());
  cJSON_AddStringToObject(network, "serverBaseUrl",
                          gPortalCurrent.serverBaseUrl.c_str());
  cJSON_AddStringToObject(network, "stationAddress", stationAddress().c_str());
  cJSON_AddBoolToObject(network, "connected", wifiConnected());
  cJSON *homeJson = cJSON_AddObjectToObject(root, "uploadedHome");
  cJSON_AddBoolToObject(homeJson, "active", home.active);
  if (home.active) {
    char slot[2] = {home.slot, '\0'};
    cJSON_AddStringToObject(homeJson, "slot", slot);
    cJSON_AddNumberToObject(homeJson, "archiveBytes", home.archiveBytes);
    cJSON_AddStringToObject(homeJson, "archiveSha256",
                            home.archiveSha256.c_str());
    cJSON_AddStringToObject(homeJson, "packageId", home.packageId.c_str());
    cJSON_AddStringToObject(homeJson, "entryUuid", home.entryUuid.c_str());
    cJSON_AddNumberToObject(homeJson, "revision", home.revision);
  }
  const std::string collectionJson = collectionsJson(collections);
  cJSON *collectionRoot = parseStrictBoundedJson(collectionJson, 16);
  cJSON_AddItemToObject(root, "collections", collectionRoot);
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!printed) {
    return sendJsonError(request, "Cannot serialize device state",
                         "500 Internal Server Error");
  }
  const std::string json(printed);
  cJSON_free(printed);
  return sendJson(request, json);
}

esp_err_t apiCollectionsGetHandler(httpd_req_t *request) {
  DeviceCollections collections;
  std::string error;
  if (!loadCollections(collections, error)) {
    return sendJsonError(request, error, "500 Internal Server Error");
  }
  return sendJson(request, collectionsJson(collections));
}

esp_err_t apiCollectionsPutHandler(httpd_req_t *request) {
  std::string body;
  std::string error;
  if (!receiveBody(request, 48U * 1024U, body, error)) {
    return sendJsonError(request, error, "413 Payload Too Large");
  }
  DeviceCollections candidate;
  if (!parseCollectionsJson(body, candidate, error) ||
      !saveCollections(candidate, error)) {
    return sendJsonError(request, error, "422 Unprocessable Entity");
  }
  return sendJson(request, collectionsJson(candidate));
}

esp_err_t apiSettingsPutHandler(httpd_req_t *request) {
  std::string body;
  std::string error;
  if (!receiveBody(request, 4096, body, error)) {
    return sendJsonError(request, error, "400 Bad Request");
  }
  JsonPtr root(parseStrictBoundedJson(body, 8), cJSON_Delete);
  const cJSON *ssid = root
                          ? cJSON_GetObjectItemCaseSensitive(root.get(), "ssid")
                          : nullptr;
  const cJSON *password = root ? cJSON_GetObjectItemCaseSensitive(
                                    root.get(), "password")
                               : nullptr;
  const cJSON *server = root ? cJSON_GetObjectItemCaseSensitive(
                                  root.get(), "serverBaseUrl")
                             : nullptr;
  bool sawSsid = false;
  bool sawPassword = false;
  bool sawServer = false;
  bool unknownOrDuplicate = false;
  if (root && cJSON_IsObject(root.get())) {
    for (const cJSON *member = root->child; member; member = member->next) {
      if (!member->string) {
        unknownOrDuplicate = true;
      } else if (std::strcmp(member->string, "ssid") == 0) {
        unknownOrDuplicate = unknownOrDuplicate || sawSsid;
        sawSsid = true;
      } else if (std::strcmp(member->string, "password") == 0) {
        unknownOrDuplicate = unknownOrDuplicate || sawPassword;
        sawPassword = true;
      } else if (std::strcmp(member->string, "serverBaseUrl") == 0) {
        unknownOrDuplicate = unknownOrDuplicate || sawServer;
        sawServer = true;
      } else {
        unknownOrDuplicate = true;
      }
    }
  }
  if (!root || !cJSON_IsObject(root.get()) || !cJSON_IsString(ssid) ||
      !ssid->valuestring || !cJSON_IsString(server) || !server->valuestring ||
      (password && (!cJSON_IsString(password) || !password->valuestring)) ||
      unknownOrDuplicate ||
      !sawSsid || !sawServer) {
    return sendJsonError(request, "Invalid settings JSON",
                         "422 Unprocessable Entity");
  }
  if (unsafeTextValue(ssid->valuestring, 32, false) ||
      (password && unsafeTextValue(password->valuestring, 63, true))) {
    return sendJsonError(request, "Wi-Fi settings are outside device limits",
                         "422 Unprocessable Entity");
  }
  DeviceSettings candidate = gPortalCurrent;
  candidate.wifiSsid = ssid->valuestring;
  if (password && password->valuestring && password->valuestring[0] != '\0') {
    candidate.wifiPassword = password->valuestring;
  }
  std::string normalized;
  if (!validServerBaseUrl(server->valuestring, normalized, error)) {
    return sendJsonError(request, error, "422 Unprocessable Entity");
  }
  candidate.serverBaseUrl = normalized;
  if (!saveSettings(candidate, error)) {
    return sendJsonError(request, error, "500 Internal Server Error");
  }
  if (!publishSavedSettings(candidate)) {
    return sendJsonError(request, "Settings saved but reconnect was not queued",
                         "500 Internal Server Error");
  }
  return sendJson(request, "{\"saved\":true,\"reconnecting\":true}");
}

esp_err_t apiHomePutHandler(httpd_req_t *request) {
  char contentType[96]{};
  const bool hasContentType =
      httpd_req_get_hdr_value_str(request, "Content-Type", contentType,
                                  sizeof(contentType)) == ESP_OK;
  std::string mediaType = hasContentType ? contentType : "";
  const size_t parameters = mediaType.find(';');
  if (parameters != std::string::npos) mediaType.resize(parameters);
  mediaType = trim(mediaType);
  if (!hasContentType ||
      (mediaType != "application/vnd.inkos.package+zip" &&
       mediaType != "application/zip" &&
       mediaType != "application/octet-stream")) {
    return sendJsonError(request, "Expected a raw .ink ZIP request body",
                         "415 Unsupported Media Type");
  }
  std::string error;
  if (request->content_len <= 0 ||
      static_cast<size_t>(request->content_len) >
          kMaximumUploadedHomeBytes) {
    return sendJsonError(request,
                         "Uploaded .ink exceeds the 4.25-MiB device slot",
                         "413 Payload Too Large");
  }
  const size_t totalBytes = static_cast<size_t>(request->content_len);
  uint32_t jobId = 0;
  if (!reserveHomeJob(totalBytes, jobId, error)) {
    return sendJsonError(request, error, "409 Conflict");
  }
  using HeapBuffer =
      std::unique_ptr<uint8_t, decltype(&heap_caps_free)>;
  HeapBuffer body(static_cast<uint8_t *>(heap_caps_malloc(
                      totalBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)),
                  &heap_caps_free);
  if (!body || !esp_ptr_external_ram(body.get())) {
    failHomeJob(jobId, "Not enough PSRAM to stage the uploaded home");
    return sendJsonError(request,
                         "Not enough PSRAM to stage the uploaded home",
                         "503 Service Unavailable");
  }
  size_t received = 0;
  const int64_t startedAtUs = esp_timer_get_time();
  int64_t lastProgressAtUs = startedAtUs;
  size_t checkpointedBytes = SIZE_MAX;
  size_t nextCheckpointBytes = kHomeReceiveCheckpointBytes;
  const auto checkpointReceive = [&]() {
    recordHomeUploadReceiveCheckpoint(totalBytes, received);
    checkpointedBytes = received;
    constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    constexpr uint32_t psramCaps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
    ESP_LOGI(kTag,
             "home upload job %u receiving=%u/%u elapsed=%lldms "
             "internal=%u/%u psram=%u/%u",
             static_cast<unsigned>(jobId), static_cast<unsigned>(received),
             static_cast<unsigned>(totalBytes),
             static_cast<long long>((esp_timer_get_time() - startedAtUs) /
                                    1000),
             static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
             static_cast<unsigned>(
                 heap_caps_get_largest_free_block(internalCaps)),
             static_cast<unsigned>(heap_caps_get_free_size(psramCaps)),
             static_cast<unsigned>(
                 heap_caps_get_largest_free_block(psramCaps)));
  };
  checkpointReceive();
  while (received < totalBytes) {
    const size_t remaining = totalBytes - received;
    const int count = httpd_req_recv(
        request, reinterpret_cast<char *>(body.get() + received),
        std::min(kHomeReceiveChunkBytes, remaining));
    const int64_t now = esp_timer_get_time();
    if (count == HTTPD_SOCK_ERR_TIMEOUT) {
      const bool idleExpired =
          now - lastProgressAtUs >= kRequestReceiveIdleTimeoutUs;
      const bool totalExpired =
          now - startedAtUs >= kHomeReceiveTotalTimeoutUs;
      if (idleExpired || totalExpired) {
        if (checkpointedBytes != received) checkpointReceive();
        error = idleExpired
                    ? "Home upload receive made no progress before timeout"
                    : "Home upload exceeded the total receive deadline";
        failHomeJob(jobId, error);
        return sendJsonError(request, error, "408 Request Timeout");
      }
      continue;
    }
    if (count <= 0) {
      if (checkpointedBytes != received) checkpointReceive();
      error = "Home upload ended before Content-Length";
      failHomeJob(jobId, error);
      return sendJsonError(request, error, "400 Bad Request");
    }
    received += static_cast<size_t>(count);
    lastProgressAtUs = now;
    updateHomeJob(jobId, HomeJobPhase::Receiving, received, 0);
    if (received >= nextCheckpointBytes || received == totalBytes) {
      checkpointReceive();
      nextCheckpointBytes =
          (received / kHomeReceiveCheckpointBytes + 1) *
          kHomeReceiveCheckpointBytes;
    }
    if (now - startedAtUs >= kHomeReceiveTotalTimeoutUs) {
      if (checkpointedBytes != received) checkpointReceive();
      error = "Home upload exceeded the total receive deadline";
      failHomeJob(jobId, error);
      return sendJsonError(request, error, "408 Request Timeout");
    }
  }
  auto *pending = new (std::nothrow) PendingHomeJob;
  if (!pending) {
    failHomeJob(jobId, "Could not allocate the background upload job");
    return sendJsonError(request,
                         "Could not allocate the background upload job",
                         "503 Service Unavailable");
  }
  pending->id = jobId;
  pending->bytes = totalBytes;
  pending->body = body.release();
  TaskHandle_t task = nullptr;
  // Wi-Fi is pinned to CPU0 on PaperS3. Keep the low-priority flash worker on
  // CPU1; short cache-off operations still affect both cores, but the explicit
  // gaps in device_storage.cpp then leave CPU0 available for Wi-Fi/lwIP.
  if (xTaskCreatePinnedToCore(homeJobTask, "inkos_home", 12288, pending,
                              tskIDLE_PRIORITY + 1, &task, 1) != pdPASS) {
    body.reset(pending->body);
    delete pending;
    failHomeJob(jobId, "Could not start the background upload task");
    return sendJsonError(request,
                         "Could not start the background upload task",
                         "503 Service Unavailable");
  }
  // The task is now blocked on its notification and its 12-KiB internal stack
  // is part of the real heap pressure. Reserve the flash bounce buffer only
  // now, but still before accepting the request. This prevents a successful
  // 202 followed by an immediate allocation failure in the worker.
  if (!reserveHomeUploadIo(pending->upload, error)) {
    pending->cancelled = true;
    xTaskNotifyGive(task);
    failHomeJob(jobId, error);
    return sendJsonError(request, error, "503 Service Unavailable");
  }
  const size_t flashIoBytes = pending->upload.flashIoBufferBytes;
  updateHomeJob(jobId, HomeJobPhase::Queued, totalBytes, 0);
  ESP_LOGI(kTag,
           "home upload job %u staged %u bytes in PSRAM after %lldms; io=%u",
           static_cast<unsigned>(jobId), static_cast<unsigned>(totalBytes),
           static_cast<long long>((esp_timer_get_time() - startedAtUs) / 1000),
           static_cast<unsigned>(flashIoBytes));
  xTaskNotifyGive(task);
  char json[192]{};
  std::snprintf(json, sizeof(json),
                "{\"accepted\":true,\"jobId\":%u,"
                "\"statusUrl\":\"/api/home/status\"}",
                static_cast<unsigned>(jobId));
  httpd_resp_set_hdr(request, "Location", "/api/home/status");
  httpd_resp_set_hdr(request, "Retry-After", "1");
  return sendJson(request, json, "202 Accepted");
}

esp_err_t apiHomeStatusHandler(httpd_req_t *request) {
  std::string json;
  if (!homeJobStatusJson(json)) {
    return sendJsonError(request, "Home upload status is busy",
                         "503 Service Unavailable");
  }
  return sendJson(request, json);
}

esp_err_t apiHomeDeleteHandler(httpd_req_t *request) {
  HomeJobStatus status;
  if (!snapshotHomeJob(status)) {
    return sendJsonError(request, "Home upload status is busy",
                         "503 Service Unavailable");
  }
  if (homeJobActive(status.phase)) {
    return sendJsonError(request,
                         "Cannot delete the uploaded home while a job is active",
                         "409 Conflict");
  }
  std::string error;
  if (!deleteUploadedHome(error)) {
    return sendJsonError(request, error, "500 Internal Server Error");
  }
  return sendJson(request, "{\"deleted\":true,\"fallback\":\"embedded\"}");
}

esp_err_t redirectHandler(httpd_req_t *request) {
  if (!gPortalRunning) {
    return sendJsonError(request, "Not found", "404 Not Found");
  }
  httpd_resp_set_status(request, "302 Found");
  httpd_resp_set_hdr(request, "Location", "http://192.168.4.1/");
  return httpd_resp_send(request, nullptr, 0);
}

void dnsTask(void *) {
  const int socketFd = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
  if (socketFd < 0) {
    ESP_LOGE(kTag, "cannot create captive DNS socket");
    vTaskDelete(nullptr);
    return;
  }
  timeval timeout{0, 250000};
  setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(53);
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(socketFd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) <
      0) {
    ESP_LOGE(kTag, "cannot bind captive DNS socket");
    close(socketFd);
    vTaskDelete(nullptr);
    return;
  }
  uint8_t request[512];
  while (gPortalRunning) {
    sockaddr_in peer{};
    socklen_t peerSize = sizeof(peer);
    const int bytes = recvfrom(socketFd, request, sizeof(request), 0,
                               reinterpret_cast<sockaddr *>(&peer), &peerSize);
    if (bytes < 12) continue;
    size_t cursor = 12;
    while (cursor < static_cast<size_t>(bytes) && request[cursor] != 0) {
      const uint8_t label = request[cursor];
      if (label == 0 || cursor + label + 1 > static_cast<size_t>(bytes)) {
        cursor = bytes;
        break;
      }
      cursor += label + 1;
    }
    if (cursor + 5 > static_cast<size_t>(bytes)) continue;
    const size_t questionEnd = cursor + 5;
    std::vector<uint8_t> response(request, request + questionEnd);
    response[2] = 0x81;
    response[3] = 0x80;
    response[6] = 0;
    response[7] = 1;
    const uint8_t answer[] = {0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
                              0x00, 0x00, 0x00, 0x3c, 0x00, 0x04,
                              192,  168,  4,    1};
    response.insert(response.end(), std::begin(answer), std::end(answer));
    sendto(socketFd, response.data(), response.size(), 0,
           reinterpret_cast<sockaddr *>(&peer), peerSize);
  }
  close(socketFd);
  vTaskDelete(nullptr);
}

} // namespace

bool initializeWifi(std::string &error) {
  if (gInitialized) return true;
  if (!gPortalStateMutex) gPortalStateMutex = xSemaphoreCreateMutex();
  if (!gPortalStateMutex) {
    return fail(error, "Could not allocate settings mailbox mutex");
  }
  esp_err_t status = esp_netif_init();
  if (status != ESP_OK && status != ESP_ERR_INVALID_STATE) {
    return fail(error, std::string("esp_netif_init failed: ") +
                           esp_err_to_name(status));
  }
  status = esp_event_loop_create_default();
  if (status != ESP_OK && status != ESP_ERR_INVALID_STATE) {
    return fail(error, std::string("event loop init failed: ") +
                           esp_err_to_name(status));
  }
  gStationNetif = esp_netif_create_default_wifi_sta();
  gApNetif = esp_netif_create_default_wifi_ap();
  if (!gStationNetif || !gApNetif) {
    return fail(error, "Could not create Wi-Fi interfaces");
  }
  wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
  status = esp_wifi_init(&config);
  if (status != ESP_OK) {
    return fail(error, std::string("esp_wifi_init failed: ") +
                           esp_err_to_name(status));
  }
  // InkOS already persists the authoritative Wi-Fi credentials in its own
  // NVS namespace.  Keeping the driver's copy in RAM prevents a credential
  // from a previous firmware/run from racing the explicit connection below.
  status = esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (status != ESP_OK) {
    return fail(error, std::string("esp_wifi_set_storage failed: ") +
                           esp_err_to_name(status));
  }
  status = esp_wifi_set_mode(WIFI_MODE_STA);
  if (status != ESP_OK) {
    return fail(error, std::string("esp_wifi_set_mode failed: ") +
                           esp_err_to_name(status));
  }
  gEvents = xEventGroupCreate();
  if (!gEvents) return fail(error, "Could not allocate Wi-Fi event group");
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifiEvent, nullptr);
  esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifiEvent, nullptr);
  status = esp_wifi_start();
  if (status != ESP_OK) {
    return fail(error, std::string("esp_wifi_start failed: ") +
                           esp_err_to_name(status));
  }
  // STA_START is asynchronous.  No connection can have started because the
  // handler above is intentionally passive, so configuration is safe even if
  // connectStation() runs before that event is dispatched.
  xEventGroupSetBits(gEvents, kStationIdleBit);
  gInitialized = true;
  return true;
}

bool connectStation(const DeviceSettings &settings, uint32_t timeoutMs,
                    std::string &error) {
  if (settings.wifiSsid.empty()) return fail(error, "Wi-Fi SSID is not set");
  wifi_config_t config{};
  std::copy_n(settings.wifiSsid.begin(),
              std::min(settings.wifiSsid.size(), sizeof(config.sta.ssid)),
              config.sta.ssid);
  std::copy_n(settings.wifiPassword.begin(),
              std::min(settings.wifiPassword.size(),
                       sizeof(config.sta.password) - 1),
              config.sta.password);
  config.sta.threshold.authmode = settings.wifiPassword.empty()
                                      ? WIFI_AUTH_OPEN
                                      : WIFI_AUTH_WPA2_PSK;
  config.sta.pmf_cfg.capable = true;
  config.sta.pmf_cfg.required = false;
  config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
  config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;

  // A settings-portal save can arrive while the previous STA is still
  // associated or connecting.  Wait for its DISCONNECTED event before
  // changing config; otherwise that late event can either make set_config()
  // return ESP_ERR_WIFI_STATE or be mistaken for failure of the new attempt.
  gConnecting = false;
  if ((xEventGroupGetBits(gEvents) & kStationIdleBit) == 0) {
    xEventGroupClearBits(gEvents, kStationIdleBit);
    const esp_err_t disconnectStatus = esp_wifi_disconnect();
    if (disconnectStatus == ESP_OK) {
      xEventGroupWaitBits(gEvents, kStationIdleBit, pdFALSE, pdTRUE,
                          pdMS_TO_TICKS(2000));
    } else if (disconnectStatus != ESP_ERR_WIFI_NOT_CONNECT &&
               disconnectStatus != ESP_ERR_WIFI_NOT_STARTED) {
      return fail(error, std::string("Wi-Fi disconnect failed: ") +
                             esp_err_to_name(disconnectStatus));
    }
  }
  xEventGroupClearBits(gEvents, kConnectedBit | kFailedBit);
  esp_err_t status =
      esp_wifi_set_mode(gPortalRunning ? WIFI_MODE_APSTA : WIFI_MODE_STA);
  if (status != ESP_OK) {
    return fail(error, std::string("Wi-Fi mode change failed: ") +
                           esp_err_to_name(status));
  }
  status = esp_wifi_set_config(WIFI_IF_STA, &config);
  gConnecting = true;
  if (status == ESP_OK) {
    xEventGroupClearBits(gEvents, kStationIdleBit);
    status = esp_wifi_connect();
  }
  if (status != ESP_OK) {
    gConnecting = false;
    return fail(error, std::string("Wi-Fi configuration failed: ") +
                           esp_err_to_name(status));
  }
  const EventBits_t bits = xEventGroupWaitBits(
      gEvents, kConnectedBit | kFailedBit, pdFALSE, pdFALSE,
      pdMS_TO_TICKS(timeoutMs));
  gConnecting = false;
  if ((bits & kConnectedBit) == 0) {
    // Stop an attempt that merely timed out before opening the AP.  Leaving
    // it in progress would recreate the same set_config race on the next
    // portal save.
    if ((bits & kFailedBit) == 0) {
      xEventGroupClearBits(gEvents, kStationIdleBit);
      const esp_err_t disconnectStatus = esp_wifi_disconnect();
      if (disconnectStatus == ESP_OK) {
        xEventGroupWaitBits(gEvents, kStationIdleBit, pdFALSE, pdTRUE,
                            pdMS_TO_TICKS(2000));
      } else if (disconnectStatus == ESP_ERR_WIFI_NOT_CONNECT ||
                 disconnectStatus == ESP_ERR_WIFI_NOT_STARTED) {
        xEventGroupSetBits(gEvents, kStationIdleBit);
      }
    }
    return fail(error, (bits & kFailedBit) != 0
                           ? "Wi-Fi association failed"
                           : "Wi-Fi connection timed out");
  }
  return true;
}

bool wifiConnected() {
  return gEvents && (xEventGroupGetBits(gEvents) & kConnectedBit) != 0;
}

std::string stationAddress() {
  if (!gStationNetif) return {};
  esp_netif_ip_info_t info{};
  if (esp_netif_get_ip_info(gStationNetif, &info) != ESP_OK) return {};
  char value[16]{};
  esp_ip4addr_ntoa(&info.ip, value, sizeof(value));
  return value;
}

std::string configurationApSsid() {
  uint8_t mac[6]{};
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  char ssid[33]{};
  std::snprintf(ssid, sizeof(ssid), "InkOS-PaperS3-%02X%02X", mac[4], mac[5]);
  return ssid;
}

bool CaptivePortal::start(const DeviceSettings &current, std::string &error) {
  if (!startManager(current, error)) return false;
  if (running_) return true;
  const std::string ssid = configurationApSsid();
  wifi_config_t config{};
  std::strncpy(reinterpret_cast<char *>(config.ap.ssid), ssid.c_str(),
               sizeof(config.ap.ssid) - 1);
  config.ap.ssid_len = ssid.size();
  config.ap.channel = 6;
  config.ap.max_connection = 4;
  config.ap.authmode = WIFI_AUTH_OPEN;
  esp_err_t status = esp_wifi_set_mode(wifiConnected() ? WIFI_MODE_APSTA
                                                        : WIFI_MODE_AP);
  if (status == ESP_OK) status = esp_wifi_set_config(WIFI_IF_AP, &config);
  if (status != ESP_OK) {
    return fail(error, std::string("Configuration AP failed: ") +
                           esp_err_to_name(status));
  }
  gPortalRunning = true;
  TaskHandle_t dns = nullptr;
  if (xTaskCreate(dnsTask, "inkos_dns", 4096, nullptr, 4, &dns) != pdPASS) {
    gPortalRunning = false;
    return fail(error, "Could not start captive DNS task");
  }
  dnsTask_ = dns;
  running_ = true;
  return true;
}

bool CaptivePortal::startManager(const DeviceSettings &current,
                                 std::string &error) {
  if (server_) return true;
  gPortalCurrent = current;
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.max_uri_handlers = 12;
  config.max_open_sockets = 4;
  config.stack_size = 12288;
  config.recv_wait_timeout = 5;
  config.send_wait_timeout = 30;
  config.uri_match_fn = httpd_uri_match_wildcard;
  httpd_handle_t server = nullptr;
  if (httpd_start(&server, &config) != ESP_OK) {
    return fail(error, "Could not start device management HTTP server");
  }
  const std::array<httpd_uri_t, 12> handlers = {{
      {.uri = "/", .method = HTTP_GET, .handler = rootHandler,
       .user_ctx = nullptr},
      {.uri = "/save", .method = HTTP_POST, .handler = saveHandler,
       .user_ctx = nullptr},
      {.uri = "/reset", .method = HTTP_POST, .handler = resetHandler,
       .user_ctx = nullptr},
      {.uri = "/collections", .method = HTTP_POST,
       .handler = collectionsFormHandler, .user_ctx = nullptr},
      {.uri = "/api/state", .method = HTTP_GET, .handler = apiStateHandler,
       .user_ctx = nullptr},
      {.uri = "/api/settings", .method = HTTP_PUT,
       .handler = apiSettingsPutHandler, .user_ctx = nullptr},
      {.uri = "/api/collections", .method = HTTP_GET,
       .handler = apiCollectionsGetHandler, .user_ctx = nullptr},
      {.uri = "/api/collections", .method = HTTP_PUT,
       .handler = apiCollectionsPutHandler, .user_ctx = nullptr},
      {.uri = "/api/home/status", .method = HTTP_GET,
       .handler = apiHomeStatusHandler, .user_ctx = nullptr},
      {.uri = "/api/home", .method = HTTP_PUT,
       .handler = apiHomePutHandler, .user_ctx = nullptr},
      {.uri = "/api/home", .method = HTTP_DELETE,
       .handler = apiHomeDeleteHandler, .user_ctx = nullptr},
      {.uri = "/*", .method = HTTP_GET, .handler = redirectHandler,
       .user_ctx = nullptr},
  }};
  for (const auto &handler : handlers) {
    const esp_err_t registered = httpd_register_uri_handler(server, &handler);
    if (registered != ESP_OK) {
      httpd_stop(server);
      return fail(error, std::string("Could not register management route: ") +
                             handler.uri);
    }
  }
  server_ = server;
  ESP_LOGI(kTag, "device manager HTTP server started on port 80");
  return true;
}

void CaptivePortal::stop() {
  if (!running_) return;
  gPortalRunning = false;
  dnsTask_ = nullptr;
  running_ = false;
  // Keep the HTTP server bound to all interfaces. Once STA obtains an address
  // the exact same manager is reachable at http://<station-ip>/.
  esp_wifi_set_mode(WIFI_MODE_STA);
}

bool CaptivePortal::consumeSaved(DeviceSettings &settings) {
  if (!gPortalStateMutex ||
      xSemaphoreTake(gPortalStateMutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
    return false;
  }
  const bool available = gSavedPending;
  if (gSavedPending) {
    settings = gSavedSettings;
    gSavedPending = false;
  }
  xSemaphoreGive(gPortalStateMutex);
  return available;
}

} // namespace inkos::idf

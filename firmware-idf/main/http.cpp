#include "http.h"

#include "ink_types.h"

#include <esp_crt_bundle.h>
#include <esp_http_client.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <cstdlib>

namespace inkos::idf {
namespace {

struct RequestContext {
  HttpResponse *response = nullptr;
  size_t maximumBytes = 0;
  bool overflow = false;
  size_t headerBytes = 0;
  bool headerOverflow = false;
};

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](char character) {
    return static_cast<char>(
        std::tolower(static_cast<unsigned char>(character)));
  });
  return value;
}

esp_err_t handleEvent(esp_http_client_event_t *event) {
  auto *context = static_cast<RequestContext *>(event->user_data);
  if (!context || !context->response) return ESP_FAIL;
  if (event->event_id == HTTP_EVENT_ON_HEADER && event->header_key &&
      event->header_value) {
    const size_t keyBytes = std::strlen(event->header_key);
    const size_t valueBytes = std::strlen(event->header_value);
    if (keyBytes > kMaximumHttpResponseHeaderBytes -
                       std::min(context->headerBytes,
                                kMaximumHttpResponseHeaderBytes) ||
        valueBytes > kMaximumHttpResponseHeaderBytes -
                         std::min(context->headerBytes + keyBytes,
                                  kMaximumHttpResponseHeaderBytes)) {
      context->headerOverflow = true;
      return ESP_FAIL;
    }
    context->headerBytes += keyBytes + valueBytes;
    context->response->headers[lowercase(event->header_key)] =
        event->header_value;
  } else if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
    auto &body = context->response->body;
    if (body.size() + static_cast<size_t>(event->data_len) >
        context->maximumBytes) {
      context->overflow = true;
      return ESP_FAIL;
    }
    const auto *begin = static_cast<const uint8_t *>(event->data);
    body.insert(body.end(), begin, begin + event->data_len);
  }
  return ESP_OK;
}

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

} // namespace

std::string HttpResponse::header(const std::string &name) const {
  const auto found = headers.find(lowercase(name));
  return found == headers.end() ? std::string{} : found->second;
}

std::string HttpResponse::text() const {
  return std::string(reinterpret_cast<const char *>(body.data()), body.size());
}

bool HttpClient::get(const std::string &url,
                     const std::map<std::string, std::string> &headers,
                     size_t maximumBytes, HttpResponse &response,
                     std::string &error) const {
  return request("GET", url, nullptr, headers, maximumBytes, response, error);
}

bool HttpClient::postJson(
    const std::string &url, const std::string &body,
    const std::map<std::string, std::string> &headers, size_t maximumBytes,
    HttpResponse &response, std::string &error) const {
  return request("POST", url, &body, headers, maximumBytes, response, error);
}

bool HttpClient::request(
    const std::string &method, const std::string &url, const std::string *body,
    const std::map<std::string, std::string> &headers, size_t maximumBytes,
    HttpResponse &response, std::string &error) const {
  if (maximumBytes == 0 ||
      (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0)) {
    return fail(error, "HTTP request has an invalid URL or size limit");
  }
  response = {};
  RequestContext context{&response, maximumBytes, false, 0, false};
  esp_http_client_config_t config{};
  config.url = url.c_str();
  config.event_handler = handleEvent;
  config.user_data = &context;
  config.timeout_ms = 20000;
  // This is a streaming socket chunk, not the complete-header ceiling. IDF's
  // parser appends header fragments across reads; the build and callback apply
  // separate bounded 2 MiB aggregate limits for frame metadata/sidecars.
  config.buffer_size = 16384;
  config.buffer_size_tx = 2048;
  config.disable_auto_redirect = false;
  config.max_redirection_count = 4;
  config.crt_bundle_attach = esp_crt_bundle_attach;
  config.keep_alive_enable = true;
  esp_http_client_handle_t client = esp_http_client_init(&config);
  if (!client) return fail(error, "esp_http_client_init failed");
  esp_http_client_set_method(client, method == "POST" ? HTTP_METHOD_POST
                                                       : HTTP_METHOD_GET);
  esp_http_client_set_header(client, "Accept",
                             "application/json, image/png, image/jpeg");
  esp_http_client_set_header(client, "Cache-Control", "no-cache");
  esp_http_client_set_header(client, "X-Ink-Client", "papers3-idf/1.0.0");
  for (const auto &[key, value] : headers) {
    esp_http_client_set_header(client, key.c_str(), value.c_str());
  }
  if (body) {
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body->data(), body->size());
  }
  const esp_err_t performed = esp_http_client_perform(client);
  response.status = esp_http_client_get_status_code(client);
  response.advertisedLength = esp_http_client_get_content_length(client);
  esp_http_client_cleanup(client);
  if (context.overflow) {
    response.body.clear();
    return fail(error, "HTTP response exceeds the configured byte limit");
  }
  if (context.headerOverflow) {
    response.body.clear();
    response.headers.clear();
    return fail(error, "HTTP response headers exceed the PaperS3 2 MiB limit");
  }
  if (performed != ESP_OK) {
    response.body.clear();
    return fail(error, std::string("HTTP transport failed: ") +
                           esp_err_to_name(performed));
  }
  const std::string contentLength = response.header("content-length");
  if (!contentLength.empty()) {
    char *end = nullptr;
    const unsigned long long parsed =
        std::strtoull(contentLength.c_str(), &end, 10);
    if (!end || *end != '\0' || parsed != response.body.size()) {
      response.body.clear();
      return fail(error, "HTTP Content-Length does not match received bytes");
    }
    response.advertisedLength = static_cast<int64_t>(parsed);
  }
  return true;
}

std::string joinServerUrl(const std::string &baseUrl,
                          const std::string &apiPath) {
  if (baseUrl.empty()) return {};
  if (apiPath.rfind("http://", 0) == 0 || apiPath.rfind("https://", 0) == 0) {
    return apiPath;
  }
  if (apiPath.empty()) return baseUrl;
  if (baseUrl.back() == '/' && apiPath.front() == '/') {
    return baseUrl + apiPath.substr(1);
  }
  if (baseUrl.back() != '/' && apiPath.front() != '/') {
    return baseUrl + '/' + apiPath;
  }
  return baseUrl + apiPath;
}

} // namespace inkos::idf

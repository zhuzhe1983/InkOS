#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace inkos::idf {

struct HttpResponse {
  int status = 0;
  int64_t advertisedLength = -1;
  std::vector<uint8_t> body;
  std::map<std::string, std::string> headers;

  std::string header(const std::string &name) const;
  std::string text() const;
};

class HttpClient {
public:
  bool get(const std::string &url,
           const std::map<std::string, std::string> &headers,
           size_t maximumBytes, HttpResponse &response,
           std::string &error) const;
  bool postJson(const std::string &url, const std::string &body,
                const std::map<std::string, std::string> &headers,
                size_t maximumBytes, HttpResponse &response,
                std::string &error) const;

private:
  bool request(const std::string &method, const std::string &url,
               const std::string *body,
               const std::map<std::string, std::string> &headers,
               size_t maximumBytes, HttpResponse &response,
               std::string &error) const;
};

std::string joinServerUrl(const std::string &baseUrl,
                          const std::string &apiPath);

} // namespace inkos::idf

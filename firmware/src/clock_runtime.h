#pragma once

#include "network_adapter.h"
#include "package_catalog.h"
#include "papers3_hal.h"

#include <InkClock.h>

#include <string>
#include <vector>

namespace inkos::paper {

class ClockRuntime {
public:
  void activate(const FrameSidecar &sidecar, PaperS3Display &display,
                NetworkAdapter &network, const char *wifiSsid,
                const char *wifiPassword, std::string &warning);
  void stop(PaperS3Display &display);
  bool tick(PaperS3Display &display, std::string &error);
  bool active() const { return !regions_.empty(); }

private:
  std::vector<ClockRegion> regions_;
  std::vector<inkos::ClockSchedule> schedules_;
};

} // namespace inkos::paper

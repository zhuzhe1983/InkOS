#include "InkNavigation.h"

#include <limits>

namespace inkos {

bool Bounds::contains(int32_t pointX, int32_t pointY) const {
  if (width <= 0 || height <= 0) {
    return false;
  }
  const int64_t right = static_cast<int64_t>(x) + width;
  const int64_t bottom = static_cast<int64_t>(y) + height;
  return pointX >= x && pointY >= y && static_cast<int64_t>(pointX) < right &&
         static_cast<int64_t>(pointY) < bottom;
}

NavigationCore::NavigationCore(const NavigationCatalog &catalog)
    : catalog_(catalog) {}

bool NavigationCore::reset(const std::string &rootUuid) {
  return resetTo(rootUuid, 0);
}

bool NavigationCore::resetTo(const std::string &documentUuid,
                             uint16_t pageIndex) {
  if (!catalog_.contains(documentUuid) ||
      pageIndex >= catalog_.pageCount(documentUuid)) {
    ready_ = false;
    state_ = {};
    history_.clear();
    return false;
  }
  ready_ = true;
  state_ = {documentUuid, pageIndex};
  history_.clear();
  return true;
}

bool NavigationCore::reconcileCatalog() {
  if (!ready_ || !catalog_.contains(state_.documentUuid)) {
    return false;
  }
  const uint16_t count = catalog_.pageCount(state_.documentUuid);
  if (count == 0) {
    return false;
  }
  if (state_.pageIndex >= count) {
    state_.pageIndex = count - 1;
  }
  for (auto &visit : history_) {
    const uint16_t visitCount = catalog_.pageCount(visit.documentUuid);
    if (visitCount == 0) {
      history_.clear();
      break;
    }
    if (visit.pageIndex >= visitCount) {
      visit.pageIndex = visitCount - 1;
    }
  }
  return true;
}

Transition NavigationCore::noop() const {
  return {TransitionKind::Noop, state_, state_};
}

Transition NavigationCore::goToPage(uint16_t pageIndex) {
  if (!ready_ || pageIndex >= catalog_.pageCount(state_.documentUuid) ||
      pageIndex == state_.pageIndex) {
    return noop();
  }
  const NavigationState before = state_;
  state_.pageIndex = pageIndex;
  return {TransitionKind::PageChanged, before, state_};
}

Transition NavigationCore::openDocument(const std::string &uuid,
                                        uint16_t pageIndex,
                                        bool rememberCurrent) {
  if (!ready_ || !catalog_.contains(uuid)) {
    return noop();
  }
  const uint16_t count = catalog_.pageCount(uuid);
  if (count == 0 || pageIndex >= count) {
    return noop();
  }
  const NavigationState before = state_;
  if (rememberCurrent) {
    history_.push_back(before);
  }
  state_ = {uuid, pageIndex};
  if (state_ == before) {
    return noop();
  }
  return {TransitionKind::DocumentChanged, before, state_};
}

Transition NavigationCore::openParent() {
  if (!ready_) {
    return noop();
  }
  const std::string parent = catalog_.parentOf(state_.documentUuid);
  if (parent.empty() || !catalog_.contains(parent)) {
    return noop();
  }
  const uint16_t count = catalog_.pageCount(parent);
  if (count == 0) {
    return noop();
  }
  const NavigationState before = state_;
  uint16_t restoredPage = 0;
  if (!history_.empty() && history_.back().documentUuid == parent) {
    restoredPage = history_.back().pageIndex < count ? history_.back().pageIndex : count - 1;
    history_.pop_back();
  } else {
    // A canonical parent fallback is deliberately not browser history.
    history_.clear();
  }
  state_ = {parent, restoredPage};
  return {TransitionKind::DocumentChanged, before, state_};
}

Transition NavigationCore::dispatch(NavigationAction action) {
  if (!ready_) {
    return noop();
  }
  switch (action) {
  case NavigationAction::SwipeLeft:
    return openParent();
  case NavigationAction::SwipeUp: {
    const uint16_t count = catalog_.pageCount(state_.documentUuid);
    if (state_.pageIndex + 1 >= count) {
      return noop();
    }
    return goToPage(state_.pageIndex + 1);
  }
  case NavigationAction::SwipeDown:
    if (state_.pageIndex > 0) {
      return goToPage(state_.pageIndex - 1);
    }
    return openParent();
  }
  return noop();
}

Transition NavigationCore::tap(int32_t x, int32_t y,
                               const std::vector<HitTarget> &targets) {
  if (!ready_) {
    return noop();
  }
  const HitTarget *winner = nullptr;
  int64_t winnerArea = std::numeric_limits<int64_t>::max();
  for (const auto &target : targets) {
    if (target.bounds.contains(x, y)) {
      const int64_t area = static_cast<int64_t>(target.bounds.width) *
                           target.bounds.height;
      // Smallest-area wins. Equal areas retain sidecar order.
      if (area < winnerArea) {
        winner = &target;
        winnerArea = area;
      }
    }
  }
  if (winner == nullptr || winner->targetUuid == state_.documentUuid) {
    return noop();
  }
  return openDocument(winner->targetUuid, 0, true);
}

} // namespace inkos

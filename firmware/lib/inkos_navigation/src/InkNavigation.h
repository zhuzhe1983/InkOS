#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace inkos {

struct Bounds {
  int32_t x = 0;
  int32_t y = 0;
  int32_t width = 0;
  int32_t height = 0;

  // Renderer sidecars use half-open rectangles: [x, x + width) x
  // [y, y + height). This keeps adjacent hit targets unambiguous.
  bool contains(int32_t pointX, int32_t pointY) const;
};

struct HitTarget {
  Bounds bounds;
  std::string targetUuid;
};

struct NavigationState {
  std::string documentUuid;
  uint16_t pageIndex = 0;

  bool operator==(const NavigationState &other) const {
    return documentUuid == other.documentUuid && pageIndex == other.pageIndex;
  }
};

enum class NavigationAction : uint8_t {
  SwipeLeft,
  SwipeUp,
  SwipeDown,
};

enum class TransitionKind : uint8_t {
  Noop,
  PageChanged,
  DocumentChanged,
};

struct Transition {
  TransitionKind kind = TransitionKind::Noop;
  NavigationState before;
  NavigationState after;
};

class NavigationCatalog {
public:
  virtual ~NavigationCatalog() = default;
  virtual bool contains(const std::string &uuid) const = 0;
  virtual std::string parentOf(const std::string &uuid) const = 0;
  virtual uint16_t pageCount(const std::string &uuid) const = 0;
};

// Pure, deterministic navigation core shared by the PaperS3 application and
// host tests. It does no I/O and knows nothing about touch sampling or JSON.
class NavigationCore {
public:
  explicit NavigationCore(const NavigationCatalog &catalog);

  bool reset(const std::string &rootUuid);
  bool resetTo(const std::string &documentUuid, uint16_t pageIndex);
  bool reconcileCatalog();
  const NavigationState &state() const { return state_; }
  bool ready() const { return ready_; }

  Transition dispatch(NavigationAction action);
  Transition tap(int32_t x, int32_t y,
                 const std::vector<HitTarget> &targets);

private:
  Transition noop() const;
  Transition goToPage(uint16_t pageIndex);
  Transition openDocument(const std::string &uuid, uint16_t pageIndex,
                          bool rememberCurrent);
  Transition openParent();

  const NavigationCatalog &catalog_;
  NavigationState state_;
  std::vector<NavigationState> history_;
  bool ready_ = false;
};

} // namespace inkos

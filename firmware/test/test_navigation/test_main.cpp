#include <InkNavigation.h>
#include <unity.h>

#include <map>
#include <string>
#include <vector>

namespace {

struct Doc {
  std::string parent;
  uint16_t pages;
};

class FixtureCatalog final : public inkos::NavigationCatalog {
public:
  std::map<std::string, Doc> docs{
      {"root", {"", 3}},
      {"detail", {"root", 2}},
      {"leaf", {"detail", 1}},
      {"empty", {"root", 0}},
  };

  bool contains(const std::string &uuid) const override {
    return docs.find(uuid) != docs.end();
  }
  std::string parentOf(const std::string &uuid) const override {
    const auto it = docs.find(uuid);
    return it == docs.end() ? "" : it->second.parent;
  }
  uint16_t pageCount(const std::string &uuid) const override {
    const auto it = docs.find(uuid);
    return it == docs.end() ? 0 : it->second.pages;
  }
};

FixtureCatalog catalog;

void assertState(const inkos::NavigationCore &nav, const char *uuid,
                 uint16_t page) {
  TEST_ASSERT_EQUAL_STRING(uuid, nav.state().documentUuid.c_str());
  TEST_ASSERT_EQUAL_UINT16(page, nav.state().pageIndex);
}

void test_rejects_missing_or_empty_root() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_FALSE(nav.reset("missing"));
  TEST_ASSERT_FALSE(nav.ready());
  TEST_ASSERT_FALSE(nav.reset("empty"));
  TEST_ASSERT_FALSE(nav.ready());
}

void test_up_pages_and_stops_at_end() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("root"));
  TEST_ASSERT_EQUAL(inkos::TransitionKind::PageChanged,
                    nav.dispatch(inkos::NavigationAction::SwipeUp).kind);
  assertState(nav, "root", 1);
  nav.dispatch(inkos::NavigationAction::SwipeUp);
  assertState(nav, "root", 2);
  TEST_ASSERT_EQUAL(inkos::TransitionKind::Noop,
                    nav.dispatch(inkos::NavigationAction::SwipeUp).kind);
  assertState(nav, "root", 2);
}

void test_down_pages_then_opens_parent() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("detail"));
  nav.dispatch(inkos::NavigationAction::SwipeUp);
  TEST_ASSERT_EQUAL(inkos::TransitionKind::PageChanged,
                    nav.dispatch(inkos::NavigationAction::SwipeDown).kind);
  assertState(nav, "detail", 0);
  TEST_ASSERT_EQUAL(inkos::TransitionKind::DocumentChanged,
                    nav.dispatch(inkos::NavigationAction::SwipeDown).kind);
  assertState(nav, "root", 0);
}

void test_left_always_opens_parent_and_root_is_noop() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("detail"));
  nav.dispatch(inkos::NavigationAction::SwipeUp);
  nav.dispatch(inkos::NavigationAction::SwipeLeft);
  assertState(nav, "root", 0);
  TEST_ASSERT_EQUAL(inkos::TransitionKind::Noop,
                    nav.dispatch(inkos::NavigationAction::SwipeLeft).kind);
}

void test_parent_restores_last_known_page() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("root"));
  nav.dispatch(inkos::NavigationAction::SwipeUp);
  nav.dispatch(inkos::NavigationAction::SwipeUp);
  nav.tap(10, 10, {{{0, 0, 20, 20}, "detail"}});
  assertState(nav, "detail", 0);
  nav.dispatch(inkos::NavigationAction::SwipeLeft);
  assertState(nav, "root", 2);
}

void test_tap_uses_half_open_bounds_and_opens_page_zero() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("root"));
  const std::vector<inkos::HitTarget> targets{
      {{10, 20, 30, 40}, "detail"},
  };
  TEST_ASSERT_EQUAL(inkos::TransitionKind::Noop, nav.tap(40, 20, targets).kind);
  TEST_ASSERT_EQUAL(inkos::TransitionKind::Noop, nav.tap(10, 60, targets).kind);
  TEST_ASSERT_EQUAL(inkos::TransitionKind::DocumentChanged,
                    nav.tap(39, 59, targets).kind);
  assertState(nav, "detail", 0);
}

void test_tap_missing_target_is_noop() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("root"));
  TEST_ASSERT_EQUAL(
      inkos::TransitionKind::Noop,
      nav.tap(5, 5, {{{0, 0, 10, 10}, "not-in-catalog"}}).kind);
  assertState(nav, "root", 0);
}

void test_smallest_overlapping_hitbox_wins_and_ties_keep_order() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("root"));
  const std::vector<inkos::HitTarget> nested{
      {{0, 0, 100, 100}, "detail"},
      {{10, 10, 20, 20}, "leaf"},
  };
  nav.tap(15, 15, nested);
  assertState(nav, "leaf", 0);

  TEST_ASSERT_TRUE(nav.reset("root"));
  const std::vector<inkos::HitTarget> tied{
      {{0, 0, 20, 20}, "detail"},
      {{0, 0, 20, 20}, "leaf"},
  };
  nav.tap(5, 5, tied);
  assertState(nav, "detail", 0);
}

void test_self_link_is_noop() {
  inkos::NavigationCore nav(catalog);
  TEST_ASSERT_TRUE(nav.reset("root"));
  TEST_ASSERT_EQUAL(inkos::TransitionKind::Noop,
                    nav.tap(5, 5, {{{0, 0, 10, 10}, "root"}}).kind);
  assertState(nav, "root", 0);
}

void test_reset_to_validates_page_and_reconcile_clamps_after_variant_change() {
  FixtureCatalog mutableCatalog;
  inkos::NavigationCore nav(mutableCatalog);
  TEST_ASSERT_TRUE(nav.resetTo("root", 2));
  assertState(nav, "root", 2);
  TEST_ASSERT_FALSE(nav.resetTo("root", 3));
  TEST_ASSERT_FALSE(nav.ready());

  TEST_ASSERT_TRUE(nav.resetTo("root", 2));
  mutableCatalog.docs["root"].pages = 1;
  TEST_ASSERT_TRUE(nav.reconcileCatalog());
  assertState(nav, "root", 0);
  mutableCatalog.docs["root"].pages = 0;
  TEST_ASSERT_FALSE(nav.reconcileCatalog());
}

} // namespace

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_rejects_missing_or_empty_root);
  RUN_TEST(test_up_pages_and_stops_at_end);
  RUN_TEST(test_down_pages_then_opens_parent);
  RUN_TEST(test_left_always_opens_parent_and_root_is_noop);
  RUN_TEST(test_parent_restores_last_known_page);
  RUN_TEST(test_tap_uses_half_open_bounds_and_opens_page_zero);
  RUN_TEST(test_tap_missing_target_is_noop);
  RUN_TEST(test_smallest_overlapping_hitbox_wins_and_ties_keep_order);
  RUN_TEST(test_self_link_is_noop);
  RUN_TEST(test_reset_to_validates_page_and_reconcile_clamps_after_variant_change);
  return UNITY_END();
}

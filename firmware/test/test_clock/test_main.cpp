#include <InkClock.h>
#include <unity.h>

#include <cstdint>
#include <limits>

using namespace inkos;

void test_clock_bounds_are_half_open_and_overflow_safe() {
  TEST_ASSERT_TRUE(clockBoundsInside({0, 0, 540, 960}, 540, 960));
  TEST_ASSERT_TRUE(clockBoundsInside({440, 900, 100, 60}, 540, 960));
  TEST_ASSERT_FALSE(clockBoundsInside({-1, 0, 10, 10}, 540, 960));
  TEST_ASSERT_FALSE(clockBoundsInside({0, 0, 0, 10}, 540, 960));
  TEST_ASSERT_FALSE(clockBoundsInside({500, 900, 41, 60}, 540, 960));
  TEST_ASSERT_FALSE(clockBoundsInside(
      {std::numeric_limits<int32_t>::max(), 0, 100, 10}, 540, 960));
}

void test_clock_format_uses_shanghai_utc_plus_eight() {
  TEST_ASSERT_EQUAL_STRING("08:00:00", formatShanghaiHms(0).c_str());
  TEST_ASSERT_EQUAL_STRING("07:59:59", formatShanghaiHms(86399).c_str());
  TEST_ASSERT_EQUAL_STRING("00:00:00", formatShanghaiHms(16 * 60 * 60).c_str());
  TEST_ASSERT_FALSE(usableClockEpoch(0));
  TEST_ASSERT_TRUE(usableClockEpoch(1483228800));
}

void test_clock_schedule_coalesces_delays_and_cleans_every_sixty_ticks() {
  ClockSchedule schedule;
  schedule.start(100);
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Fast),
                    static_cast<int>(schedule.poll(100)));
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::None),
                    static_cast<int>(schedule.poll(1099)));
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Fast),
                    static_cast<int>(schedule.poll(1100)));
  TEST_ASSERT_EQUAL_UINT16(2, schedule.refreshCount());

  for (uint16_t tick = 3; tick <= 59; ++tick) {
    TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Fast),
                      static_cast<int>(schedule.poll(1100 + (tick - 1) * 1000)));
  }
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Clean),
                    static_cast<int>(schedule.poll(60100)));
  schedule.stop();
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::None),
                    static_cast<int>(schedule.poll(61100)));
}

void test_clock_schedule_handles_millis_wraparound() {
  ClockSchedule schedule;
  constexpr uint32_t start = std::numeric_limits<uint32_t>::max() - 500;
  schedule.start(start);
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Fast),
                    static_cast<int>(schedule.poll(start)));
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::None),
                    static_cast<int>(schedule.poll(498)));
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Fast),
                    static_cast<int>(schedule.poll(499)));
}

void test_clock_schedule_honors_server_owned_cadence() {
  ClockSchedule schedule;
  schedule.start(200, 5000, 2);
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Fast),
                    static_cast<int>(schedule.poll(200)));
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::None),
                    static_cast<int>(schedule.poll(5199)));
  TEST_ASSERT_EQUAL(static_cast<int>(ClockRefresh::Clean),
                    static_cast<int>(schedule.poll(5200)));
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_clock_bounds_are_half_open_and_overflow_safe);
  RUN_TEST(test_clock_format_uses_shanghai_utc_plus_eight);
  RUN_TEST(test_clock_schedule_coalesces_delays_and_cleans_every_sixty_ticks);
  RUN_TEST(test_clock_schedule_handles_millis_wraparound);
  RUN_TEST(test_clock_schedule_honors_server_owned_cadence);
  return UNITY_END();
}

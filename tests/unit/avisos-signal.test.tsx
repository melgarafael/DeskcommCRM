import React from "react";
import { test, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
const m = vi.hoisted(() => ({ channel: vi.fn() }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: m.channel }));
import { useNoticeSignal } from "@/hooks/realtime/useNoticeSignal";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
test("StrictMode cleanup/setup keeps fresh burst alive; real cleanup cancels late signal", () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const h = renderHook(() => useNoticeSignal("platform_alerts", refresh), {
    wrapper: React.StrictMode,
  });
  const emit = m.channel.mock.calls.at(-1)![0].onChange;
  act(() => {
    emit({
      new: {
        organization_id: "00000000-0000-4000-8000-000000000001",
        table_name: "platform_alerts",
        change_token: "10000000-0000-4000-8000-000000000001",
      },
    });
    vi.advanceTimersByTime(100);
  });
  expect(refresh).toHaveBeenCalledOnce();
  h.unmount();
  act(() => {
    emit({ tipo: "reassinado" });
    vi.advanceTimersByTime(100);
  });
  expect(refresh).toHaveBeenCalledOnce();
});

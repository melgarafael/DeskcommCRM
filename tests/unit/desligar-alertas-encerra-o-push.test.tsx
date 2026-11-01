/**
 * Desligar os alertas pelo hook encerra o push do aparelho; ligar reinscreve.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ encerrar: vi.fn(async () => {}), sync: vi.fn(async () => {}) }));

vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/notifications/sounds", () => ({ resumeAudio: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/service_worker", () => ({ ensureNotifyServiceWorker: vi.fn(async () => null) }));
vi.mock("@/lib/notifications/push_client", () => ({
  encerrarPushDesteAparelho: mocks.encerrar,
  syncPushSubscription: mocks.sync,
}));

import { useNotificationPermission } from "@/hooks/notifications/useNotificationPermission";

beforeEach(() => vi.clearAllMocks());

describe("useNotificationPermission.setEnabled", () => {
  it("desligar encerra o push deste aparelho", () => {
    const { result } = renderHook(() => useNotificationPermission());
    act(() => result.current.setEnabled(false));
    expect(mocks.encerrar).toHaveBeenCalledTimes(1);
  });

  it("ligar não encerra", () => {
    const { result } = renderHook(() => useNotificationPermission());
    act(() => result.current.setEnabled(true));
    expect(mocks.encerrar).not.toHaveBeenCalled();
  });
});

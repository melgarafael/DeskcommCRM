// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxPreferenceKey } from "@/lib/ui-themes/inbox-presentation";
import { useInboxPresentation } from "./useInboxPresentation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const root = createRef<HTMLDivElement>();
const sizes = { lista: 272, ficha: 300 };
const config = { contactMode: "adaptive", initialContactPinned: true } as const;

describe("preferências de apresentação do inbox", () => {
  it("isola organização e usuário ao navegar e propaga a alteração na sessão", () => {
    const first = renderHook(
      ({ org, user }) => useInboxPresentation(config, org, user, root, sizes),
      { initialProps: { org: "scope-a", user: "user-a" } },
    );
    const other = renderHook(() => useInboxPresentation(config, "scope-a", "user-a", root, sizes));
    act(() => first.result.current.setPinned(false));
    expect(other.result.current.preference.pinned).toBe(false);
    first.rerender({ org: "scope-b", user: "user-a" });
    expect(first.result.current.preference.pinned).toBe(true);
    first.rerender({ org: "scope-a", user: "user-b" });
    expect(first.result.current.preference.pinned).toBe(true);
    first.rerender({ org: "scope-a", user: "user-a" });
    expect(first.result.current.preference.pinned).toBe(false);
  });

  it("mantém controles utilizáveis quando o navegador recusa a persistência", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() =>
      useInboxPresentation(config, "blocked-org", "blocked-user", root, sizes),
    );
    act(() => result.current.setPinned(false));
    act(() => result.current.toggleCollapsed());
    expect(result.current.preference).toEqual({ pinned: false, collapsed: true });
  });

  it("relê somente a preferência pertinente alterada por outra aba", () => {
    const { result } = renderHook(() =>
      useInboxPresentation(config, "external-org", "external-user", root, sizes),
    );
    act(() => result.current.setPinned(false));
    const key = inboxPreferenceKey("external-org", "external-user", "panel")!;
    window.localStorage.setItem(key, JSON.stringify({ pinned: true, collapsed: true }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })));
    expect(result.current.preference.pinned).toBe(false);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key })));
    expect(result.current.preference).toEqual({ pinned: true, collapsed: true });
  });
});

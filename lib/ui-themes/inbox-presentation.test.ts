import { describe, expect, it } from "vitest";
import { compatibleArea } from "./contracts";
import { inboxArea } from "./areas";
import { resolverLarguras } from "@/lib/inbox/larguras-do-inbox";
import {
  readInboxPanel,
  resolveAdaptiveInbox,
  scopedInboxStorage,
  writeInboxPanel,
} from "./inbox-presentation";

describe("inbox presentation contract", () => {
  it("honors a presentation reading floor while preserving the native default", () => {
    const pedido = { lista: 400, ficha: 300, larguraContainer: 1150, temFicha: true };
    expect(resolverLarguras(pedido)).toEqual({ lista: 400, ficha: 300 });
    expect(resolverLarguras({ ...pedido, conversaMinima: 500 })).toEqual({
      lista: 350,
      ficha: 300,
    });
  });
  it("refuses unsupported configuration instead of hiding native content", () => {
    expect(
      compatibleArea(
        {
          contractVersion: 1,
          configuration: { contactMode: "adaptive", minimumConversationWidth: 0 },
          regions: {},
        },
        inboxArea,
      ),
    ).toBe(false);
    expect(
      compatibleArea(
        { contractVersion: 1, configuration: { runAgent: true }, regions: {} },
        inboxArea,
      ),
    ).toBe(false);
    expect(compatibleArea({ contractVersion: 1, configuration: {}, regions: {} }, inboxArea)).toBe(
      true,
    );
  });
  it("uses useful width rather than a device name, preserving a reading minimum", () => {
    const config = { minimumConversationWidth: 500 };
    const sizes = { lista: 260, ficha: 280 };
    const pinned = { pinned: true, collapsed: false };
    expect(resolveAdaptiveInbox(1040, pinned, config, sizes).inlineContact).toBe(true);
    const narrower = resolveAdaptiveInbox(1000, pinned, config, sizes);
    expect(narrower.inlineContact).toBe(false);
    expect(narrower.mobile).toBe(false);
    expect(narrower.gridTemplateColumns).toBe("260px minmax(0,1fr)");
    expect(resolveAdaptiveInbox(759, pinned, config, sizes).mobile).toBe(true);
    expect(resolveAdaptiveInbox(0, pinned, config, sizes).mobile).toBe(true);
    expect(
      resolveAdaptiveInbox(1200, { ...pinned, pinned: false }, config, sizes).inlineContact,
    ).toBe(false);
  });
  it("keeps an expandable rail when collapsed and enough room remains", () => {
    expect(
      resolveAdaptiveInbox(
        900,
        { pinned: true, collapsed: true },
        { minimumConversationWidth: 500 },
        { lista: 260, ficha: 280 },
      ).gridTemplateColumns,
    ).toBe("260px minmax(0,1fr) 44px");
  });
  it("scopes widths and panel state by user, organization and area", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const first = scopedInboxStorage(storage, "org-a", "user-a");
    writeInboxPanel(first, { pinned: false, collapsed: true });
    expect(readInboxPanel(first, true)).toEqual({ pinned: false, collapsed: true });
    expect(readInboxPanel(scopedInboxStorage(storage, "org-b", "user-a"), true)).toEqual({
      pinned: true,
      collapsed: false,
    });
    expect(readInboxPanel(scopedInboxStorage(storage, "org-a", "user-b"), true)).toEqual({
      pinned: true,
      collapsed: false,
    });
    expect(scopedInboxStorage(storage, null, "user-a")).toBeNull();
    expect(data.has("inbox:divisorias:xl")).toBe(false);
  });
  it("survives blocked or corrupt local storage", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readInboxPanel(denied, false)).toEqual({ pinned: false, collapsed: false });
    expect(() => writeInboxPanel(denied, { pinned: true, collapsed: false })).not.toThrow();
    expect(
      readInboxPanel({ getItem: () => "{bad", setItem: () => {}, removeItem: () => {} }, true),
    ).toEqual({ pinned: true, collapsed: false });
  });
});

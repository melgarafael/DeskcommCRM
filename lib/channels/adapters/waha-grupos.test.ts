import type { WahaClient } from "@/lib/waha/client";
import type * as WahaClientModule from "@/lib/waha/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listarGrupos = vi.fn();
const definirRecebimentoDeGrupos = vi.fn();
vi.mock("@/lib/waha/client", async () => {
  const actual = await vi.importActual<typeof WahaClientModule>("@/lib/waha/client");
  return {
    ...actual,
    getWahaClient: () => ({ listarGrupos, definirRecebimentoDeGrupos } as Partial<WahaClient>),
  };
});

import { wahaAdapter } from "./waha";

beforeEach(() => {
  listarGrupos.mockReset();
  definirRecebimentoDeGrupos.mockReset();
});

describe("adapter: grupos", () => {
  it("lista grupos pela sessão", async () => {
    listarGrupos.mockResolvedValue([{ chatId: "1@g.us", subject: "A" }]);
    await expect(wahaAdapter.listGroups!({ sessionRef: "s1" })).resolves.toEqual([
      { chatId: "1@g.us", subject: "A" },
    ]);
    expect(listarGrupos).toHaveBeenCalledWith("s1");
  });

  it("repassa a pós-condição do liga/desliga", async () => {
    definirRecebimentoDeGrupos.mockResolvedValue(false);
    await expect(wahaAdapter.setGroupIntake!({ sessionRef: "s1", receive: true })).resolves.toBe(false);
    expect(definirRecebimentoDeGrupos).toHaveBeenCalledWith("s1", true);
  });
});

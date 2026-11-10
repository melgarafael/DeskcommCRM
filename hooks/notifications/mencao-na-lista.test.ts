/**
 * A nota que cita alguém marca a CONVERSA na lista (#2372).
 *
 * O sino e o toast já nasciam no mesmo listener; este teste prende a única parte
 * que a lista consome: a conversa da nota entra na marca. Quem foi citado numa
 * nota de OUTRA pessoa vê a linha marcada; autor da própria nota, nota que não
 * cita ninguém e troca de organização não marcam nada.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sessao, canais, entregar } = vi.hoisted(() => ({
  sessao: { orgId: "org-a" as string | null, userId: "pessoa-a" },
  canais: {} as Record<string, (payload: unknown) => void>,
  entregar: vi.fn(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => (sessao.orgId ? { orgId: sessao.orgId } : null),
  useUser: () => ({ id: sessao.userId, email: "sintetico@example.test", full_name: "Pessoa sintética" }),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { name: string; onChange: (p: unknown) => void }) => {
    canais[opts.name] = opts.onChange;
    return { status: "subscribed" };
  },
}));
vi.mock("./eventos-do-negocio", () => ({ buscaEventosDoNegocio: vi.fn() }));
vi.mock("@/lib/notifications/deliver", () => ({ entregarAviso: entregar }));

import {
  conversasComMencao,
  limparMencoesDaLista,
} from "@/lib/notifications/mencao-na-lista";

import { useCrmAlerts } from "./useCrmAlerts";

function nota(input: { body: string; de?: string; conversa?: string }) {
  return {
    new: {
      id: "nota-1",
      organization_id: sessao.orgId,
      conversation_id: input.conversa ?? "conv-1",
      body: input.body,
      created_by_user_id: input.de ?? "pessoa-b",
      created_at: "2026-11-07T12:00:00.000Z",
    },
  };
}

function emitirNota(input: Parameters<typeof nota>[0]) {
  act(() => {
    canais[`alerts-notes-${sessao.orgId}`]!(nota(input));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  limparMencoesDaLista();
  sessao.orgId = "org-a";
  sessao.userId = "pessoa-a";
  for (const nome of Object.keys(canais)) delete canais[nome];
});

describe("useCrmAlerts — nota que menciona marca a conversa", () => {
  it("menção estrutural (id do autocompletar) marca a conversa da nota", () => {
    renderHook(() => useCrmAlerts());
    emitirNota({ body: "Fala com @[Pessoa sintética](mencao:pessoa-a) sobre o orçamento" });
    expect(conversasComMencao().has("conv-1")).toBe(true);
    expect(entregar).toHaveBeenCalledWith(expect.objectContaining({ category: "mention" }));
  });

  it("nota que cita outra pessoa não marca a minha lista", () => {
    renderHook(() => useCrmAlerts());
    emitirNota({ body: "Fala com @[Outra pessoa](mencao:pessoa-b) sobre o orçamento" });
    expect(conversasComMencao().has("conv-1")).toBe(false);
  });

  it("a minha própria nota não me marca", () => {
    renderHook(() => useCrmAlerts());
    emitirNota({
      body: "Fala com @[Pessoa sintética](mencao:pessoa-a)",
      de: "pessoa-a",
    });
    expect(conversasComMencao().has("conv-1")).toBe(false);
  });

  it("a marca não sobrevive à troca de organização", () => {
    const hook = renderHook(() => useCrmAlerts());
    emitirNota({ body: "@[Pessoa sintética](mencao:pessoa-a)" });
    expect(conversasComMencao().has("conv-1")).toBe(true);
    act(() => {
      sessao.orgId = "org-b";
      hook.rerender();
    });
    expect(conversasComMencao().has("conv-1")).toBe(false);
  });
});

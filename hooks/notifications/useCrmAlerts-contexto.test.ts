import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sessao, canais, buscar, entregar } = vi.hoisted(() => ({
  sessao: { orgId: "org-a" as string | null, userId: "pessoa-a" },
  canais: {} as Record<string, (payload: unknown) => void>,
  buscar: vi.fn(),
  entregar: vi.fn(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => sessao.orgId ? { orgId: sessao.orgId } : null,
  useUser: () => ({ id: sessao.userId, email: "sintetico@example.test", full_name: "Pessoa sintética" }),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { name: string; onChange: (p: unknown) => void }) => {
    canais[opts.name] = opts.onChange;
    return { status: "subscribed" };
  },
}));
vi.mock("./eventos-do-negocio", () => ({ buscaEventosDoNegocio: buscar }));
vi.mock("@/lib/notifications/deliver", () => ({ entregarAviso: entregar }));

import type { EventoDeNegocio } from "./aviso-de-negocio";
import { useCrmAlerts } from "./useCrmAlerts";

const CARIMBO = "2026-10-25T15:00:01.123456Z";
const LEAD = "negocio-a";
function pendente() {
  let resolver!: (eventos: EventoDeNegocio[]) => void;
  const promessa = new Promise<EventoDeNegocio[]>((resolve) => { resolver = resolve; });
  return { promessa, resolver };
}
function linha(orgId = "org-a", userId = "pessoa-a"): EventoDeNegocio {
  return { organization_id: orgId, entity_id: LEAD, event_type: "lead.assigned", created_at: CARIMBO, to_user_id: userId };
}
function update(owner: string | null = "pessoa-a", extra: Record<string, unknown> = {}) {
  return {
    old: { id: LEAD },
    new: { id: LEAD, organization_id: sessao.orgId, title: "Negócio sintético", pipeline_id: "funil-a", status: "open", updated_at: CARIMBO, owner_user_id: owner, ...extra },
  };
}
function emitir(owner: string | null = "pessoa-a", extra: Record<string, unknown> = {}) {
  act(() => { canais[`alerts-leads-${sessao.orgId}`]!(update(owner, extra)); });
}
async function responder(p: ReturnType<typeof pendente>, eventos = [linha()]) {
  await act(async () => { p.resolver(eventos); await p.promessa; });
}

beforeEach(() => {
  vi.clearAllMocks();
  buscar.mockReset();
  sessao.orgId = "org-a";
  sessao.userId = "pessoa-a";
  for (const nome of Object.keys(canais)) delete canais[nome];
});

describe("a consulta pendente dos avisos pertence ao contexto em que começou", () => {
  it.each(["org", "pessoa", "sem-org"])("descarta resposta depois da mudança de %s", async (mudanca) => {
    const p = pendente();
    buscar.mockReturnValueOnce(p.promessa);
    const hook = renderHook(() => useCrmAlerts());
    emitir();
    expect(buscar).toHaveBeenCalledWith(LEAD);
    act(() => {
      if (mudanca === "org") sessao.orgId = "org-b";
      else if (mudanca === "pessoa") sessao.userId = "pessoa-b";
      else sessao.orgId = null;
      hook.rerender();
    });
    await responder(p);
    expect(entregar).not.toHaveBeenCalled();
  });

  it("descarta resposta depois de desmontar o hook", async () => {
    const p = pendente();
    buscar.mockReturnValueOnce(p.promessa);
    const hook = renderHook(() => useCrmAlerts());
    emitir();
    hook.unmount();
    await responder(p);
    expect(entregar).not.toHaveBeenCalled();
  });

  it("voltar à org A não revalida a consulta antiga; a geração atual ainda avisa", async () => {
    const antiga = pendente();
    const atual = pendente();
    buscar.mockReturnValueOnce(antiga.promessa).mockReturnValueOnce(atual.promessa);
    const hook = renderHook(() => useCrmAlerts());
    emitir();
    act(() => { sessao.orgId = "org-b"; hook.rerender(); });
    act(() => { sessao.orgId = "org-a"; hook.rerender(); });
    emitir();
    expect(buscar).toHaveBeenCalledTimes(2);
    await responder(antiga);
    expect(entregar).not.toHaveBeenCalled();
    await responder(atual);
    expect(entregar).toHaveBeenCalledTimes(1);
    expect(entregar).toHaveBeenCalledWith(expect.objectContaining({ category: "lead_assigned", tag: LEAD }));
  });

  it.each([null, "pessoa-b"])("UPDATE posterior retira o responsável (%s): resposta antiga não avisa", async (dono) => {
    const p = pendente();
    buscar.mockReturnValueOnce(p.promessa);
    renderHook(() => useCrmAlerts());
    emitir();
    emitir(dono, { updated_at: "2026-10-25T15:00:02.123456Z" });
    await responder(p);
    expect(entregar).not.toHaveBeenCalled();
  });

  it("uma nova atribuição à mesma pessoa não revalida a consulta anterior à retirada", async () => {
    const p = pendente();
    buscar.mockReturnValueOnce(p.promessa);
    renderHook(() => useCrmAlerts());
    emitir();
    emitir("pessoa-b", { updated_at: "2026-10-25T15:00:02.123456Z" });
    emitir("pessoa-a", { updated_at: "2026-10-25T15:00:03.123456Z" });
    // A nova transição já avisou pelo histórico; a consulta antiga perdeu o destinatário.
    expect(entregar).toHaveBeenCalledTimes(1);
    await responder(p);
    expect(entregar).toHaveBeenCalledTimes(1);
  });

  it("controle: contexto ativo e responsável mantido recebem o evento confirmado", async () => {
    const p = pendente();
    buscar.mockReturnValueOnce(p.promessa);
    renderHook(() => useCrmAlerts());
    emitir();
    await responder(p);
    expect(entregar).toHaveBeenCalledTimes(1);
    expect(entregar).toHaveBeenCalledWith(expect.objectContaining({ category: "lead_assigned", tag: LEAD, body: "Negócio sintético" }));
  });

  it("controle: UPDATE irrelevante com o mesmo dono não cancela a confirmação pendente", async () => {
    const p = pendente();
    buscar.mockReturnValueOnce(p.promessa);
    renderHook(() => useCrmAlerts());
    emitir();
    emitir("pessoa-a", { updated_at: "2026-10-25T15:00:02.123456Z", last_activity_at: "2026-10-25T15:00:02.123456Z" });
    await responder(p);
    expect(entregar).toHaveBeenCalledTimes(1);
    expect(buscar).toHaveBeenCalledTimes(1);
  });
});

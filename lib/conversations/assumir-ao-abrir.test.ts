import { describe, expect, it, vi } from "vitest";

import { assumeParaQuemClicou, type QuemClicou } from "./assumir-ao-abrir";

const ORG = "org-1";
const ELA = "user-ela";
const CONV = "conv-1";

type Dono = { assigned_to_user_id: string | null; assigned_to_user_name: string | null };

/** Admin falso: o cargo de quem clicou e o dono da conversa (uma leitura por item de `donos`). */
function adminFalso(role: string | null, donos: Array<Dono | null>) {
  const leituras = [...donos];
  return {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) q[m] = () => q;
      q.maybeSingle = async () =>
        tabela === "user_organizations"
          ? { data: role === null ? null : { role } }
          : { data: leituras.length > 1 ? leituras.shift() : leituras[0] };
      return q;
    },
  } as never;
}

function quem(over: Partial<QuemClicou> = {}, rpc = vi.fn(async () => ({ data: [{ id: CONV }], error: null }))) {
  return {
    quem: { via: "session", actor: { type: "user", id: ELA }, organizationId: ORG, supabase: { rpc } as never, ...over },
    rpc,
  };
}

const livre: Dono = { assigned_to_user_id: null, assigned_to_user_name: null };

describe("quem abre a conversa pelo cartão a assume", () => {
  it("atendente + conversa livre: assume com 'claim' e só se estiver livre, e não avisa nada", async () => {
    const { quem: q, rpc } = quem();
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [livre]), CONV)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("fn_conversation_assign", {
      p_organization_id: ORG,
      p_conversation_id: CONV,
      p_to_user_id: ELA,
      p_reason: "claim",
      p_enforce_expected: true,
    });
  });

  it("token de servidor não assume nada", async () => {
    const { quem: q, rpc } = quem({ via: "token", actor: { type: "api_token", id: "t" } });
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [livre]), CONV)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("gerente e administrador não assumem: já enxergam tudo e não tiram a conversa da distribuição", async () => {
    for (const role of ["manager", "admin", "viewer", null]) {
      const { quem: q, rpc } = quem();
      expect(await assumeParaQuemClicou(q, adminFalso(role, [livre]), CONV)).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("conversa que já é da própria atendente: nada a fazer", async () => {
    const { quem: q, rpc } = quem();
    const minha: Dono = { assigned_to_user_id: ELA, assigned_to_user_name: "Ela" };
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [minha]), CONV)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("conversa de OUTRA pessoa: não tira, e devolve o nome para a tela avisar", async () => {
    const { quem: q, rpc } = quem();
    const dela: Dono = { assigned_to_user_id: "outra", assigned_to_user_name: "  Karina " };
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [dela]), CONV)).toBe("Karina");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("dono sem nome cadastrado: cai no rótulo genérico", async () => {
    const { quem: q } = quem();
    const semNome: Dono = { assigned_to_user_id: "outra", assigned_to_user_name: null };
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [semNome]), CONV)).toBe("outra atendente");
  });

  it("perdeu a corrida (a atribuição não devolveu linha): relê e avisa o dono certo", async () => {
    const { quem: q } = quem({}, vi.fn(async () => ({ data: [], error: null })));
    const venceu: Dono = { assigned_to_user_id: "outra", assigned_to_user_name: "Naiara" };
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [livre, venceu]), CONV)).toBe("Naiara");
  });

  it("perdeu a corrida mas o dono virou ela mesma: sem aviso", async () => {
    const { quem: q } = quem({}, vi.fn(async () => ({ data: [], error: null })));
    const eu: Dono = { assigned_to_user_id: ELA, assigned_to_user_name: "Ela" };
    expect(await assumeParaQuemClicou(q, adminFalso("agent", [livre, eu]), CONV)).toBeNull();
  });
});

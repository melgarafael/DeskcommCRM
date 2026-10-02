/**
 * A linha "campanhas" da matriz de suspensão (§6a), agora que a superfície
 * EXISTE (migration 0375).
 *
 * Este arquivo substitui `suspensao-campanha-nao-existe.test.ts`, que era o
 * congelamento: ele ficava vermelho no dia em que alguém criasse disparo em
 * massa, justamente para obrigar esta decisão em vez de deixar a linha
 * "coberta" num documento. O dia chegou: organização suspensa não fala com
 * ninguém, e a régua é a de `lib/organizacao/operante.ts` — prospecção ativa é
 * a última coisa que ela deveria continuar fazendo.
 *
 * Mede pelo COMPORTAMENTO (a rodada não escolhe nem PROMOVE a campanha da org
 * suspensa), não pela presença do filtro no código: um teste que procurasse a
 * string `suspended` ficaria verde com o filtro aplicado à consulta errada.
 */
import { describe, expect, it, vi } from "vitest";

const avisos = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock("@/lib/logger", () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
    warn: (msg: string, meta: Record<string, unknown>) => avisos.push([msg, meta]),
  },
}));

import { registrarExcecaoDoEnvio, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

const ORG_SUSPENSA = "11111111-1111-4111-8111-111111111111";

interface Chamada {
  tabela: string;
  operacao: "select" | "update";
  not?: [string, string, string];
  neq?: [string, string];
}

/** Supabase falso: registra o que foi perguntado e devolve o que o teste manda. */
function fakeAdmin(opts: { suspensas: string[]; campanhas: unknown[]; erroNaBusca?: string }) {
  const chamadas: Chamada[] = [];
  const builder = (tabela: string) => {
    const estado: {
      not?: [string, string, string];
      neq?: [string, string];
      operacao: "select" | "update";
    } = {
      operacao: "select",
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => {
        estado.operacao = "update";
        return b;
      },
      eq: () => b,
      lte: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      neq: (coluna: string, valor: string) => {
        estado.neq = [coluna, valor];
        return b;
      },
      not: (coluna: string, op: string, valor: string) => {
        estado.not = [coluna, op, valor];
        return b;
      },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        chamadas.push({ tabela, operacao: estado.operacao, not: estado.not, neq: estado.neq });
        const data =
          tabela === "organizations"
            ? opts.suspensas.map((id) => ({ id }))
            : estado.operacao === "update"
              ? []
              : opts.campanhas;
        if (opts.erroNaBusca && tabela === "campaigns" && estado.operacao === "select") {
          return Promise.resolve({ data: null, error: { message: opts.erroNaBusca } }).then(resolve);
        }
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { admin: { from: (t: string) => builder(t) }, chamadas };
}

describe("suspensão × campanha", () => {
  it("parada é tudo que não é 'active' — redigida e arquivada também não disparam", async () => {
    const { admin, chamadas } = fakeAdmin({ suspensas: [ORG_SUSPENSA], campanhas: [] });
    await rodarUmaRodadaDeCampanha(admin as never);
    expect(chamadas[0]).toMatchObject({ tabela: "organizations", neq: ["status", "active"] });
  });

  it("a rodada EXCLUI as campanhas de organização suspensa da escolha", async () => {
    const { admin, chamadas } = fakeAdmin({ suspensas: [ORG_SUSPENSA], campanhas: [] });
    const r = await rodarUmaRodadaDeCampanha(admin as never);

    expect(r).toEqual({
      enviadas: 0,
      pulados: 0,
      concluidas: 0,
      promovidas: 0,
      detalhe: "nada_a_fazer",
    });
    const escolha = chamadas.find((c) => c.tabela === "campaigns" && c.operacao === "select");
    expect(escolha?.not).toEqual(["organization_id", "in", `(${ORG_SUSPENSA})`]);
  });

  it("a PROMOÇÃO da agendada também exclui a suspensa — senão a suspensão só valeria para quem já estava rodando", async () => {
    const { admin, chamadas } = fakeAdmin({ suspensas: [ORG_SUSPENSA], campanhas: [] });
    await rodarUmaRodadaDeCampanha(admin as never);
    const promocao = chamadas.find((c) => c.tabela === "campaigns" && c.operacao === "update");
    expect(promocao?.not).toEqual(["organization_id", "in", `(${ORG_SUSPENSA})`]);
  });

  it("sem nenhuma organização suspensa, a consulta NÃO ganha filtro — `in ()` vazio derrubaria a query", async () => {
    const { admin, chamadas } = fakeAdmin({ suspensas: [], campanhas: [] });
    await rodarUmaRodadaDeCampanha(admin as never);
    for (const c of chamadas.filter((x) => x.tabela === "campaigns")) {
      expect(c.not).toBeUndefined();
    }
  });

  it("a organização suspensa é perguntada ANTES da campanha — não adianta filtrar depois de escolher", async () => {
    const { admin, chamadas } = fakeAdmin({ suspensas: [ORG_SUSPENSA], campanhas: [] });
    await rodarUmaRodadaDeCampanha(admin as never);
    expect(chamadas[0]?.tabela).toBe("organizations");
    expect(chamadas.slice(1).every((c) => c.tabela === "campaigns")).toBe(true);
  });
});

describe("a busca das campanhas em andamento falhou", () => {
  it("⭐ registra o erro e não responde 'nada a fazer' — a falha não se disfarça de rodada vazia", async () => {
    avisos.length = 0;
    const { admin } = fakeAdmin({ suspensas: [], campanhas: [], erroNaBusca: "timeout do PostgREST" });
    const r = await rodarUmaRodadaDeCampanha(admin as never);

    expect(r.detalhe).toBe("busca_falhou");
    expect(r.enviadas).toBe(0);
    expect(avisos).toContainEqual(["[campanha] busca das campanhas em andamento falhou", { motivo: "timeout do PostgREST" }]);
  });
});

describe("exceção do envio × organização parada", () => {
  /** Supabase falso que só registra o que o `update` gravaria. */
  function adminQueGrava() {
    const gravados: Array<Record<string, unknown>> = [];
    const b: Record<string, unknown> = {
      update: (payload: Record<string, unknown>) => {
        gravados.push(payload);
        return b;
      },
      eq: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { admin: { from: () => b } as never, gravados };
  }

  it("org parada no meio do envio devolve o destinatário à fila, sem send_exception", async () => {
    const { admin, gravados } = adminQueGrava();
    await expect(registrarExcecaoDoEnvio(admin, "dest-1", new OrgNaoOperanteError("org"))).resolves.toBe("org_nao_operante");
    expect(gravados).toEqual([{ status: "pending", sending_at: null }]);
  });

  it("controle: outro erro segue marcando failed/send_exception com o motivo", async () => {
    const { admin, gravados } = adminQueGrava();
    await expect(registrarExcecaoDoEnvio(admin, "dest-1", new Error("rede"))).resolves.toBe("falhou");
    expect(gravados).toEqual([{ status: "failed", last_error_code: "send_exception", last_error_detail: "rede" }]);
  });
});

vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));

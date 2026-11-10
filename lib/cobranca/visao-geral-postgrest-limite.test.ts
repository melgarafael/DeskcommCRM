import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

vi.mock("@/lib/cobranca/configuracao", () => ({ provedorDaInstalacao: async () => null }));
vi.mock("@/lib/cobranca/provedores", () => ({ modoDoProvedor: async () => "teste" }));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({ baseDeTesteDaCobranca: () => null }));
vi.mock("@/lib/instalacao/config", () => ({ estadoParaTela: async () => ({ last4: "4242" }) }));
vi.mock("@/lib/email/roteador", () => ({ emailConfigurado: async () => false }));

import { lerVisaoGeral } from "./visao-geral";

const TOTAL = 1001;
const linhas = Array.from({ length: TOTAL }, (_, i) => ({
  organization_id: `org-${i}`,
  relida_em: new Date(Date.UTC(2026, 9, 10, 8, 0, 0) + i * 60_000).toISOString(),
  precisa_reler: false,
}));
const MAIOR = linhas[TOTAL - 1]!.relida_em;

describe("visão geral: última leitura além de 1.000 linhas", () => {
  it("1.001 linhas: mostra a leitura mais recente real, não a da fatia truncada", async () => {
    const responder = (c: Cadeia): Resposta => {
      if (c.tabela === "cobranca_planos") return { data: null };
      if (c.tabela === "webhook_events_log") return { data: null };
      return { data: [] };
    };
    const responderRpc = (_nome: string, _args: Record<string, unknown>, cadeia: Cadeia): Resposta => {
      const orderDesc = cadeia.passos.some((p) => p.metodo === "order" && (p.args[1] as { ascending?: boolean })?.ascending === false);
      const limit = cadeia.passos.find((p) => p.metodo === "limit")?.args[0];
      if (orderDesc) return { data: [linhas[TOTAL - 1]] };
      // PostgREST trunca em 1.000 quando não há order/limit que reduza.
      return { data: linhas.slice(0, 1000) };
    };
    const banco = bancoFalso(responder, responderRpc);
    const v = await lerVisaoGeral(banco.cliente as never);
    expect(v.ultimaLeituraEm).toBe(MAIOR);
  });
});

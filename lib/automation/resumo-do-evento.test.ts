import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O NOME DO FUNIL no aviso da equipe — a falha é DITA, não engolida
 * (revisão do #5006).
 *
 * O nome é cortesia: na falha, o aviso sai sem a linha "Funil". Mas quem
 * investiga "por que o aviso veio sem funil?" precisa do log. Os dois ramos de
 * falha — o `error` do PostgREST e a exceção — avisam com o MESMO destino
 * (`logger.warn`), e o resto do aviso continua inteiro.
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.acme.com.br";
});
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "@/lib/logger";
import { carregarResumoParaAEquipe } from "./resumo-do-evento";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL = "66666666-6666-4666-8666-666666666666";

type Falha = "nenhuma" | "erro_do_postgrest" | "excecao";

/** PostgREST mínimo: `crm_pipelines` falha do jeito pedido; o resto responde vazio. */
function adminFake(falha: Falha) {
  function builder(tabela: string) {
    const consulta = {
      select: () => consulta,
      eq: () => consulta,
      maybeSingle: async () => {
        if (tabela === "crm_pipelines") {
          if (falha === "excecao") throw new Error("socket hang up");
          if (falha === "erro_do_postgrest") {
            return { data: null, error: { message: "permission denied for table crm_pipelines" } };
          }
          return { data: { name: "Funil de vendas" }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return consulta;
  }
  return {
    from: (tabela: string) => builder(tabela),
    rpc: async () => ({ data: [], error: null }),
  } as never;
}

function carregar(falha: Falha) {
  return carregarResumoParaAEquipe({
    admin: adminFake(falha),
    organizationId: ORG,
    regra: "Venda fechada",
    contexto: {
      lead: { id: LEAD, value_cents: 50_000, currency: "BRL", pipeline_id: FUNIL },
      contact: { name: "Ana Lima", phone_number: "+5571988068310" },
    },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("carregarResumoParaAEquipe — o nome do funil", () => {
  it("lido: a linha Funil aparece, sem aviso no log", async () => {
    const texto = await carregar("nenhuma");

    expect(texto?.split("\n")).toContain("Funil: Funil de vendas");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each<Falha>(["erro_do_postgrest", "excecao"])(
    "falha (%s): o aviso sai sem a linha Funil, e a falha vai para o log",
    async (falha) => {
      const texto = await carregar(falha);

      expect(texto).not.toBeNull();
      expect(texto).not.toContain("Funil:");
      expect(texto).toContain("Cliente: Ana");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [mensagem, contexto] = vi.mocked(logger.warn).mock.calls[0]!;
      expect(mensagem).toMatch(/nome do funil/);
      expect(contexto).toMatchObject({ organizationId: ORG, pipelineId: FUNIL });
    },
  );
});

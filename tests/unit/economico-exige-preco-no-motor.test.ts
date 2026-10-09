/**
 * O DEGRAU ECONÔMICO NÃO TROCA PARA UM MODELO QUE O MOTOR NÃO SABE COBRAR.
 *
 * Follow-up do #2118. O catálogo (`ai_models`) tem preço de `gpt-5-mini`; a
 * tabela do motor (`precoDoModelo`) não. Uma organização que habilita
 * `gpt-5-mini` e deixa de fora luna/nano fazia o classificador trocar o
 * `gpt-5.6-terra` (cobrado) pelo `gpt-5-mini` — e o custo da chamada saía
 * null, que o teto soma como zero: a chamada sumia do orçamento.
 *
 * A regra vale em DOIS lugares, e os dois são medidos com o mesmo cenário:
 * o seam (`decidirParaOSeam`, o que roda) e a tela (`GET /api/v1/ai/providers`,
 * o que é anunciado). Se só um aplicasse, a tela anunciaria um modelo e o
 * motor rodaria outro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import {
  EXPLICACAO_DA_ORIGEM,
  escolherModeloEconomico,
  type ModeloDoCatalogoEconomico,
} from "@/lib/ai/pontos/resolver";
import { traduzir } from "@/lib/i18n/dicionario";
import { decidirParaOSeam, esquecerCatalogoEconomico } from "@/lib/agent-engine/edge/llm/binding-do-ponto";
import { precoDoModelo, temPrecoNoMotor } from "@/lib/agent-engine/edge/llm/pricing";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const banco = vi.hoisted(() => ({
  lista: {} as Record<string, unknown[]>,
  unica: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: banco.unica[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: banco.lista[tabela] ?? [], error: null }).then(ok, erro),
      };
      for (const m of ["select", "eq", "is", "not", "order", "limit"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/ai/providers/route";

const ORG = "11111111-1111-4111-8111-111111111111";

const m = (model_id: string, input: number, output: number): ModeloDoCatalogoEconomico => ({
  provider: "openai",
  model_id,
  input_price_per_million_cents: input,
  output_price_per_million_cents: output,
  supports_tools: true,
  supports_embedding: false,
});

// Preços do catálogo curado do baseline (centavos por milhão).
const CATALOGO = [
  m("gpt-5.6-terra", 200, 1200),
  m("gpt-5-mini", 150, 600),
  m("gpt-5.6-luna", 20, 120),
  m("gpt-5.4-nano", 20, 125),
];

const SO_O_MINI = ["gpt-5.6-terra", "gpt-5-mini"];

// O cenário só existe enquanto o mini estiver fora da tabela do motor. Se um
// dia ele ganhar preço, este caso tem de mudar de modelo — e o diz aqui.
it("premissa: o motor cobra o terra e não cobra o gpt-5-mini", () => {
  expect(precoDoModelo("gpt-5.6-terra")).toBeDefined();
  expect(precoDoModelo("gpt-5-mini")).toBeUndefined();
});

describe("escolherModeloEconomico com temPrecoNoMotor", () => {
  it("não escolhe candidato sem preço no motor quando o atual tem — fica no de antes", () => {
    expect(escolherModeloEconomico(CATALOGO, "openai", "gpt-5.6-terra", SO_O_MINI, temPrecoNoMotor)).toBeNull();
  });

  it("escolhe o mais barato ENTRE os que o motor cobra, mesmo havendo um mais barato sem preço", () => {
    // Um id fictício, mais barato que o nano no catálogo e fora da tabela do motor.
    const comFantasma = [...CATALOGO, m("gpt-fantasma", 10, 40)];
    expect(
      escolherModeloEconomico(
        comFantasma,
        "openai",
        "gpt-5.6-terra",
        [...SO_O_MINI, "gpt-5.4-nano", "gpt-fantasma"],
        temPrecoNoMotor,
      ),
    ).toBe("gpt-5.4-nano");
  });

  it("atual sem preço no motor: a restrição não se aplica (o custo já era null)", () => {
    const comAtualSemPreco = [...CATALOGO, m("gpt-5-sem-tabela", 300, 1500)];
    expect(
      escolherModeloEconomico(comAtualSemPreco, "openai", "gpt-5-sem-tabela", ["gpt-5-sem-tabela", "gpt-5-mini"], temPrecoNoMotor),
    ).toBe("gpt-5-mini");
  });
});

async function modeloDoSeam(habilitados: readonly string[]): Promise<string | null> {
  const query = vi.fn(async (sql: string) => (sql.includes("from ai_models") ? { rows: CATALOGO } : { rows: [] }));
  const d = await decidirParaOSeam({ query } as never, {
    organizationId: ORG,
    purpose: "stage_classifier",
    modeloDoCallSite: undefined,
    overrideDoAgente: null,
    padraoDaOrganizacao: { provider: "openai", defaultModel: "gpt-5.6-terra" },
    modelosHabilitados: habilitados,
  });
  return d.modelId;
}

async function modeloDaTela(habilitados: readonly string[]): Promise<string | null> {
  banco.lista.ai_models = CATALOGO.map((c) => ({
    ...c,
    display_name: c.model_id,
    supports_vision: false,
    context_window: null,
  }));
  banco.unica.organizations = {
    settings: { llm: { provider: "openai", default_model: "gpt-5.6-terra", enabled_models: habilitados } },
  };
  const res = await GET();
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { pontos: { id: string; efetivo: { modelId: string | null } }[] } };
  const ponto = data.pontos.find((p) => p.id === "stage_classifier");
  expect(ponto, "stage_classifier sumiu do painel").toBeDefined();
  return ponto!.efetivo.modelId;
}

describe("a tela e o seam concordam", () => {
  beforeEach(() => {
    esquecerCatalogoEconomico();
    banco.lista = {};
    banco.unica = {};
    // O knob do ponto vence o econômico; um `.env.local` com ele mediria a máquina.
    vi.stubEnv("STAGE_CLASSIFIER_MODEL", "");
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "actor", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);
  });

  it("só o gpt-5-mini habilitado além do terra: os dois ficam no terra", async () => {
    expect(await modeloDoSeam(SO_O_MINI)).toBe("gpt-5.6-terra");
    expect(await modeloDaTela(SO_O_MINI)).toBe("gpt-5.6-terra");
  });

  it("controle: com o nano habilitado, os dois descem para o nano", async () => {
    const comNano = [...SO_O_MINI, "gpt-5.4-nano"];
    expect(await modeloDoSeam(comNano)).toBe("gpt-5.4-nano");
    expect(await modeloDaTela(comNano)).toBe("gpt-5.4-nano");
  });
});

describe("a linha de erro do econômico só afirma o que já é verdade ao ser gravada", () => {
  // Ela é carimbada ANTES de a reserva rodar: se a reserva também cair, "nada
  // se perdeu" seria falso numa linha que ninguém reescreve.
  const texto = EXPLICACAO_DA_ORIGEM.economico_coberto_pela_reserva;

  it("não promete o desfecho da reserva", () => {
    expect(texto).not.toMatch(/nada se perdeu/i);
    expect(texto).toMatch(/repetida no modelo de antes/);
  });

  it("tem tradução em espanhol, e ela também não promete o desfecho", () => {
    const es = traduzir(texto, "es");
    expect(es).not.toBe(texto);
    expect(es).not.toMatch(/no se perdió nada/i);
  });
});

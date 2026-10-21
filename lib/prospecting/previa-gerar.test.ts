/**
 * `gerarPreviaDoCandidato` (B2): a morada única de "como se escreve a prévia".
 * A rota (clique) e o preparo automático (tick) chamam esta função; o par
 * rota × preparo é provado em `app/api/v1/prospecting/previa-em-par.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: mocks.generate,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: () => ({}) }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { gerarPreviaDoCandidato } from "./previa-gerar";
import type { Prospect } from "./schema";

const AGENTE = "55555555-5555-4555-8555-555555555555";
const CONFIG = {
  agent_id: AGENTE,
  channel_session_id: "66666666-6666-4666-8666-666666666666",
  pipeline_id: "77777777-7777-4777-8777-777777777777",
  stage_id: "88888888-8888-4888-8888-888888888888",
  qualified_stage_id: "99999999-9999-4999-8999-999999999998",
  instruction: "Apresente a clínica com educação.",
  qualification: "Tem interesse em agendar avaliação.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "legítimo interesse, registro 1",
};
const SITE_OK = {
  ver: 1,
  classe: "site-ok",
  problemas: [],
  checklist: { tem: ["tel"], falta: [] },
  final_url: "https://vitta.test/",
  http_status: 200,
  tempo_ms: 300,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};
const DADOS = {
  key: "k",
  name: "Clínica Vitta",
  category: "Estética",
  address: "Rua X",
  website: "https://vitta.test/",
  phone: null,
  maps_url: null,
  rating: 4.8,
  reviews: 120,
  emails: [],
  socials: [],
  site: SITE_OK,
} as unknown as Prospect;

function linha(over: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    data: DADOS,
    status: "queued",
    contact_id: null as string | null,
    config: CONFIG as unknown,
    search: { niche: "clínica" } as { niche?: string } | null,
    ...over,
  };
}
const ORG = "99999999-9999-4999-8999-999999999999";
// Pool que só responde a leitura de `settings` (voz/vocabulário da organização).
const pool = { query: vi.fn(async () => ({ rows: [] })) } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue({ ok: true, texto: "Olá! Vi o site de vocês." });
});

describe("gerarPreviaDoCandidato", () => {
  it("gera do zero: nunca manda 'Rascunho de abordagem', mesmo com prévia válida guardada", async () => {
    const comPrevia = {
      ...DADOS,
      previa: {
        texto: "RASCUNHO-ANTIGO",
        baseada_em: `${SITE_OK.classe}@${SITE_OK.verificado_em}`,
        gerada_em: "2026-10-10T00:00:00.000Z",
        agente_id: AGENTE,
      },
    } as unknown as Prospect;
    const r = await gerarPreviaDoCandidato(pool, ORG, linha({ data: comPrevia }));
    expect(r.ok).toBe(true);
    const dados = (mocks.generate.mock.calls[0]![2] as { dados: Record<string, string> }).dados;
    expect(dados["Rascunho de abordagem"]).toBeUndefined();
    expect(JSON.stringify(dados)).not.toContain("RASCUNHO-ANTIGO");
  });

  it("devolve a prévia ancorada na chave da auditoria, com o agente e a estratégia", async () => {
    const r = await gerarPreviaDoCandidato(pool, ORG, linha());
    if (!r.ok) throw new Error("esperava ok");
    expect(r.texto).toBe("Olá! Vi o site de vocês.");
    expect(r.previa.texto).toBe(r.texto);
    expect(r.previa.baseada_em).toBe(`site-ok@${SITE_OK.verificado_em}`);
    expect(r.previa.agente_id).toBe(AGENTE);
    expect(r.estrategia.cenario).toBeTruthy();
    expect(r.score.valor).toBeGreaterThan(0);
    const chamada = mocks.generate.mock.calls[0]![2] as { tenantId: string; agentId: string };
    expect(chamada.tenantId).toBe(ORG);
    expect(chamada.agentId).toBe(AGENTE);
  });

  it("sem contato o leadId é null; com contato é o contact_id", async () => {
    await gerarPreviaDoCandidato(pool, ORG, linha({ contact_id: null }));
    await gerarPreviaDoCandidato(pool, ORG, linha({ contact_id: "44444444-4444-4444-8444-444444444444" }));
    expect((mocks.generate.mock.calls[0]![2] as { leadId: unknown }).leadId).toBeNull();
    expect((mocks.generate.mock.calls[1]![2] as { leadId: unknown }).leadId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("a personalização que o chamador já leu evita uma consulta por candidato", async () => {
    const consulta = vi.fn(async () => ({ rows: [] }));
    await gerarPreviaDoCandidato({ query: consulta } as never, ORG, linha(), {
      personalizacao: { vendedor_nome: "Paulo" },
    });
    expect(consulta).not.toHaveBeenCalled();
    const instrucao = (mocks.generate.mock.calls[0]![2] as { instrucao: string }).instrucao;
    expect(instrucao).toContain("Paulo");
  });

  it("site na web sem veredito: auditoria_pendente, sem chamar o modelo", async () => {
    const r = await gerarPreviaDoCandidato(
      pool,
      ORG,
      linha({ data: { ...DADOS, site: null } as unknown as Prospect }),
    );
    expect(r).toEqual({ ok: false, motivo: "auditoria_pendente" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("sem website e sem veredito: deriva sem-site e gera", async () => {
    const r = await gerarPreviaDoCandidato(
      pool,
      ORG,
      linha({ data: { ...DADOS, website: null, site: null } as unknown as Prospect }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.previa.baseada_em).toBe("sem-site@derivado");
  });

  it("config sem agente (ou parcial): sem_agente, sem chamar o modelo", async () => {
    for (const config of [null, { instruction: "Oferecer uma avaliação comercial." }]) {
      const r = await gerarPreviaDoCandidato(pool, ORG, linha({ config }));
      expect(r).toEqual({ ok: false, motivo: "sem_agente" });
    }
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("saída na 2ª mensagem: sem Auditoria nem Detalhe nos dados, e sem a estratégia na instrução", async () => {
    // Igual ao envio (worker.ts): nesse modo a 1ª mensagem só cumprimenta.
    const fora = {
      ...DADOS,
      site: { ...SITE_OK, classe: "fora-do-ar", problemas: ["http-503"], conteudo_resumo: "Página de erro" },
    } as unknown as Prospect;
    const chamada = async (exit_offer: "first_message" | "second_message") => {
      mocks.generate.mockClear();
      const r = await gerarPreviaDoCandidato(pool, ORG, linha({ data: fora, config: { ...CONFIG, exit_offer } }));
      expect(r.ok).toBe(true);
      return mocks.generate.mock.calls[0]![2] as { dados: Record<string, string>; instrucao: string };
    };
    const primeira = await chamada("first_message");
    expect(primeira.dados["Auditoria"]).toBeTruthy();
    expect(primeira.dados["Detalhe"]).toBe("Página de erro");
    expect(primeira.instrucao).toContain("Estratégia de abordagem");
    const segunda = await chamada("second_message");
    expect(segunda.dados).not.toHaveProperty("Auditoria");
    expect(segunda.dados).not.toHaveProperty("Detalhe");
    expect(segunda.instrucao).not.toContain("Estratégia de abordagem");
  });

  it("o modelo não produziu texto: ia_falhou com o motivo, sem texto", async () => {
    mocks.generate.mockResolvedValue({ ok: false, reason: "sem_agente_publicado" });
    const r = await gerarPreviaDoCandidato(pool, ORG, linha());
    expect(r).toEqual({ ok: false, motivo: "ia_falhou", detalhe: "sem_agente_publicado" });
  });
});

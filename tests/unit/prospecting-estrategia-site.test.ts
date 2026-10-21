import { describe, expect, it } from "vitest";
import {
  blocoDeEstrategiaParaAgente,
  estrategiaDoCandidato,
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
  montarEstrategia,
  normalizarNicho,
  pontuarCandidato,
  rotuloDaClasse,
  rotuloDoItem,
  vocabularioDoNicho,
  type EntradaDaEstrategia,
} from "@/lib/prospecting/estrategia-site";
import {
  campaignConfigSchema,
  ofertasDaCampanhaSchema,
  prospectingInputSchema,
} from "@/lib/prospecting/schema";

const base: EntradaDaEstrategia = {
  classe: "sem-site",
  problemas: [],
  checklist: { tem: [], falta: ["whatsapp", "tel"] },
  nota: 4.9,
  numAvaliacoes: 120,
  temInstagram: true,
  ofertas: ["site"],
  nicho: "clínica de estética",
  provisorio: false,
  status: "new",
  followUpsEnviados: 0,
};

describe("estrategia-site", () => {
  it("sem-site com Instagram vende complemento, não substituto", () => {
    const e = montarEstrategia(base);
    expect(e.cenario).toBe("Sem site");
    expect(e.angulo).toContain("complemento");
    expect(e.ganchos.join(" ")).toContain("whatsapp");
    expect(e.objecoes.length).toBeGreaterThan(0);
  });

  it("próximo passo segue o vocabulário de prospecting_candidates.status", () => {
    for (const status of ["new", "queued", "sending"]) {
      expect(montarEstrategia({ ...base, status }).proximoPasso).toMatch(/^Gere a prévia da abordagem/);
    }
    expect(montarEstrategia({ ...base, status: "sent" }).proximoPasso).toMatch(/^Lead contatado sem resposta/);
    // Status desconhecido (o Inbox não sabe o do candidato): não afirma contato nenhum.
    expect(montarEstrategia({ ...base, status: "" }).proximoPasso).toBe("");
    // Descartado pela triagem ou com falha: nada de sugerir envio.
    for (const status of ["skipped", "failed"]) {
      expect(montarEstrategia({ ...base, status }).proximoPasso).toBe("");
    }
  });

  it("fora-do-ar abre como aviso de cortesia", () => {
    const e = montarEstrategia({ ...base, classe: "fora-do-ar" });
    expect(e.cenario).toBe("Site fora do ar");
    expect(e.angulo).toContain("cortesia");
  });

  it("site-ok sem automação é prioridade baixa sem objeções", () => {
    const e = montarEstrategia({ ...base, classe: "site-ok" });
    expect(e.cenario).toBe("Site ok");
    expect(e.objecoes).toEqual([]);
  });

  it("site-ok com volume alto e automação vira dor de atendimento", () => {
    const e = montarEstrategia({ ...base, classe: "site-ok", ofertas: ["automacao_crm"] });
    expect(e.cenario).toBe("Site ok, demanda alta");
    expect(e.angulo).toContain("atendimento");
  });

  it("default sem ofertas comporta-se como site", () => {
    const e = montarEstrategia({ ...base, ofertas: [] });
    expect(e.cenario).toBe("Sem site");
  });

  it("follow-up conta elemento novo e não repete argumento", () => {
    const e = montarEstrategia({ ...base, status: "contatado", followUpsEnviados: 2 });
    expect(e.proximoPasso).toContain("2 follow-up");
    expect(e.proximoPasso).toContain("NOVO");
  });

  it("vocabulário por nicho com fallback", () => {
    expect(vocabularioDoNicho("Clínica de Estética")).toBe("agenda de pacientes");
    expect(vocabularioDoNicho("RESTAURANTE")).toBe("reservas e pedidos");
    expect(vocabularioDoNicho("nicho estranho")).toContain("nicho estranho");
    expect(normalizarNicho("Clínica")).toBe("clinica");
  });

  it("score espelha a fórmula com motivo", () => {    // nota 5.0 → 40 + 100 aval → 30 + sem-site 30 = 100
    expect(pontuarCandidato(5.0, 120, "sem-site")).toEqual({
      valor: 100,
      motivo: "nota alta + volume de avaliações",
    });
    expect(pontuarCandidato(4.0, 0, "site-ok").valor).toBe(10);
    // automação pesa avaliações e alivia o site
    const auto = pontuarCandidato(4.2, 150, "site-ok", "automacao_crm");
    expect(auto.valor).toBe(8 + 60 + 14);
    expect(pontuarCandidato(null, null, "agregador").motivo).toContain("sem site próprio");
  });

  it("provisório não gera ângulo, não é citado e pesa neutro", () => {
    const e = montarEstrategia({ ...base, classe: "fora-do-ar", provisorio: true });
    expect(e.cenario).toBe("Verificação pendente");
    expect(e.ganchos).toEqual([]);
    const dados = montarDadosDeAbordagem(
      { name: "Vitta", category: "Estética", address: "Rua X", website: "https://x.com", rating: 5, socials: [] },
      { classe: "fora-do-ar", problemas: ["fora-do-ar"], conteudo_resumo: "x", provisorio: true, verificado_em: "2026-10-10T12:00:00.000Z" },
    );
    expect(dados["Auditoria"]).toBeUndefined();
    const score = pontuarCandidato(5.0, 120, "fora-do-ar", "site", true);
    expect(score.valor).toBe(40 + 30 + 18);
    expect(score.motivo).toContain("verificação pendente");
  });

  it("rótulos cobrem todas as classes e itens (Record fechado)", () => {
    for (const classe of ["agregador", "sem-site", "site-ok", "site-ruim", "ssl-invalido", "fora-do-ar"] as const) {
      expect(rotuloDaClasse(classe, (s) => s).length).toBeGreaterThan(0);
    }
    for (const item of ["whatsapp", "tel", "mailto", "social", "mapa", "fotos", "titulo", "description", "favicon"] as const) {
      expect(rotuloDoItem(item, (s) => s).length).toBeGreaterThan(0);
    }
  });

  it("dados da abordagem mantêm os 6 campos do envio + auditoria", () => {
    const dados = montarDadosDeAbordagem(
      { name: "Vitta", category: "Estética", address: "Rua X", website: "https://x.com", rating: 5, socials: ["https://instagram.com/x"] },
      { classe: "fora-do-ar", problemas: ["fora-do-ar"], conteudo_resumo: "Título: Vitta", provisorio: false, verificado_em: "2026-10-10T12:00:00.000Z" },
    );
    expect(dados["Empresa"]).toBe("Vitta");
    expect(dados["Site"]).toBe("https://x.com");
    expect(dados["Auditoria"]).toContain("Site fora do ar");
    expect(dados["Auditoria"]).toContain("verificado em 10/10/2026");
    expect(dados["Detalhe"]).toBe("Título: Vitta");
    const semSite = montarDadosDeAbordagem(
      { name: "V", category: null, address: null, website: null, rating: null, socials: [] },
      null,
    );
    expect(semSite["Auditoria"]).toBeUndefined();
    expect(instrucaoDeAbordagemFria("Oi", "Q").length).toBeGreaterThan("Oi".length);
  });

  it("ofertas defaultam para site e actions novas validam", () => {
    expect(ofertasDaCampanhaSchema.parse(undefined)).toEqual(["site"]);
    expect(
      prospectingInputSchema.safeParse({ action: "reanalisar_site", id: "00000000-0000-4000-8000-000000000001", candidate_ids: [] }).success,
    ).toBe(false);
    expect(
      prospectingInputSchema.safeParse({
        action: "reanalisar_site",
        id: "00000000-0000-4000-8000-000000000001",
        candidate_ids: ["00000000-0000-4000-8000-000000000002"],
      }).success,
    ).toBe(true);
    expect(
      prospectingInputSchema.safeParse({
        action: "prever_abordagem",
        id: "00000000-0000-4000-8000-000000000001",
        candidate_id: "00000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(true);
    const cfg = campaignConfigSchema.parse({
      agent_id: "00000000-0000-4000-8000-000000000003",
      channel_session_id: "00000000-0000-4000-8000-000000000004",
      pipeline_id: "00000000-0000-4000-8000-000000000005",
      stage_id: "00000000-0000-4000-8000-000000000006",
      qualified_stage_id: "00000000-0000-4000-8000-000000000007",
      instruction: "0123456789",
      qualification: "0123456789",
      daily_limit: 10,
      interval_minutes: 15,
      legal_basis_ref: "LIA",
    });
    expect(cfg.ofertas).toEqual(["site"]);
  });

  it("voz vazia não muda a instrução; com voz, soma o bloco", () => {
    const semVoz = instrucaoDeAbordagemFria("Oi", "Q");
    expect(instrucaoDeAbordagemFria("Oi", "Q", "")).toBe(semVoz);
    const comVoz = instrucaoDeAbordagemFria("Oi", "Q", "Quem envia:\n- Nome: Ana");
    expect(comVoz.startsWith(semVoz)).toBe(true);
    expect(comVoz).toContain("Ana");
  });

  it("sobrescrita de vocabulário vence sem quebrar o default", () => {
    const e = montarEstrategia({ ...base, sobrescritaVocabulario: { clinica: "convênios" } });
    expect(e.angulo).toContain("convênios");
    const sem = montarEstrategia(base);
    expect(sem.angulo).toContain("concorrente");
  });
});

/**
 * A ESTRATÉGIA VAI PARA O AGENTE — E O AGENTE NÃO RECEBE CONTEÚDO DE TERCEIRO.
 *
 * A instrução inteira sobe para o `system` (é a instrução do operador, ver
 * `blocoDeModo`). O que o site de outra pessoa publicou — nome, endereço,
 * resumo de HTML — é CONTEÚDO e vive no `user`, dentro da cerca de nonce. Um
 * bloco de estratégia que interpolasse esse conteúdo abriria a porta de injeção
 * pela lateral: o texto do site viraria instrução de sistema.
 */
describe("a estratégia vai para o agente sem carregar conteúdo de terceiro", () => {
  const EMPRESA = "Clínica Vitta";
  const ENDERECO = "Rua das Flores, 123 — Centro";
  const CONTEUDO = "Promoção imperdível de verão";
  const data = {
    name: EMPRESA,
    category: "Estética",
    address: ENDERECO,
    website: "https://vitta.test",
    rating: 4.8,
    reviews: 120,
    socials: [] as string[],
  };
  const site = {
    classe: "fora-do-ar" as const,
    problemas: ["fora-do-ar"],
    checklist: { tem: [], falta: [] },
    conteudo_resumo: CONTEUDO,
    provisorio: false,
    verificado_em: "2026-10-10T12:00:00.000Z",
  };

  it("D) nem o bloco de estratégia nem a instrução carregam conteúdo publicado por terceiro", () => {
    const estrategia = estrategiaDoCandidato(data, site, {
      ofertas: ["site"],
      nicho: "clínica",
      status: "new",
    });
    const bloco = blocoDeEstrategiaParaAgente(estrategia);
    const instrucao = instrucaoDeAbordagemFria(
      "Instrução do operador",
      "Qualificação",
      undefined,
      estrategia,
    );
    for (const sentinela of [EMPRESA, ENDERECO, CONTEUDO]) {
      expect(bloco, `"${sentinela}" é conteúdo de terceiro e não pertence ao system`).not.toContain(
        sentinela,
      );
      expect(instrucao).not.toContain(sentinela);
    }
    // E o que o agente PRECISA receber está lá: o cenário e o ângulo.
    expect(bloco).toContain(estrategia.cenario);
    expect(instrucao).toContain(estrategia.angulo);
  });

  it("o bloco não leva objeções e respeita o teto de 900 caracteres", () => {
    const estrategia = estrategiaDoCandidato(data, site, {
      ofertas: ["site"],
      nicho: "clínica",
      status: "new",
    });
    const curta = blocoDeEstrategiaParaAgente({
      ...estrategia,
      ganchos: [],
      objecoes: [{ objecao: "OBJECAO-SENTINELA", resposta: "RESPOSTA-SENTINELA" }],
    });
    expect(curta).not.toContain("OBJECAO-SENTINELA");
    expect(curta).not.toContain("RESPOSTA-SENTINELA");
    const longa = blocoDeEstrategiaParaAgente({
      ...estrategia,
      ganchos: Array.from({ length: 40 }, (_, i) => `gancho longo número ${i} com bastante texto`),
    });
    expect(longa.length).toBeLessThanOrEqual(900);
  });

  it("sem estratégia, a instrução é byte a byte a de antes (o par tela×envio não sente)", () => {
    const base = instrucaoDeAbordagemFria("Oi", "Q", "Quem envia:\n- Nome: Ana");
    expect(instrucaoDeAbordagemFria("Oi", "Q", "Quem envia:\n- Nome: Ana", null)).toBe(base);
    expect(instrucaoDeAbordagemFria("Oi", "Q", "Quem envia:\n- Nome: Ana", undefined)).toBe(base);
  });

  it("com estratégia, o bloco SOMA à instrução e preserva a voz do vendedor", () => {
    const estrategia = estrategiaDoCandidato(data, site, {
      ofertas: ["site"],
      nicho: "clínica",
      status: "new",
    });
    const comEstrategia = instrucaoDeAbordagemFria(
      "Instrução do operador",
      "Qualificação",
      "Voz do vendedor",
      estrategia,
    );
    expect(comEstrategia).toContain("Voz do vendedor");
    expect(comEstrategia).toContain(estrategia.cenario);
    expect(comEstrategia.startsWith(instrucaoDeAbordagemFria("Instrução do operador", "Qualificação", "Voz do vendedor"))).toBe(
      true,
    );
  });
});

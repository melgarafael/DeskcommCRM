import { describe, expect, it } from "vitest";
import {
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
  status: "novo",
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
      { classe: "fora-do-ar", problemas: ["fora-do-ar"], conteudo_resumo: "Título: Vitta" },
    );
    expect(dados["Empresa"]).toBe("Vitta");
    expect(dados["Site"]).toBe("https://x.com");
    expect(dados["Auditoria"]).toContain("Site fora do ar");
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

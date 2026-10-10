import { describe, expect, it } from "vitest";
import {
  montarEstrategia,
  normalizarNicho,
  pontuarCandidato,
  vocabularioDoNicho,
  type EntradaDaEstrategia,
} from "@/lib/prospecting/estrategia-site";

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

  it("score espelha a fórmula com motivo", () => {
    // nota 5.0 → 40 + 100 aval → 30 + sem-site 30 = 100
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
});

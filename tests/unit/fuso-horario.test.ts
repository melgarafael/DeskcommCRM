import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O FUSO QUE NÃO EXISTE DERRUBA QUEM O LÊ.
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * O fuso da agenda do atendente era texto livre validado só por
 * `z.string().min(1).max(64)`. Qualquer coisa passava. E `localMoment`
 * (lib/routing/eligibility) usa `Intl.DateTimeFormat`, que LANÇA `RangeError`
 * num fuso inexistente:
 *
 *   America/Asuncion   → funciona
 *   America/Asunción   → RangeError   ← o acento que um hispanofalante escreve
 *   Asuncion           → RangeError
 *
 * Salvava sem reclamar e derrubava a avaliação de disponibilidade de todo
 * atendente com aquela agenda. O defeito não aparecia na tela que o causou:
 * aparecia no roteamento, como atendente que nunca fica elegível.
 *
 * ─── Duas defesas, e as duas fazem falta ───────────────────────────────────
 *
 * A LISTA impede o erro de digitação, que é a origem. A CHECAGEM defende a API,
 * que aceita qualquer cliente e não passa pela tela.
 */
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";
import { FUSOS_OFERECIDOS, FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

describe("a checagem do fuso", () => {
  it("aceita o que o runtime sabe usar", () => {
    expect(fusoValido("America/Asuncion")).toBe(true);
    expect(fusoValido("America/Sao_Paulo")).toBe(true);
    expect(fusoValido("UTC")).toBe(true);
  });

  it("recusa o acento — o erro que um hispanofalante comete natural", () => {
    expect(fusoValido("America/Asunción")).toBe(false);
  });

  it("recusa nome sem região e lixo", () => {
    expect(fusoValido("Asuncion")).toBe(false);
    expect(fusoValido("xyz")).toBe(false);
    expect(fusoValido("")).toBe(false);
  });

  it("pergunta ao RUNTIME, não a uma lista nossa", () => {
    // A base de fusos muda (países criam e apagam zonas), e quem sabe qual
    // versão está instalada é o próprio runtime. Uma lista nossa responderia
    // "sim" para um código que o `Intl` recusa — e o erro voltaria a aparecer
    // longe daqui.
    const fonte = readFileSync("lib/tempo/fusos.ts", "utf8");
    expect(fonte).toMatch(/new Intl\.DateTimeFormat/);
  });
});

describe("todo fuso oferecido é utilizável", () => {
  it("nenhuma linha da lista derruba quem a usar", () => {
    // Guarda a lista de si mesma: acrescentar um código errado aqui reintroduz
    // exatamente o defeito, e por um caminho que ninguém suspeitaria.
    for (const f of FUSOS_OFERECIDOS) {
      expect(fusoValido(f.codigo), f.codigo).toBe(true);
    }
  });

  it("Assunção está na lista — é o fuso deste país", () => {
    expect(FUSOS_OFERECIDOS.map((f) => f.codigo)).toContain("America/Asuncion");
  });
});

describe("a agenda do atendente rejeita fuso inválido", () => {
  it("recusa, em vez de salvar e quebrar o roteamento depois", () => {
    const r = availabilityScheduleSchema.safeParse({
      timezone: "America/Asunción",
      windows: [],
    });
    expect(r.success).toBe(false);
  });

  it("aceita o válido", () => {
    const r = availabilityScheduleSchema.safeParse({
      timezone: "America/Asuncion",
      windows: [],
    });
    expect(r.success).toBe(true);
  });

  it("sem fuso continua caindo no padrão — não vira erro", () => {
    // Agenda sem fuso é o estado de quem nunca abriu essa tela. Recusá-la
    // quebraria o salvamento de quem só queria mexer nas janelas.
    const r = availabilityScheduleSchema.safeParse({ windows: [] });
    expect(r.success).toBe(true);
  });
});

describe("as telas OFERECEM em vez de pedir para digitar", () => {
  it("o painel anti-banimento", () => {
    const fonte = readFileSync("components/connections/AntiBanSheet.tsx", "utf8");
    expect(fonte).toMatch(/FUSOS_OFERECIDOS\.map/);
    expect(fonte, "ainda é campo de texto").not.toMatch(/aria-label="Fuso horário IANA"\s*\n\s*\/>/);
  });

  it("e a agenda do atendente", () => {
    const fonte = readFileSync("app/app/team/_components/AttendantsClient.tsx", "utf8");
    expect(fonte).toMatch(/FUSOS_OFERECIDOS\.map/);
  });
});

describe("os fusos OFERECIDOS — a lista, não o padrão", () => {
  /**
   * ⚠️ MESMO MOTIVO DO CASO DE MOEDA: acrescentar Luanda à lista não
   * quebrava teste nenhum. Medido tirando a linha de volta:
   * `fuso-horario.test.ts` seguia 11/11 e o `tsc` saía zerado. Sem este
   * caso, a oferta some numa refatoração e ninguém percebe.
   */
  it("oferece Luanda, e a tela da empresa também", () => {
    expect(FUSOS_OFERECIDOS.map((f) => f.codigo)).toContain("Africa/Luanda");
    const formulario = readFileSync("app/app/settings/tenant/_form.tsx", "utf8");
    expect(formulario).toContain("Africa/Luanda");
  });

  // As quatro listas são três fontes: `FUSOS_OFERECIDOS` (jornada e janela de
  // envio) e as duas escritas à mão, da empresa e do perfil. Lisboa faltava
  // nas três — e o assistente de boas-vindas já a oferecia.
  it("oferece Lisboa nas três fontes", () => {
    expect(FUSOS_OFERECIDOS.map((f) => f.codigo)).toContain("Europe/Lisbon");
    for (const arquivo of ["app/app/settings/tenant/_form.tsx", "app/app/settings/profile/_form.tsx"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toContain('"Europe/Lisbon"');
    }
  });

  // O painel anti-banimento passa o rótulo por `t(f.rotulo)` — chave dinâmica,
  // que a varredura de `t("...")` literal não enxerga. Luanda entrou sem
  // tradução e ninguém viu; este caso reprova o próximo rótulo sem entrada.
  it("todo rótulo oferecido tem entrada no dicionário", () => {
    const semEntrada = FUSOS_OFERECIDOS.filter((f) => !DICIONARIO[f.rotulo]?.es).map((f) => f.rotulo);
    expect(semEntrada).toEqual([]);
  });

  it("e o padrão de quem não escolheu segue sendo São Paulo", () => {
    expect(FUSO_PADRAO).toBe("America/Sao_Paulo");
  });
});

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
import { availabilityScheduleSchema } from "@/lib/schemas/routing";
import { FUSOS_OFERECIDOS, fusoValido } from "@/lib/tempo/fusos";

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

  it("Maputo é a primeira opção — é o fuso do produto (Moçambique)", () => {
    expect(FUSOS_OFERECIDOS[0]?.codigo).toBe("Africa/Maputo");
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

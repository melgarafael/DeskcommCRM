/**
 * A DATA NA MENSAGEM NO FORMATO DE QUEM LÊ (#4339).
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * Nas automações (WhatsApp e e-mail) o campo de data saía como está GRAVADO no
 * banco: `2026-11-16`. O cliente brasileiro lê `16/11/2026` — e a mensagem que
 * a empresa escreveu para marcar uma visita chega ambígua ou ilegível.
 *
 * ─── A saída é ADITIVA, e é o que a issue autoriza ─────────────────────────
 *
 * `{{campo|data}}` formata no idioma da organização e `{{campo|data:dd/mm/aaaa}}`
 * formata no formato que quem escreveu pediu. NADA que já existe muda: a
 * reserva de valor padrão (`{{campo|"aluno"}}`) continua com aspas e continua
 * ganhando do valor vazio, e modificador que não é `data` deixa o token
 * exatamente como hoje (cru, fora do render).
 *
 * ─── O que os seis conjuntos da entrega provam ─────────────────────────────
 *
 *   (a) `|data` segue o idioma — pt-BR vira `16/11/2026`, en-US vira `11/16/2026`;
 *   (b) formato explícito `dd/mm/aaaa` e `aaaa-mm-dd`, com separador variável;
 *   (c) valor que NÃO é data ISO sai como está — nunca "Invalid Date";
 *   (d) `{{campo|"texto"}}` e `{{campo|xyz}}` inalterados (não regressão);
 *   (e) virada de dia no fuso da ORGANIZAÇÃO, com o caso de 23:30 BRT;
 *   (f) mensagem real de automação (WhatsApp e e-mail) com duas datas.
 */
import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/automation/template";
import { renderizarTextoDeFollowup } from "@/lib/automation/texto-do-followup";

/** O contexto de render de uma automação, com o idioma/fuso da organização. */
function contexto(
  campos: Record<string, unknown>,
  organizacao: { idioma?: string; fuso?: string } = {},
): Record<string, unknown> {
  return {
    contact: { name: "Ana", phone_number: "+5511988887777" },
    lead: { title: "Reforma da loja", custom_fields: campos },
    __render: organizacao,
  };
}

describe("(a) {{campo|data}} formata no idioma da organização", () => {
  it("pt-BR (o padrão do produto) devolve dd/mm/aaaa", () => {
    expect(
      renderTemplate("Obra em {{data_inicio|data}}", contexto({ data_inicio: "2026-11-16" })),
    ).toBe("Obra em 16/11/2026");
  });

  it("en-US devolve mm/dd/aaaa — a ordem é do idioma, não do produto", () => {
    expect(
      renderTemplate(
        "Works on {{data_inicio|data}}",
        contexto({ data_inicio: "2026-11-16" }, { idioma: "en-US" }),
      ),
    ).toBe("Works on 11/16/2026");
  });

  it("es (América Latina, dd/mm/aaaa) mantém dia antes do mês", () => {
    expect(
      renderTemplate("Obra el {{data_inicio|data}}", contexto({ data_inicio: "2026-11-16" }, { idioma: "es" })),
    ).toBe("Obra el 16/11/2026");
  });

  it("dia e mês com um dígito saem com zero à esquerda", () => {
    expect(
      renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: "2026-03-05" })),
    ).toBe("05/03/2026");
  });

  it("o caminho longo funciona igual ao atalho", () => {
    expect(
      renderTemplate(
        "{{lead.custom_fields.data_inicio|data}}",
        contexto({ data_inicio: "2026-11-16" }),
      ),
    ).toBe("16/11/2026");
  });
});

describe("(b) formato explícito {{campo|data:...}}", () => {
  it("dd/mm/aaaa", () => {
    expect(
      renderTemplate("{{data_inicio|data:dd/mm/aaaa}}", contexto({ data_inicio: "2026-11-16" })),
    ).toBe("16/11/2026");
  });

  it("aaaa-mm-dd (o formato de gravação, agora por escolha)", () => {
    expect(
      renderTemplate("{{data_inicio|data:aaaa-mm-dd}}", contexto({ data_inicio: "2026-11-16" })),
    ).toBe("2026-11-16");
  });

  it("separador variável: hífen e ponto no dd/mm/aaaa", () => {
    expect(
      renderTemplate("{{data_inicio|data:dd-mm-aaaa}}", contexto({ data_inicio: "2026-11-16" })),
    ).toBe("16-11-2026");
    expect(
      renderTemplate("{{data_inicio|data:dd.mm.aaaa}}", contexto({ data_inicio: "2026-11-16" })),
    ).toBe("16.11.2026");
  });

  it("mm/dd/aaaa explícito ignora o idioma da organização", () => {
    expect(
      renderTemplate(
        "{{data_inicio|data:mm/dd/aaaa}}",
        contexto({ data_inicio: "2026-11-16" }, { idioma: "pt-BR" }),
      ),
    ).toBe("11/16/2026");
  });
});

describe("(c) valor que não é data ISO sai COMO ESTÁ", () => {
  it("texto livre não vira Invalid Date", () => {
    expect(renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: "amanhã" }))).toBe(
      "amanhã",
    );
  });

  it("data já formatada à mão fica intacta", () => {
    expect(renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: "16/11/2026" }))).toBe(
      "16/11/2026",
    );
  });

  it("ISO com dia ou mês impossível não é formatado (nada de 31/02)", () => {
    expect(renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: "2026-02-31" }))).toBe(
      "2026-02-31",
    );
    expect(renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: "2026-13-01" }))).toBe(
      "2026-13-01",
    );
  });

  it("campo vazio continua vazio", () => {
    expect(renderTemplate("X{{data_inicio|data}}Y", contexto({ data_inicio: "" }))).toBe("XY");
    expect(renderTemplate("X{{data_fim|data}}Y", contexto({}))).toBe("XY");
  });
});

describe("(d) não regressão: reserva com aspas e modificador desconhecido", () => {
  it('{{campo|"texto"}} continua trocando vazio pelo texto', () => {
    expect(renderTemplate('{{data_inicio|"a definir"}}', contexto({ data_inicio: "" }))).toBe(
      "a definir",
    );
    expect(renderTemplate('{{data_inicio|"a definir"}}', contexto({}))).toBe("a definir");
  });

  it('{{campo|"texto"}} com valor preenchido continua mostrando o valor CRU', () => {
    // A reserva não é modificador: nada de formatar o que já existia.
    expect(
      renderTemplate('{{data_inicio|"a definir"}}', contexto({ data_inicio: "2026-11-16" })),
    ).toBe("2026-11-16");
  });

  it('espaços dentro da reserva continuam tolerados', () => {
    expect(renderTemplate('{{data_inicio | "a definir" }}', contexto({}))).toBe("a definir");
  });

  it("modificador desconhecido mantém o token cru, exatamente como hoje", () => {
    expect(renderTemplate("{{data_inicio|xyz}}", contexto({ data_inicio: "2026-11-16" }))).toBe(
      "{{data_inicio|xyz}}",
    );
    expect(renderTemplate("{{data_inicio|maiusculo}}", contexto({}))).toBe(
      "{{data_inicio|maiusculo}}",
    );
  });

  it("variável sem modificador continua saindo crua (o defeito é da fatia, não do render)", () => {
    expect(renderTemplate("{{data_inicio}}", contexto({ data_inicio: "2026-11-16" }))).toBe(
      "2026-11-16",
    );
  });

  it("o contexto do render não vaza as opções da organização", () => {
    expect(renderTemplate("{{nome}}", contexto({}, { idioma: "es" }))).toBe("Ana");
  });
});

describe("(e) ISO com hora resolve no fuso da organização", () => {
  it("23:30 em São Paulo é 02:30 UTC do dia seguinte — e sai como 16/11", () => {
    // O caso que a entrega exige: formatar em UTC daria 17/11/2026, um dia a mais.
    expect(
      renderTemplate(
        "{{data_inicio|data}}",
        contexto({ data_inicio: "2026-11-17T02:30:00Z" }, { fuso: "America/Sao_Paulo" }),
      ),
    ).toBe("16/11/2026");
  });

  it("o mesmo instante com deslocamento escrito à mão também cai no dia certo", () => {
    expect(
      renderTemplate(
        "{{data_inicio|data}}",
        contexto({ data_inicio: "2026-11-16T23:30:00-03:00" }, { fuso: "America/Sao_Paulo" }),
      ),
    ).toBe("16/11/2026");
  });

  it("mudar o fuso da organização muda o dia — prova de que o fuso é lido", () => {
    const valor = "2026-11-17T02:30:00Z";
    expect(renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: valor }, { fuso: "UTC" }))).toBe(
      "17/11/2026",
    );
    expect(
      renderTemplate(
        "{{data_inicio|data}}",
        contexto({ data_inicio: valor }, { fuso: "America/Sao_Paulo" }),
      ),
    ).toBe("16/11/2026");
  });

  it("hora sem fuso declarado é hora de parede: o dia não escorrega", () => {
    expect(
      renderTemplate("{{data_inicio|data}}", contexto({ data_inicio: "2026-11-16T12:00:00" })),
    ).toBe("16/11/2026");
  });

  it("a hora é descartada na saída — o cliente lê a data, não o timestamp", () => {
    expect(
      renderTemplate(
        "{{data_inicio|data}}",
        contexto({ data_inicio: "2026-11-16T12:00:00Z" }, { fuso: "America/Sao_Paulo" }),
      ),
    ).toBe("16/11/2026");
  });
});

describe("(f) mensagem real de automação com duas datas", () => {
  const campos = {
    data_inicio: "2026-11-16",
    data_fim: "2026-12-01",
  };

  it("WhatsApp: o corpo do passo sai com as duas datas no formato do cliente", () => {
    const corpo =
      "Oi {{primeiro_nome}}! Sua reserva é de {{data_inicio|data}} a {{data_fim|data}}. Qualquer coisa, é só responder aqui.";
    expect(renderTemplate(corpo, contexto(campos))).toBe(
      "Oi Ana! Sua reserva é de 16/11/2026 a 01/12/2026. Qualquer coisa, é só responder aqui.",
    );
  });

  it("e-mail: assunto e corpo saem com as duas datas, sem token cru sobrando", () => {
    const assunto = "Reserva confirmada para {{data_inicio|data}}";
    const corpo =
      "<p>Olá, {{nome}}.</p><p>Começamos em {{data_inicio|data}} e terminamos em {{data_fim|data}}.</p>";
    const assuntoPronto = renderTemplate(assunto, contexto(campos));
    const corpoPronto = renderTemplate(corpo, contexto(campos));
    expect(assuntoPronto).toBe("Reserva confirmada para 16/11/2026");
    expect(corpoPronto).toBe(
      "<p>Olá, Ana.</p><p>Começamos em 16/11/2026 e terminamos em 01/12/2026.</p>",
    );
    expect(corpoPronto).not.toContain("2026-11-16");
    expect(corpoPronto).not.toContain("{{");
  });

  it("o follow-up usa o MESMO interpolador (uma data, um formato)", () => {
    expect(
      renderizarTextoDeFollowup(
        "Oi {{primeiro_nome}}, sua reserva é {{data_inicio|data}}.",
        contexto(campos),
      ),
    ).toBe("Oi Ana, sua reserva é 16/11/2026.");
  });
});

/**
 * OS DADOS DO NEGÓCIO NO EVENTO DO GOOGLE (#4006, item 3).
 *
 * Hoje o evento chega "cru": título e descrição. Quem abre a agenda no celular
 * não sabe de qual negócio se trata, qual produto está em jogo nem o telefone
 * do cliente. Este arquivo mede o bloco que fecha essa lacuna — e as três
 * coisas que ele NÃO pode fazer: apagar o texto da pessoa, vazar contato
 * anonimizado e virar um preço que ninguém aprovou.
 */
import { describe, expect, it } from "vitest";

import { paraEventoDoGoogle, type AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
import {
  MARCA_DO_BLOCO,
  blocoDoNegocioNoEvento,
  descricaoComNegocio,
  escolherItensDaProposta,
  escaparHtml,
  type NegocioParaDescricao,
} from "@/lib/agenda/negocio-na-descricao";

const NEGOCIO: NegocioParaDescricao = {
  id: "11111111-1111-4111-8111-111111111111",
  titulo: "Plano Anual – Clínica Rosa",
  etapa: "Proposta enviada",
  produtos: [
    { descricao: "Implantação", quantidade: 1 },
    { descricao: "Plano Anual", quantidade: 12 },
  ],
  cliente: { nome: "Neide Rosa", telefone: "+5511987654321" },
  urlDoCrm: "https://crm.exemplo.test/app/leads/11111111-1111-4111-8111-111111111111",
};

const agendamento: AgendamentoParaGoogle = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "44444444-4444-4444-8444-444444444444",
  title: "Reunião Estratégica",
  description: "Levar proposta impressa.",
  starts_at: "2026-11-10T17:00:00Z",
  ends_at: "2026-11-10T18:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  location_kind: "in_person",
};

describe("o bloco do negócio", () => {
  it("traz negócio, etapa, produtos, cliente, telefone e o link", () => {
    const bloco = blocoDoNegocioNoEvento(NEGOCIO);

    expect(bloco).toContain(`${MARCA_DO_BLOCO} Plano Anual – Clínica Rosa`);
    expect(bloco).toContain("<b>Etapa:</b> Proposta enviada");
    expect(bloco).toContain("<li>Implantação (1×)</li>");
    expect(bloco).toContain("<li>Plano Anual (12×)</li>");
    expect(bloco).toContain("<b>Cliente:</b> Neide Rosa");
    expect(bloco).toContain("<b>Telefone:</b>");
    expect(bloco).toContain('<a href="https://crm.exemplo.test/app/leads/');
  });

  it("sem negócio não sai NADA — nem a linha do título", () => {
    expect(blocoDoNegocioNoEvento(null)).toBe("");
    expect(blocoDoNegocioNoEvento({ ...NEGOCIO, titulo: "   " })).toBe("");
  });

  it("sem etapa, sem produtos e sem proposta as seções não aparecem", () => {
    const bloco = blocoDoNegocioNoEvento({
      id: "x",
      titulo: "Negócio simples",
      etapa: null,
      produtos: [],
      cliente: null,
      urlDoCrm: null,
    });
    expect(bloco).toContain(`${MARCA_DO_BLOCO} Negócio simples`);
    expect(bloco).not.toContain("<b>Etapa:</b>");
    expect(bloco).not.toContain("Produtos / serviços");
    expect(bloco).not.toContain("<b>Cliente:</b>");
    expect(bloco).not.toContain("href=");
  });

  it("contato anonimizado (LGPD) não leva nome nem telefone", () => {
    const bloco = blocoDoNegocioNoEvento({ ...NEGOCIO, cliente: null });
    expect(bloco).not.toContain("Neide");
    expect(bloco).not.toContain("Telefone");
  });

  it("texto do banco é ESCAPADO: nome com sinal de menor não quebra o HTML", () => {
    const bloco = blocoDoNegocioNoEvento({
      ...NEGOCIO,
      titulo: "Plano <Anual> & Cia",
      produtos: [{ descricao: "Item <b>falso</b>", quantidade: 1 }],
    });
    expect(bloco).toContain("Plano &lt;Anual&gt; &amp; Cia");
    expect(bloco).not.toContain("<b>falso</b>");
    expect(escaparHtml('a "b" \'c\'')).toBe("a &quot;b&quot; &#39;c&#39;");
  });
});

describe("qual proposta manda os itens", () => {
  it("aceita vence, mesmo com uma enviada mais nova", () => {
    const itens = escolherItensDaProposta([
      { status: "enviada", criadaEm: "2026-11-05T10:00:00Z", itens: [{ descricao: "Nova", quantidade: 1 }] },
      { status: "aceita", criadaEm: "2026-10-01T10:00:00Z", itens: [{ descricao: "Aceita", quantidade: 2 }] },
    ]);
    expect(itens).toEqual([{ descricao: "Aceita", quantidade: 2 }]);
  });

  it("sem aceita, vale a enviada MAIS RECENTE", () => {
    const itens = escolherItensDaProposta([
      { status: "enviada", criadaEm: "2026-10-01T10:00:00Z", itens: [{ descricao: "Velha", quantidade: 1 }] },
      { status: "enviada", criadaEm: "2026-11-01T10:00:00Z", itens: [{ descricao: "Nova", quantidade: 1 }] },
    ]);
    expect(itens).toEqual([{ descricao: "Nova", quantidade: 1 }]);
  });

  it("rascunho, recusada e cancelada não entram", () => {
    expect(
      escolherItensDaProposta([
        { status: "rascunho", criadaEm: "2026-11-01T10:00:00Z", itens: [{ descricao: "R", quantidade: 1 }] },
        { status: "recusada", criadaEm: "2026-11-02T10:00:00Z", itens: [{ descricao: "X", quantidade: 1 }] },
        { status: "cancelada", criadaEm: "2026-11-03T10:00:00Z", itens: [{ descricao: "C", quantidade: 1 }] },
      ]),
    ).toEqual([]);
  });
});

describe("o texto da pessoa continua acima do bloco", () => {
  it("o bloco é acrescido, nunca substitui a observação", () => {
    const descricao = descricaoComNegocio("Levar proposta impressa.", blocoDoNegocioNoEvento(NEGOCIO));
    expect(descricao?.startsWith("Levar proposta impressa.")).toBe(true);
    expect(descricao).toContain(MARCA_DO_BLOCO);
  });

  it("reenviar não duplica o bloco: o anterior é trocado pelo novo", () => {
    const primeira = descricaoComNegocio("Observação", blocoDoNegocioNoEvento(NEGOCIO))!;
    const segunda = descricaoComNegocio(
      primeira,
      blocoDoNegocioNoEvento({ ...NEGOCIO, etapa: "Contrato assinado" }),
    )!;
    expect(segunda.split(MARCA_DO_BLOCO).length - 1).toBe(1);
    expect(segunda).toContain("Contrato assinado");
    expect(segunda).not.toContain("Proposta enviada");
  });

  it("sem texto e sem bloco o campo não vai no corpo", () => {
    expect(descricaoComNegocio(null, "")).toBeUndefined();
    expect(descricaoComNegocio("  ", "")).toBeUndefined();
  });

  it("paraEventoDoGoogle põe o bloco no FIM da descrição", () => {
    const corpo = paraEventoDoGoogle({
      ...agendamento,
      bloco_do_negocio: blocoDoNegocioNoEvento(NEGOCIO),
    });
    expect(corpo.description).toContain("Levar proposta impressa.");
    expect(corpo.description?.indexOf(MARCA_DO_BLOCO)).toBeGreaterThan(
      corpo.description!.indexOf("Levar proposta impressa."),
    );
  });

  it("sem bloco a descrição é exatamente a de hoje", () => {
    expect(paraEventoDoGoogle(agendamento).description).toBe("Levar proposta impressa.");
    expect(paraEventoDoGoogle({ ...agendamento, description: null }).description).toBeUndefined();
  });
});

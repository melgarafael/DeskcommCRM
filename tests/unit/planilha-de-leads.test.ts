/**
 * A PLANILHA DE LEADS É LIDA COM O QUE JÁ EXISTE, E RECUSA O AMBÍGUO.
 *
 * Os casos abaixo são o que a extração do PR #418 mudou de comportamento, não
 * uma tradução do que ele fazia:
 *
 *  - O original punha `"Lead importado"` quando a coluna de título faltava.
 *    Uma lista de 300 nomes virava 300 cards indistinguíveis no funil, que é
 *    justamente onde eles precisam ser distinguidos.
 *  - Ele lia o valor com `Number(String(v).replace(/\./g,"").replace(",","."))`,
 *    que devolve `NaN` em silêncio para "R$ 1.200,00" e grava o lead sem valor.
 *    Aqui a célula ilegível vira linha recusada COM o texto cru na mensagem.
 *  - Ele normalizava telefone com uma regra própria de +55; aqui é a MESMA de
 *    `lib/contacts/csv.ts`, por onde os contatos já entram.
 */
import { describe, expect, it } from "vitest";

import { lerPlanilhaDeLeads } from "@/lib/leads/planilha";

function ok(conteudo: string) {
  const r = lerPlanilhaDeLeads(conteudo);
  if ("erro" in r) throw new Error(`esperava leitura, veio erro: ${r.erro}`);
  return r;
}

describe("leitura da planilha de leads", () => {
  it("planilha vazia é recusada com motivo, não devolve lista vazia", () => {
    // Lista vazia lê-se como "importei zero leads com sucesso".
    expect(lerPlanilhaDeLeads("")).toEqual({ erro: expect.stringContaining("vazia") });
  });

  it("sem coluna que NOMEIE o negócio, recusa ANTES de processar as linhas", () => {
    const r = lerPlanilhaDeLeads("valor,origem\n100,site\n200,indicacao");
    expect(r).toHaveProperty("erro");
    // A mensagem lista o que encontrou: quem vai corrigir precisa saber o que
    // o importador viu, não só que ele não gostou.
    expect((r as { erro: string }).erro).toContain("valor");
  });

  it("aceita o ; do Excel em português e o cabeçalho com acento", () => {
    const r = ok("Nome;Telefone;Observação\nAna Souza;11988887777;retorno em junho");
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0]!.title).toBe("Ana Souza");
    expect(r.leads[0]!.description).toBe("retorno em junho");
  });

  it("valor em moeda brasileira vira centavos; o ilegível vira linha recusada", () => {
    const r = ok('nome,valor\nAna,"R$ 1.200,00"\nBruno,doze mil\nCarla,1200');
    expect(r.leads.map((l) => [l.title, l.value_cents])).toEqual([
      ["Ana", 120000],
      ["Carla", 120000],
    ]);
    expect(r.erros).toHaveLength(1);
    expect(r.erros[0]!.linha).toBe(3);
    // O valor CRU entra na mensagem: quem corrige precisa achar a célula.
    expect(r.erros[0]!.motivo).toContain("doze mil");
  });

  it("sem coluna de título, o nome do CONTATO nomeia o card", () => {
    // O original punha "Lead importado" — 300 cards com o mesmo nome.
    const r = ok("nome do contato,telefone\nAna Souza,11988887777");
    expect(r.leads[0]!.title).toBe("Ana Souza");
    expect(r.leads[0]!.nome_do_contato).toBe("Ana Souza");
  });

  it("linha sem nenhum nome é recusada, não vira card genérico", () => {
    const r = ok("nome,valor\n,100\nBruno,200");
    expect(r.leads.map((l) => l.title)).toEqual(["Bruno"]);
    expect(r.erros[0]!.motivo).toContain("sem nome");
  });

  it("telefone com máscara vira E.164; o ilegível NÃO derruba o negócio", () => {
    const r = ok("nome,telefone\nAna,(11) 98888-7777\nBruno,não tem");
    expect(r.leads).toHaveLength(2);
    expect(r.leads[0]!.telefone).toBe("+5511988887777");
    // O negócio de Bruno entra sem contato — corrigir um card é mais barato que
    // reimportar a planilha —, mas o aviso fica: o número não some calado.
    expect(r.leads[1]!.telefone).toBeNull();
    expect(r.erros.some((e) => e.motivo.includes("não tem"))).toBe(true);
  });

  it("colunas desconhecidas são NOMEADAS, não descartadas em silêncio", () => {
    // É o que substitui o passo de mapear colunas do original: quem precisa
    // mapear renomeia o cabeçalho, e para isso precisa saber qual foi ignorado.
    const r = ok("nome,cpf do cliente,rating\nAna,111,5");
    expect(r.colunasIgnoradas).toEqual(["cpf do cliente", "rating"]);
  });

  it("linha em branco no meio não vira lead nem erro", () => {
    const r = ok("nome\nAna\n\nBruno");
    expect(r.leads.map((l) => l.title)).toEqual(["Ana", "Bruno"]);
    expect(r.erros).toEqual([]);
  });

  it("tags separadas por vírgula, ponto-e-vírgula ou barra viram lista", () => {
    // A célula vem ENTRE ASPAS porque o separador das tags é o mesmo caractere
    // que pode ser o delimitador da planilha — sem as aspas, "quente;retorno"
    // viraria uma terceira coluna e o teste mediria o parser, não a regra.
    const r = ok('nome,tags\nAna,"quente;retorno"');
    expect(r.leads[0]!.tags).toEqual(["quente", "retorno"]);
  });

  it("a linha reportada é a que a pessoa VÊ na planilha (1 é o cabeçalho)", () => {
    const r = ok("nome,valor\nAna,100\nBruno,xis");
    expect(r.erros[0]!.linha).toBe(3);
  });
});

/**
 * #923 — a aba "Arquivadas" existe, conta e não se mistura com "Fechadas".
 *
 * Arquiva-se para GUARDAR: a conversa sai da fila viva e vai para a pasta do
 * histórico. Isso exige três coisas acertadas ao mesmo tempo, e é o
 * desencontro entre elas que produz o defeito clássico — botão que arquiva,
 * aba que não mostra, badge que soma o que ninguém acha:
 *
 *  1. o filtro da aba (`tabToFilter`) pede `status: "archived"` — e NÃO a lista
 *     de status terminais (se pedisse, a aba mostraria também as fechadas);
 *  2. a aba está declarada na navegação (`FILTER_TABS` + `InboxFilters`) com
 *     badge lendo a contagem `archived`;
 *  3. a contagem existe na rota `counts`, filtrando `status = 'archived'`
 *     separadamente de `status = 'closed'`.
 *
 * Este arquivo é de FONTE, de propósito: o comportamento do `PATCH` (RPC +
 * auditoria) está provado em `arquivar-conversa.test.ts`, contra o handler real.
 * Montar o `InboxLayout` aqui exigiria jsdom + fetch mockado sem medir nada que
 * já não esteja medido — o que falta de verdade é o e2e (`tests/e2e/`, Docker).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tabToFilter } from "@/components/inbox/InboxLayout";

const raiz = process.cwd();
const fonte = (rel: string) => readFileSync(join(raiz, rel), "utf8");

/**
 * Bloco de um `case` de switch: do rótulo até o próximo `case`/fim do bloco.
 */
function blocoDoCase(arquivo: string, rotulo: string): string {
  const texto = fonte(arquivo);
  const inicio = texto.indexOf(`case "${rotulo}":`);
  expect(inicio, `case "${rotulo}" não encontrado em ${arquivo}`).toBeGreaterThan(-1);
  const resto = texto.slice(inicio + 1);
  const fim = resto.search(/\n\s*(case |default:)/);
  return fim === -1 ? resto : resto.slice(0, fim);
}

/** Código do bloco, sem comentários: é o código que decide, não a explicação. */
const semComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("aba Arquivadas — filtro da lista", () => {
  // Estes dois casos eram medidos por TEXTO-FONTE do bloco do `case`, com a
  // função exportada ao lado. Isso falha nos dois sentidos: mover a decisão para
  // fora do `switch` deixando o literal no bloco mantinha o teste verde com a
  // aba quebrada, e trocar o `switch` por um mapa reprovaria um refactor certo.
  // `tabToFilter` é exportada — então a pergunta se faz a ela.
  it('pede exatamente status "archived"', () => {
    expect(tabToFilter("archived")).toEqual({ status: "archived" });
  });

  it("não pede a lista de status terminais (senão a aba mostra as fechadas)", () => {
    const filtro = tabToFilter("archived") as Record<string, unknown>;
    // Se a aba passasse a pedir a lista terminal, `status` viria como ARRAY
    // (`["closed","archived",...]`) — é essa a forma que precisa não aparecer.
    // O controle positivo é da SONDA, não de outra aba: medi que "Fechadas"
    // também devolve string (`{ status: "closed" }`), então usá-la como
    // contraste provaria o contrário do que eu quis dizer.
    expect(Array.isArray(["closed", "archived"])).toBe(true);
    expect(Array.isArray(filtro.status)).toBe(false);
    expect(filtro.status).toBe("archived");
  });

  it("está na navegação do Inbox", () => {
    const layout = fonte("components/inbox/InboxLayout.tsx");
    const inicio = layout.indexOf("const FILTER_TABS");
    expect(inicio, "FILTER_TABS não encontrado").toBeGreaterThan(-1);
    // O primeiro `[` depois do nome NÃO é o do array: a anotação de tipo é
    // `InboxTab[]`, cujo `[]` vem antes do `=` e fechava o recorte vazio. Por
    // isso o array é lido depois do `=`.
    const igual = layout.indexOf("=", inicio);
    const abre = layout.indexOf("[", igual);
    const fecha = layout.indexOf("]", abre);
    expect(layout.slice(abre, fecha)).toContain('"archived"');
  });
});

describe("aba Arquivadas — rótulo e badge", () => {
  it("tem rótulo próprio em pt-BR e no tipo de aba", () => {
    const filtros = fonte("components/inbox/InboxFilters.tsx");
    expect(filtros).toContain('{ value: "archived", label: "Arquivadas" }');
    expect(filtros).toContain('"archived"');
  });

  it("o badge lê a contagem archived (não a de fechadas)", () => {
    const filtros = fonte("components/inbox/InboxFilters.tsx");
    expect(filtros).toMatch(/archived:\s*counts\?\.archived/);
  });
});

describe("contagem de arquivadas", () => {
  it("a rota counts filtra archived separadamente de closed", () => {
    const rota = fonte("app/api/v1/conversations/counts/route.ts");
    expect(rota).toMatch(/\.eq\("status",\s*"archived"\)/);
    expect(rota).toMatch(/\.eq\("status",\s*"closed"\)/);
  });

  it("devolve a chave archived no corpo", () => {
    const rota = fonte("app/api/v1/conversations/counts/route.ts");
    expect(rota).toMatch(/archived:\s*archived\.count/);
  });
});

describe("o botão de arquivar", () => {
  it("oferece arquivar com confirmação e some quando já está arquivada", () => {
    const header = fonte("components/inbox/ConversationHeader.tsx");
    expect(header).toContain('t("Arquivar")');
    expect(header).toContain('t("Arquivar esta conversa?")');
    expect(header).toMatch(/status !== "archived"/);
  });

  it("as strings do botão existem no dicionário (pt-BR e es)", () => {
    const dic = fonte("lib/i18n/dicionario.ts");
    // `"Arquivar"` já existia no dicionário, e sem aspas: a chave é um
    // identificador válido. Com aspas obrigatórias o teste reprovava o
    // dicionário CERTO — o que se mede aqui é a chave existir, não como ela foi
    // escrita.
    expect(dic).toMatch(/(?:"Arquivar"|Arquivar):\s*\{\s*es:/);
    expect(dic).toMatch(/Arquivadas:\s*\{\s*es:/);
    expect(dic).toMatch(/"Arquivar esta conversa\?":\s*\{\s*es:/);
  });
});

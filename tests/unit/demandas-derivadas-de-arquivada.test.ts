/**
 * O INSTRUMENTO do diagnóstico #2992 — parser, agregação, guarda de vacuidade e
 * a cerca de somente-leitura.
 *
 * ## Por que este arquivo NÃO testa as três categorias
 *
 * A régua que separa derivada limpa de ambígua e de legítima mora no SQL
 * (`supabase/diagnostico/demandas-derivadas-de-arquivada.sql`), e quem a mede é
 * o banco de teste — `tests/invariants/demandas-derivadas-de-arquivada.test.ts`,
 * rodando o arquivo de verdade sobre uma instalação semeada com um caso de cada.
 * Reescrever a régua aqui em TypeScript mediria a MINHA cópia: ela continuaria
 * verde com o SQL sabotado, que é o modo mais comum de um teste de régua virar
 * decoração. O que este arquivo mede é o que o SQL não pode prometer sozinho:
 *
 *  1. `conferirColunas` — sem ela, "0 demandas" e "a consulta devolveu outra
 *     coisa" imprimiriam a mesma tela. Zero só vale com a forma certa.
 *  2. `conferirSomenteLeitura` — nenhum verbo de escrita fora de comentário no
 *     termo que o script executa. É o que sustenta a promessa da issue de
 *     preservar as linhas quando o .sql for editado no futuro.
 *  3. `lerLinhas` — categoria fora das três LANÇA em vez de entrar na conta.
 *  4. `resumir`/`formatarTsv` — a contagem por categoria e por organização, que
 *     é o produto que a issue pede ("quantas por instalação").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATEGORIAS,
  conferirColunas,
  conferirSomenteLeitura,
  COLUNAS_EXIGIDAS,
  formatarRelatorio,
  formatarTsv,
  lerConsultaDeArquivo,
  lerLinhas,
  resumir,
  verboDeEscrita,
} from "@/scripts/demandas-derivadas-de-arquivada.leitura";

const CONSULTA = join("supabase", "diagnostico", "demandas-derivadas-de-arquivada.sql");
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/** Linha crua no formato que o `pg` devolve (nomes de coluna do SQL). */
function crua(apenas: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    categoria: "derivada_limpa",
    motivo: "conversa_arquivada_sem_mais_nada",
    organization_id: ORG_A,
    demanda_id: "33333333-3333-4333-8333-333333333331",
    aberta_em: new Date("2026-08-01T10:00:00Z"),
    estado: "aberta",
    conversas: 1,
    canais: 1,
    no_card: false,
    mensagens: 0,
    checkpoints: 0,
    tarefas: 0,
    ...apenas,
  };
}

describe("o parser recusa resultado que não é o diagnóstico", () => {
  it("conferirColunas: conjunto sem as colunas do diagnóstico não vira contagem", () => {
    // Todas as colunas: passa.
    expect(() => conferirColunas(COLUNAS_EXIGIDAS)).not.toThrow();
    // Zero linhas com a forma certa É uma medição válida ("não há resíduo").
    expect(() => conferirColunas([...COLUNAS_EXIGIDAS])).not.toThrow();
    // Sem `categoria` não há o que contar: é resultado de outra consulta.
    expect(() => conferirColunas(["organization_id", "demanda_id"])).toThrow(/categoria/);
    // Sem `organization_id`, a contagem por instalação viraria uma linha só.
    expect(() => conferirColunas(COLUNAS_EXIGIDAS.filter((c) => c !== "organization_id"))).toThrow(
      /organization_id/,
    );
  });

  it("categoria fora das três LANÇA em vez de virar um balde qualquer", () => {
    expect(() => lerLinhas([crua({ categoria: "residuo_provavel" })])).toThrow(/categoria desconhecida/);
  });

  it("linha sem demanda ou sem organização não entra (contagem ficaria cega)", () => {
    expect(() => lerLinhas([crua({ demanda_id: null })])).toThrow(/demanda_id/);
    expect(() => lerLinhas([crua({ organization_id: "" })])).toThrow(/organization_id/);
  });

  it("contagem não numérica LANÇA — `Number` silencioso viraria NaN na soma", () => {
    expect(() => lerLinhas([crua({ conversas: "duas" })])).toThrow(/conversas/);
  });

  it("booleano do psql (`t`) e texto são lidos como o banco devolve", () => {
    const [linha] = lerLinhas([crua({ no_card: "t", aberta_em: "2026-08-01T10:00:00Z" })]);
    expect(linha?.no_card).toBe(true);
    expect(linha?.aberta_em?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
  });
});

describe("a agregação separa as três categorias e quebra por organização", () => {
  it("conta uma de cada, com o total e o recorte por organização", () => {
    const linhas = lerLinhas([
      crua(),
      crua({ categoria: "ambigua", motivo: "compartilhada_entre_canais", conversas: 2, canais: 2 }),
      crua({ categoria: "legitima", motivo: "proximo_passo_de_gente" }),
    ]);
    const resumo = resumir(linhas);
    expect(resumo.total).toBe(3);
    expect(resumo.porCategoria).toEqual({ derivada_limpa: 1, ambigua: 1, legitima: 1 });
    expect(resumo.porOrganizacao).toHaveLength(1);

    const tsv = formatarTsv(resumo).split("\n");
    expect(tsv[0]).toBe("categoria\torganizacao\tdemandas");
    expect(tsv).toContain(`derivada_limpa\t${ORG_A}\t1`);
    expect(tsv).toContain(`ambigua\t${ORG_A}\t1`);
    expect(tsv).toContain(`legitima\t${ORG_A}\t1`);
    // A linha TOTAL existe por categoria e uma no fim: pipe sem cabeçalho de
    // total obriga quem consome a somar, e somar à mão é onde o número erra.
    expect(tsv).toContain("derivada_limpa\tTOTAL\t1");
    expect(tsv).toContain("total\tTOTAL\t3");
  });

  it("duas organizações: cada uma com o seu recorte, a maior primeiro", () => {
    const linhas = lerLinhas([
      crua(),
      crua({ demanda_id: "33333333-3333-4333-8333-333333333332" }),
      crua({
        organization_id: ORG_B,
        demanda_id: "33333333-3333-4333-8333-333333333333",
        categoria: "legitima",
      }),
    ]);
    const resumo = resumir(linhas);
    expect(resumo.total).toBe(3);
    expect(resumo.porOrganizacao.map((o) => o.organization_id)).toEqual([ORG_A, ORG_B]);
    expect(resumo.porOrganizacao[0]?.porCategoria.derivada_limpa).toBe(2);
    expect(resumo.porOrganizacao[1]?.porCategoria.legitima).toBe(1);
  });

  it("nenhuma candidata: três zeros, e o relatório diz que nada foi escrito", () => {
    const resumo = resumir([]);
    expect(resumo.total).toBe(0);
    expect(CATEGORIAS.map((c) => resumo.porCategoria[c])).toEqual([0, 0, 0]);
    expect(resumo.mais_antiga).toBeNull();
    const tsv = formatarTsv(resumo).split("\n");
    expect(tsv).toContain("derivada_limpa\tTOTAL\t0");
    const relatorio = formatarRelatorio(resumo, { sql: "select 1;", sha256: "0".repeat(64) });
    expect(relatorio).toMatch(/Nada foi escrito/);
  });

  it("o relatório carrega o hash da consulta que rodou — número sem termo é boato", () => {
    const resumo = resumir(lerLinhas([crua()]));
    const relatorio = formatarRelatorio(resumo, { sql: "select 1;", sha256: "a".repeat(64) });
    expect(relatorio).toContain("aaaaaaaaaaaaaaaa");
  });
});

describe("a cerca de somente-leitura: o termo executado não escreve", () => {
  it("a consulta da casa passa", () => {
    const consulta = lerConsultaDeArquivo(CONSULTA);
    expect(consulta.sql).toContain("origem = 'derivada'");
    expect(verboDeEscrita(consulta.sql)).toBeNull();
    expect(() => conferirSomenteLeitura(consulta.sql)).not.toThrow();
    // E a versão que roda tem hash: o relatório cita um termo identificável.
    expect(consulta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a consulta da casa nomeia as três categorias que o parser sabe contar", () => {
    const { sql } = lerConsultaDeArquivo(CONSULTA);
    for (const categoria of CATEGORIAS) {
      expect(sql, `a categoria '${categoria}' sumiu do SQL`).toContain(`'${categoria}'`);
    }
  });

  it("a consulta da casa trata o texto que o arquivamento escreve sozinho", () => {
    // `fn_service_status` grava este próximo passo ao arquivar. Se o SQL o
    // tomar por sinal de gente, todo resíduo arquivado vira "legítima" e o
    // diagnóstico passa a recomendar zero saneamento por construção.
    const { sql } = lerConsultaDeArquivo(CONSULTA);
    expect(sql).toContain("Revisar atendimento e registrar o desfecho da demanda");
  });

  it("é UMA instrução — duas statements num arquivo medem duas coisas", () => {
    const { sql } = lerConsultaDeArquivo(CONSULTA);
    const semComentario = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    expect(semComentario.split(";").filter((parte) => parte.trim() !== "")).toHaveLength(1);
  });

  it("escrita fora de comentário é RECUSADA — e o verbo aparece na mensagem", () => {
    expect(() => conferirSomenteLeitura("update public.demandas set desfecho = 'resolvida';")).toThrow(
      /update/,
    );
    expect(() => conferirSomenteLeitura("delete from public.demandas;")).toThrow(/delete/);
    expect(() => conferirSomenteLeitura("do $$ begin null; end $$;")).toThrow(/do/);
  });

  it("escrita DENTRO de comentário não é escrita — e a régua não pode reprovar prosa", () => {
    const comentada = `
      -- o saneamento faria: delete from public.demandas where origem = 'derivada'
      /* update public.demandas set desfecho = 'resolvida' — nunca, pela #2992 */
      select count(*) from public.demandas where origem = 'derivada';
    `;
    expect(verboDeEscrita(comentada)).toBeNull();
    expect(() => conferirSomenteLeitura(comentada)).not.toThrow();
  });

  it("arquivo vazio LANÇA em vez de devolver consulta sem resultado", () => {
    expect(() => lerConsultaDeArquivo(join("tests", "unit", "nao-existe-2992.sql"))).toThrow();
  });
});

describe("a consulta no disco é a que a issue pede", () => {
  it("declara-se somente-leitura e não escolhe desfecho", () => {
    const sql = readFileSync(join(process.cwd(), CONSULTA), "utf8");
    expect(sql).toMatch(/SOMENTE-LEITURA/);
    // Nenhum desfecho escolhido para as linhas: a issue é explícita em que
    // inventar `resolvida`/`nao_procede` afirma o que não aconteceu.
    for (const desfecho of ["'resolvida'", "'nao_procede'", "desfecho ="]) {
      expect(sql).not.toContain(desfecho);
    }
  });
});

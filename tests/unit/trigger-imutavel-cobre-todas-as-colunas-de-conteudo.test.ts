/**
 * A TRAVA DE IMUTABILIDADE DA VERSÃO PUBLICADA COBRE TODA COLUNA DE CONTEÚDO.
 *
 * `fn_ai_agent_version_content_immutable` impede um UPDATE de conteúdo numa
 * versão que já não é `draft`. A lista de colunas dela é escrita à mão, em
 * `create or replace`, e a ÚLTIMA definição que vale é a do `baseline.sql`
 * (o arquivo é dump + apêndice, e cada migration re-define a função).
 *
 * A lista é feita de `new.<col> is distinct from old.<col>`. O bug que este
 * arquivo previne é a lista envelhecer: uma coluna de conteúdo nova entra na
 * tabela (`add column if not exists`), a tela passa a editá-la, e quem esquece
 * de acrescentá-la à trigger reabre a cerca para a service key — uma versão
 * PUBLICADA pode ter conteúdo reescrito sem virar versão draft nova, sem trilha.
 * A camada da app devolve 409, mas é a única cerca; a trigger é a segunda,
 * defense-in-depth (`inbound_debounce_ms`, migration 0498/PR #1997, entrou na
 * tabela sem o trigger; `proposal_ai_draft_enabled` também ficou fora).
 *
 * A régua deriva o CONJUNTO de conteúdo do próprio SCHEMA (não do
 * `VERSION_COLUMNS` da app, que omite `multimodal_input`/`video_frames_enabled`
 * cobertas pela trigger): todas as colunas de `ai_agent_versions` menos as de
 * estado (id, status, published_at, superseded_at, created_at, created_by,
 * provisioning_origin). Toda coluna de conteúdo TEM de aparecer na trigger.
 *
 * Se a coluna de conteúdo nova não estiver na trigger, este teste fica
 * VERMELHO; o conserto é acrescentá-la ao `create or replace` (migration +
 * apêndice do baseline juntos — a tripla de schema). Uma coluna que saia da
 * tela não precisa sair da trigger: proteger mais nunca é buraco.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Colunas de ESTADO da tabela — é o que a trava NÃO protege. */
const COLUNAS_DE_ESTADO = new Set([
  "id",
  "status",
  "published_at",
  "superseded_at",
  "created_at",
  "created_by",
  "provisioning_origin",
]);

/**
 * Todas as colunas de `ai_agent_versions` no baseline: o bloco `create table`
 * (corpo do dump) mais todo `add column if not exists` dirigido à tabela.
 * Uma coluna declarada em unit test envelhece igual à da trigger; lida do
 * schema, ela se renova sozinha quando a migration nova entrar.
 */
function colunasDaTabela(sql: string): Set<string> {
  const colunas = new Set<string>();

  // Bloco `create table ... ai_agent_versions ( ... );`
  const bloco = /CREATE TABLE IF NOT EXISTS "public"\."ai_agent_versions" \((.*?)\)\s*;/s.exec(sql);
  if (bloco === null) throw new Error("create table de ai_agent_versions não encontrado");
  for (const match of (bloco[1] as string).matchAll(/^\s+"(\w+)"\s+"?\w+/gm)) {
    colunas.add(match[1] as string);
  }

  // `alter table [...ai_agent_versions] add column if not exists <col>` —
  // lendo o nome do alter ANTERIOR para não pegar add column de outra tabela
  // que referencie ai_agent_versions (ex.: flywheel_distiller_proposals).
  for (const m of sql.matchAll(/alter table\s+(\w+(?:\.\w+)?)\s*([\s\S]*?);/g)) {
    const tabela = (m[1] as string).split(".").pop() as string;
    if (tabela !== "ai_agent_versions") continue;
    for (const add of (m[2] as string).matchAll(/add column if not exists (\w+)/g)) {
      colunas.add(add[1] as string);
    }
  }

  return colunas;
}

/** As colunas de CONTEÚDO = todas menos as de estado. */
function colunasDeConteudo(sql: string): string[] {
  return [...colunasDaTabela(sql)].filter((c) => !COLUNAS_DE_ESTADO.has(c)).sort();
}

/**
 * O conjunto de colunas que a ÚLTIMA definição da trigger guarda
 * (`new.<col> is distinct from old.<col>`).
 */
function colunasProtegidasPelaTrigger(sql: string): string[] {
  // Todas as ocorrências do `create or replace`; a ÚLTIMA é a que vale.
  // Âncora no `as $fn$` de ABERTURA e fecha no `$fn$;` de fechamento (o `;` só
  // existe no fim) — sem isso a expressão não-lazy parava no delimitador de
  // abertura e a última definição saía com o corpo vazio.
  const definicoes = [
    ...sql.matchAll(/create or replace function fn_ai_agent_version_content_immutable[\s\S]*?as \$fn\$(.*?)\$fn\$;/gs),
  ];
  if (definicoes.length === 0) {
    throw new Error("fn_ai_agent_version_content_immutable não definida no baseline");
  }
  const ultima = definicoes[definicoes.length - 1]?.[0] as string;
  return [...ultima.matchAll(/new\.(\w+)\s+is distinct from old\.\1/g)]
    .map((m) => m[1] as string)
    .sort();
}

describe("trigger de imutabilidade × colunas de conteúdo de ai_agent_versions", () => {
  const sql = readFileSync(join(ROOT, "supabase", "baseline.sql"), "utf8");

  it("o instrumento acha o que precisa (guarda de vacuidade)", () => {
    const conteudo = colunasDeConteudo(sql);
    expect(conteudo.length).toBeGreaterThan(20);
    expect(conteudo).toContain("proposal_ai_draft_enabled");
    expect(conteudo).toContain("inbound_debounce_ms");
  });

  it("nova coluna de conteúdo sem a trigger cai (controle de DELETE)", () => {
    // Se o schema ganhar uma coluna de conteúdo que a trigger não protege,
    // este teste fica vermelho. Remover a coluna da trigger = sabotagem que
    // o pai mede reaplicando o restante do arquivo real.
    const conteudo = colunasDeConteudo(sql);
    const protegidas = new Set(colunasProtegidasPelaTrigger(sql));
    const fora = conteudo.filter((c) => !protegidas.has(c));
    expect(fora, "colunas de conteúdo ausentes da trigger").toEqual([]);
  });

  it("as duas colunas do relato são protegidas pela ÚLTIMA definição", () => {
    const protegidas = colunasProtegidasPelaTrigger(sql);
    expect(protegidas).toContain("proposal_ai_draft_enabled");
    expect(protegidas).toContain("inbound_debounce_ms");
  });

  it("a trigger não protege coluna de estado (cerca não se alarga em vão)", () => {
    const protegidas = new Set(colunasProtegidasPelaTrigger(sql));
    const estadoProtegido = [...protegidas].filter((c) => COLUNAS_DE_ESTADO.has(c));
    expect(estadoProtegido, "coluna de estado entrou na trigger").toEqual([]);
  });
});
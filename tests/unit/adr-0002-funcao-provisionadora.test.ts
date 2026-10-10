/**
 * A FUNÇÃO PROVISIONADORA DA ADR-0002 E OS GUARDS EM TORCA DELA — leitura do ARQUIVO, um
 * requisito por bloco (issue #1114).
 *
 * ─── Por que isto aqui e não em `tests/invariants/` ────────────────────────────────
 * Os invariantes medem o BANCO aplicado; este arquivo mede o que só o texto sabe, e é a
 * catraca barata que roda em todo `pnpm cercas` antes de custar um ciclo de Postgres:
 * tripla (migration + apêndice + MANIFEST), posição dos blocos e a forma das funções.
 * O comportamento — tabela nasce protegida, seção de módulo redige, cadeia compila sem
 * as tabelas — é de `tests/invariants/adr-0002-d7-*` e `adr-0002-d8-*`.
 *
 * ─── O estado medido na main de 28/09/2026, e por que os blocos D2–D7 nascem verdes ─
 * A issue #1114 dizia que a provisionadora "não existe". Medido na `main`, ELA EXISTE:
 *
 *   - D5 (rotinas de proteção fora do laço) — #1178 / migration 0325;
 *   - D4 (invariante das provisionadoras)  — #1178, `tests/invariants/provisionadora-de-modulo.test.ts`;
 *   - D3+D6 (instalar/reaplicar/falha alto) — #1289 / migration 0340;
 *   - D2 (a primeira provisionadora REAL)   — #1578 / migration 0480 (`fn_honorarios_provisionar`);
 *   - D8 de export (`42P01` do módulo ausente) — 0480/#1578, `lib/lgpd/export-collector.ts`.
 *
 * Ou seja: NÃO reimplementei o que já estava na `main`. Estes cinco blocos são guarda de
 * REGRESSÃO (continuam verdes sem este diff) — quem quiser vê-los ficar vermelhos tem de
 * sabotar o código de produção, e o diff da sabotagem está em cada PR que os entregou. O
 * que ESTE diff acrescenta de verdade é D8 de anonimização (seções de módulo por
 * `to_regclass`) e a prova de D7 — e é o bloco D8, logo abaixo, que fica VERMELHO sem ele.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const DIR_MIGRACOES = path.join(RAIZ, "supabase", "migrations");
const BASELINE = fs.readFileSync(path.join(RAIZ, "supabase", "baseline.sql"), "utf8");

/** Ache a migration pelo NÚMERO (0480), nunca pelo timestamp — renumeração não quebra aqui. */
function migracao(numero: string): string {
  const arquivo = fs.readdirSync(DIR_MIGRACOES).find((f) => f.includes(`_${numero}_`));
  expect(arquivo, `migration ${numero} não está em supabase/migrations/`).toBeTruthy();
  return fs.readFileSync(path.join(DIR_MIGRACOES, arquivo!), "utf8");
}

const MIG_0480 = migracao("0480");
const MIG_0485 = migracao("0485");

/** Bloco de `create or replace function ...` até a próxima função — o que o Postgres executa. */
function blocoDaFuncao(sql: string, nome: string): string {
  const inicio = sql.indexOf(`create or replace function public.${nome}(`);
  if (inicio < 0) return "";
  const fim = sql.indexOf("create or replace function", inicio + 10);
  // Quando a função é a ÚLTIMA do arquivo, `fim < 0` e o bloco vai até o fim —
  // nunca trunca em `+8000`: a fn_financeiro_provisionar() tem corpo longo (cria
  // as tabelas do módulo) e o revoke/grant dela fica além de 8000 chars.
  return sql.slice(inicio, fim < 0 ? sql.length : fim);
}

/** Toda provisionadora `fn_<modulo>_provisionar()` declarada numa origem. */
function provisionadoras(sql: string): string[] {
  return [...sql.matchAll(/^create or replace function public\.(fn_[a-z0-9_]+_provisionar)\(\)/gm)].map(
    (m) => m[1]!,
  );
}

// ---------------------------------------------------------------------------
// D2 — o schema do módulo mora numa função provisionadora fixa
// ---------------------------------------------------------------------------
describe("D2 — a função provisionadora é a casa do schema do módulo", () => {
  it("a varredura acha a provisionadora (sem isto os casos abaixo passariam por vazio)", () => {
    expect(provisionadoras(BASELINE).length).toBeGreaterThan(0);
    expect(provisionadoras(BASELINE)).toContain("fn_honorarios_provisionar");
    expect(provisionadoras(MIG_0480)).toContain("fn_honorarios_provisionar");
  });

  it("as tabelas do módulo nascem DENTRO do corpo da função, e nunca no corpo do baseline", () => {
    const corpo = blocoDaFuncao(BASELINE, "fn_honorarios_provisionar");
    expect(corpo).toContain("create table if not exists public.honorarios_contratos");
    expect(corpo).toContain("create table if not exists public.honorarios_parcelas");
    // Fora do corpo (no corpo do dump do baseline) elas não podem aparecer: é a condição 2
    // do dono — quem não instala o módulo não carrega as tabelas dele.
    const foraDoCorpo = BASELINE.replace(corpo, "");
    expect(foraDoCorpo).not.toContain("create table if not exists public.honorarios_contratos");
    expect(foraDoCorpo).not.toContain("create table if not exists public.honorarios_parcelas");
  });

  it("a tripla está completa: o mesmo corpo na migration e no apêndice do baseline", () => {
    expect(MIG_0480).toContain("create or replace function public.fn_honorarios_provisionar()");
    expect(BASELINE).toContain("create or replace function public.fn_honorarios_provisionar()");
    const man = fs.readFileSync(path.join(DIR_MIGRACOES, "MANIFEST.md"), "utf8");
    expect(man).toMatch(/\|\s*`20260928150200`\s*\|\s*`0480_honorarios_modulo_oficial`/);
  });
});

// ---------------------------------------------------------------------------
// D4 — sem parâmetro, execute só de service_role
// ---------------------------------------------------------------------------
describe("D4 — a provisionadora não recebe escolha de quem chama", () => {
  it("nenhuma provisionadora tem PARÂMETRO (nenhuma tabela, SQL ou organização vem de fora)", () => {
    expect(provisionadoras(BASELINE).length).toBeGreaterThan(0);
    for (const nome of provisionadoras(BASELINE)) {
      // `(...)` vazio na própria assinatura: não há de onde o chamador escolher o efeito.
      expect(BASELINE, `${nome} tem parâmetro`).toContain(
        `create or replace function public.${nome}()`,
      );
      expect(MIG_0480, `${nome} tem parâmetro na cadeia`).not.toContain(
        `function public.${nome}(p_`,
      );
    }
  });

  it("execute revogado das DUAS origens de grant e concedido só ao service_role", () => {
    for (const nome of provisionadoras(BASELINE)) {
      // O bloco vai do `create` até a PRÓXIMA função — e é justamente ali, antes dela,
      // que a cadeia põe o revoke (0480, linhas 229–230).
      const depois = blocoDaFuncao(BASELINE, nome);
      expect(depois, `${nome} sem security definer`).toMatch(/security definer/i);
      // A armadilha da 0108/0116: o grant DIRETO do `alter default privileges ... to anon`
      // não sai com `revoke from public`, e o grant a PUBLIC não sai com `revoke from anon`.
      expect(depois, `${nome} precisa revogar public E anon`).toContain(
        `revoke execute on function public.${nome}() from public, anon, authenticated`,
      );
      expect(depois, `${nome} precisa conceder só a service_role`).toContain(
        `grant execute on function public.${nome}() to service_role`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D5 — a função termina aplicando as proteções de tabela de organização
// ---------------------------------------------------------------------------
describe("D5 — a provisionadora termina na rotina de proteção", () => {
  it("o corpo chama fn_proteger_modulo_provisionado() no fim", () => {
    expect(blocoDaFuncao(BASELINE, "fn_honorarios_provisionar")).toContain(
      "perform public.fn_proteger_modulo_provisionado();",
    );
    expect(MIG_0480).toContain("perform public.fn_proteger_modulo_provisionado();");
    // A rotina em si é da onda 1 (#1178 / 0325) e continua sem parâmetro.
    expect(BASELINE).toContain("create or replace function public.fn_proteger_modulo_provisionado()");
  });
});

// ---------------------------------------------------------------------------
// D6 — reaplicar é explícito e falha alto
// ---------------------------------------------------------------------------
describe("D6 — reaplicar é explícito e falha alto", () => {
  it("as duas rotinas da reaplicação existem no baseline", () => {
    expect(BASELINE).toContain("create or replace function public.fn_reaplicar_modulos_instalados()");
    expect(BASELINE).toContain("create or replace function public.fn_conferir_modulos_instalados()");
  });

  it("a conferência NÃO repete o motivo original — senão o kit engole o erro como benigno", () => {
    const conferir = blocoDaFuncao(BASELINE, "fn_conferir_modulos_instalados");
    expect(conferir).toContain("raise exception");
    expect(conferir).toContain("modulos_instalados.motivo_suspensao");
    // O motivo (que pode ser "already exists") só fica na coluna; na mensagem entra o NOME
    // do módulo, nunca o texto do Postgres.
    expect(conferir).not.toContain("sqlerrm");
  });

  it("a cadeia chama as duas ao fim do baseline, como comandos separados", () => {
    const REAPLICA = "do $f$ begin perform public.fn_reaplicar_modulos_instalados(); end $f$;";
    const CONFERE = "do $f$ begin perform public.fn_conferir_modulos_instalados(); end $f$;";
    const i = BASELINE.lastIndexOf(REAPLICA);
    const j = BASELINE.lastIndexOf(CONFERE);
    // Depois da criação das próprias rotinas — nunca antes.
    expect(i, "o reaplicar não é chamado ao fim do baseline").toBeGreaterThan(
      BASELINE.indexOf("create or replace function public.fn_reaplicar_modulos_instalados()"),
    );
    expect(j, "a conferência não é chamada ao fim do baseline").toBeGreaterThan(
      BASELINE.indexOf("create or replace function public.fn_conferir_modulos_instalados()"),
    );
    // Comandos SEPARADOS: um bloco `do` para cada. Junto numa frase só seria uma
    // dependência implícita entre as duas — e a conferência passaria a depender de como
    // a outra é escrita.
    expect(i).not.toBe(j);
    expect(j).toBeGreaterThan(i);
    expect(BASELINE.split(REAPLICA).length - 1, "reaplicar chamado mais de uma vez").toBe(1);
    expect(BASELINE.split(CONFERE).length - 1, "conferência chamada mais de uma vez").toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D7 — as funções do módulo existem mesmo sem as tabelas
// ---------------------------------------------------------------------------
describe("D7 — a cadeia de funções do módulo não depende das tabelas", () => {
  it("a função de negócio existe nas DUAS origens (migration e baseline)", () => {
    const nome = "fn_honorarios_parcela_pagar";
    expect(MIG_0480).toContain(`create or replace function public.${nome}(`);
    expect(BASELINE).toContain(`create or replace function public.${nome}(`);
  });

  it("nenhuma função do módulo declara `%rowtype` de tabela do módulo", () => {
    // `record` compila sem a tabela; `%rowtype` é resolvido na CRIAÇÃO da função — e com
    // `check_function_bodies` ligado (o piso do Postgres para migration) a criação FALHA.
    // É a regra que o invariante adr-0002-d7-* mede no banco, com o corpo real.
    const nomos = ["fn_honorarios_parcela_pagar", "fn_honorarios_provisionar"];
    for (const nome of nomos) {
      for (const origem of [MIG_0480, blocoDaFuncao(BASELINE, nome)]) {
        expect(origem, `${nome} usa %rowtype de tabela do módulo`).not.toMatch(
          /public\.honorarios_[a-z]+%rowtype/i,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// D8 — LGPD/export/varreduras alcançam o módulo
// ---------------------------------------------------------------------------
describe("D8 — a anonimização alcança as seções de módulo declaradas", () => {
  it("a tabela do registro e a função do gatilho existem nas DUAS origens (tripla)", () => {
    for (const origem of [BASELINE, MIG_0485]) {
      expect(origem).toContain("create table if not exists public.modulo_secoes_lgpd");
      expect(origem).toContain("create or replace function public.fn_lgpd_redigir_secoes_de_modulo()");
      expect(origem).toContain("create trigger trg_lgpd_secoes_de_modulo");
      expect(origem).toContain(
        "revoke execute on function public.fn_lgpd_redigir_secoes_de_modulo() from public, anon, authenticated",
      );
    }
    const man = fs.readFileSync(path.join(DIR_MIGRACOES, "MANIFEST.md"), "utf8");
    expect(man).toMatch(/\|\s*`20260928214705`\s*\|\s*`0485_lgpd_alcanca_secoes_de_modulo`/);
  });

  it("cada seção passa por to_regclass ANTES de qualquer comando — módulo ausente pula", () => {
    // É o coração da D8: uma cascata que citasse a tabela pelo nome abortaria a
    // anonimização inteira em toda instalação sem o módulo.
    for (const origem of [BASELINE, MIG_0485]) {
      const corpo = blocoDaFuncao(origem, "fn_lgpd_redigir_secoes_de_modulo");
      expect(corpo, "corpo da função não encontrado").not.toBe("");
      expect(corpo).toContain("to_regclass(");
      expect(corpo).toContain("continue;");
      // E o SQL dinâmico é montado com `format` + `using` — nenhum valor de contato no texto.
      expect(corpo).toContain("execute format(");
      expect(corpo).toContain("using new.organization_id, new.id");
      // Coluna declarada que não existe é ERRO ALTO, não redação pela metade.
      expect(corpo).toContain("modulo_secao_invalida");
    }
  });

  it("o gatilho é a virada de is_anonymized em contacts, e sem parâmetro (D4)", () => {
    for (const origem of [BASELINE, MIG_0485]) {
      const gatilho = /create trigger trg_lgpd_secoes_de_modulo[\s\S]{0,400}?fn_lgpd_redigir_secoes_de_modulo/.exec(
        origem,
      )?.[0];
      expect(gatilho, "trigger não encontrado").toBeTruthy();
      expect(gatilho).toContain("after update of is_anonymized on public.contacts");
      expect(gatilho).toContain("when (new.is_anonymized and not old.is_anonymized)");
      expect(origem).toContain("create or replace function public.fn_lgpd_redigir_secoes_de_modulo()");
      expect(origem).not.toContain("function public.fn_lgpd_redigir_secoes_de_modulo(p_");
    }
  });

  it("a função entra ANTES do bloco da VARREDURA anon — depois dele, nenhuma função é criada", () => {
    const posFuncao = BASELINE.indexOf(
      "create or replace function public.fn_lgpd_redigir_secoes_de_modulo()",
    );
    const posVarredura = BASELINE.indexOf("-- ---- VARREDURA anon:");
    expect(posFuncao).toBeGreaterThan(0);
    expect(posVarredura).toBeGreaterThan(posFuncao);
  });
});

// ---------------------------------------------------------------------------
// #1906 — o update.sh ANTIGO não pode enxergar regra de módulo no texto
// ---------------------------------------------------------------------------
describe("#1906 — regra de módulo não fica visível à conferência antiga do update.sh", () => {
  // A regex é a da conferência de v1.39.0 a v1.63.0 (`hostgator-setup-kit/update.sh`),
  // que lê o baseline LINHA A LINHA, sem saber o que é corpo de função. Esse script
  // antigo é o que roda na atualização (fica no disco durante o `git checkout`), então
  // consertá-lo não alcança quem atualiza: numa instalação sem o módulo, a regra com
  // nome e tabela na mesma linha era cobrada e a atualização abortava com o CRM parado.
  const REGRA_DA_CONFERENCIA_ANTIGA = /create policy "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/;

  function corpoAteODelimitador(sql: string, nome: string): string {
    const inicio = sql.indexOf(`create or replace function public.${nome}()`);
    const fim = sql.indexOf("\n$f$;", inicio);
    return inicio < 0 || fim < 0 ? "" : sql.slice(inicio, fim);
  }

  it("nenhuma linha do corpo de provisionadora casa a regex da conferência antiga", () => {
    expect(provisionadoras(BASELINE).length).toBeGreaterThan(0);
    for (const nome of provisionadoras(BASELINE)) {
      const corpo = corpoAteODelimitador(BASELINE, nome);
      expect(corpo, `corpo de ${nome} não encontrado`).toContain("create policy");
      const visiveis = corpo.split("\n").filter((l) => REGRA_DA_CONFERENCIA_ANTIGA.test(l));
      expect(visiveis, `${nome}: parta em duas linhas (create policy X / on public.Y)`).toEqual([]);
    }
  });
});

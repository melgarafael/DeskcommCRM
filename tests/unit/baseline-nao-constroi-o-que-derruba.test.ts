import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O BASELINE NÃO RECONSTRÓI, A CADA UPDATE, O QUE ELE MESMO DERRUBA OU SUBSTITUI.
 *
 * O `baseline.sql` é aplicado inteiro em toda instalação e em todo `update.sh`,
 * em autocommit: cada comando vale na hora. Um objeto criado no corpo (ou num
 * bloco antigo do apêndice) e derrubado ou substituído adiante é refeito TODA
 * vez, e fica valendo até o comando que o desfaz.
 *
 * ## Índice (a regra original)
 *
 * `CREATE INDEX` não concorrente trava escrita enquanto constrói. Foi o que a
 * migration 0259 trouxe na primeira versão: três índices redundantes criados
 * acima e derrubados no fim. Medido em pg17, aplicando o baseline até o rótulo
 * da 0259: os três existiam naquele ponto.
 *
 * ## Constraint que constrói índice (UNIQUE, PRIMARY KEY, EXCLUDE)
 *
 * Até 2026-09-16 a régua só lia `create index`, e três criações únicas que a 0181
 * e a 0205 derrubam passaram (duas congeladas como dívida, a constraint
 * `ai_kbv_version_unique` nem aparecia). O modelo novo PERMITE o que o índice
 * velho proibia — várias fontes por agente, cada uma com a sua versão 1 —, então
 * num clone que usa o acervo a recriação falhava por duplicata. Medido numa VPS
 * real: os três erros nos dois `update.sh` com log guardado (v1.27.2 e v1.27.3),
 * e o `deadlock detected` que apagou uma policy na v1.27.3 saiu na tela no meio
 * deles. A prova em banco é `tests/invariants/baseline-reaplica-sobre-acervo-real.test.ts`.
 *
 * ## Policy — a mesma classe, com dano de acesso
 *
 * A revisão da mesma correção achou 21 policies criadas e derrubadas adiante sem
 * recriação (17 no corpo do dump, 2 em blocos antigos do apêndice, 2 num laço
 * `foreach … execute format(…)` da 0085) e 2 reinstaladas numa versão
 * intermediária MAIS LARGA que a final (`conversations_select` na 0030,
 * `cae_select` na 0031). Policies permissivas somam com OR: nesse intervalo um
 * `viewer` gravava, apagava e inseria em `crm_leads` (medido em pg: 0 hoje, 1 com
 * o bloco antigo), e cada passada extra de `reaplicar_baseline` reabria a janela.
 * A chave é nome + tabela. Redefinição intermediária idêntica à final é permitida:
 * reinstala o mesmo texto (há 6 assim, de `attendant_availability` e `voice_calls`).
 *
 * ## O que conta como guarda
 *
 * - `condição`: um `do` com `if` sobre OUTRA coisa que não a existência do próprio
 *   objeto (ex.: a 0127 só cria o índice onde a constraint falta). Isenta.
 * - `existência`: o `DO $baseline_guard$` do dump, um `if` que só pergunta pelo
 *   próprio nome, ou `exception when duplicate_object`. NÃO isenta a criação
 *   antes de um drop (o drop apagou o objeto, então a guarda cria de novo), mas
 *   impede a reinstalação de versão intermediária (o objeto final já existe).
 * - `nenhuma`: comando de topo, ou `do` sem `if` nenhum.
 *
 * ## Escopo, escrito para não ser lido maior do que é
 *
 * Nome literal, com ou sem `if exists`, mais o laço `foreach t in array[...]`
 * com `format('… %s … public.%I')`. Outras formas dinâmicas ficam fora. CHECK e
 * FOREIGN KEY ficam fora: não constroem índice, e as instâncias medidas validam
 * coluna recriada vazia. Função, grant e trigger ficam fora — a mesma classe
 * existe neles (medido na mesma revisão) e é trabalho próprio.
 *
 * Lê texto; que o ciclo install→update sai 0 é o job `invariants` quem mede, e
 * `tests/invariants/indices-redundantes-saem.test.ts` mede o estado final.
 */
const SQL = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

type Guarda = "nenhuma" | "existencia" | "condicao";

interface Par {
  nome: string;
  linhaDaCriacao: number;
  linhaDoDrop: number;
  guarda: Guarda;
}

interface Ocorrencia {
  chave: string;
  nomeProprio: string;
  pos: number;
}

function linhaDe(sql: string, pos: number): number {
  return sql.slice(0, pos).split("\n").length;
}

/** O bloco `do $tag$ … $tag$` que contém a posição, se houver. Fecha no próximo `$tag$`. */
function blocoDoEm(sql: string, pos: number): { tag: string; corpo: string; inicio: number } | null {
  let achado: { tag: string; corpo: string; inicio: number } | null = null;
  for (const m of sql.matchAll(/^\s*do\s+(\$[a-z_]*\$)/gim)) {
    const inicio = m.index! + m[0].length;
    if (inicio > pos) break;
    const tag = m[1]!;
    const fim = sql.indexOf(tag, inicio);
    if (fim !== -1 && fim < pos) continue;
    achado = { tag: tag.toLowerCase(), corpo: sql.slice(inicio, fim === -1 ? sql.length : fim), inicio };
  }
  return achado;
}

/**
 * As faixas `if … then … end if` do corpo, com a condição de cada uma. Só a faixa
 * que CONTÉM a criação decide: um `if` sobre outra coisa, em qualquer outro ponto
 * do mesmo bloco, não isenta nada. (Medido: sem isto, acrescentar um `if` neutro
 * ao bloco do laço da 0085 devolvia o defeito das policies com a régua verde.)
 * `elsif` não abre faixa — `\bif\b` não casa dentro dele.
 */
function faixasDeIf(corpo: string): Array<{ condicao: string; inicio: number; fim: number }> {
  const marcas = [...corpo.matchAll(/\bend\s+if\b|(?<!\bend\s{1,10})\bif\b/gi)];
  const pilha: number[] = [];
  const faixas: Array<{ condicao: string; inicio: number; fim: number }> = [];
  for (const m of marcas) {
    // `create index if not exists …` também tem um `if`, e ele não abre bloco: o
    // que abre é o `if … then` do plpgsql. A diferença é o `then` vir antes do
    // `;` do comando.
    if (!/^end/i.test(m[0])) {
      const resto = corpo.slice(m.index! + m[0].length);
      const ate = resto.search(/;/);
      const then = resto.search(/\bthen\b/i);
      if (then === -1 || (ate !== -1 && ate < then)) continue;
    }
    if (/^end/i.test(m[0])) {
      const inicio = pilha.pop();
      if (inicio !== undefined) {
        const depoisDoThen = corpo.slice(inicio).match(/\bthen\b/i);
        faixas.push({
          condicao: depoisDoThen ? corpo.slice(inicio, inicio + depoisDoThen.index!).toLowerCase() : "",
          inicio,
          fim: m.index! + m[0].length,
        });
      }
    } else {
      pilha.push(m.index!);
    }
  }
  return faixas;
}

function guardaEm(sql: string, pos: number, nomeProprio: string): Guarda {
  const bloco = blocoDoEm(sql, pos);
  if (!bloco) return "nenhuma";
  const posNoCorpo = pos - bloco.inicio;
  const cercando = faixasDeIf(bloco.corpo).filter((f) => f.inicio < posNoCorpo && posNoCorpo < f.fim);
  if (cercando.length === 0) {
    return /exception\s+when\s+duplicate_object/i.test(bloco.corpo) ? "existencia" : "nenhuma";
  }
  return cercando.every((f) => f.condicao.includes(nomeProprio.toLowerCase())) ? "existencia" : "condicao";
}

function ocorrencias(sql: string, rx: RegExp, chave: (m: RegExpMatchArray) => [string, string]): Ocorrencia[] {
  return [...sql.matchAll(rx)].map((m) => {
    const [k, nomeProprio] = chave(m);
    return { chave: k.toLowerCase(), nomeProprio: nomeProprio.toLowerCase(), pos: m.index! };
  });
}

/**
 * Pares cria→derruba cujo objeto NÃO sobrevive ao arquivo. Uma recriação da
 * mesma chave depois do último drop é REDEFINIÇÃO e fica fora desta regra.
 */
function pares(sql: string, drops: Ocorrencia[], criacoes: Ocorrencia[], recriacoes: Ocorrencia[]): Par[] {
  const ultimoDrop = new Map<string, number>();
  for (const d of [...drops].sort((a, b) => a.pos - b.pos)) ultimoDrop.set(d.chave, d.pos);
  const achados: Par[] = [];
  for (const [chave, posDrop] of ultimoDrop) {
    if (recriacoes.some((r) => r.chave === chave && r.pos > posDrop)) continue;
    for (const c of criacoes.filter((c) => c.chave === chave && c.pos < posDrop)) {
      achados.push({
        nome: chave,
        linhaDaCriacao: linhaDe(sql, c.pos),
        linhaDoDrop: linhaDe(sql, posDrop),
        guarda: guardaEm(sql, c.pos, c.nomeProprio),
      });
    }
  }
  return achados;
}

const nome = (m: RegExpMatchArray): [string, string] => [m[1]!, m[1]!];
const nomeNaTabela = (m: RegExpMatchArray): [string, string] => [`${m[1]} on ${m[2]}`, m[1]!];

function criacoesDeIndice(sql: string): Ocorrencia[] {
  return ocorrencias(sql, /create (?:unique )?index (?:concurrently )?(?:if not exists )?"?([a-z0-9_]+)"?(?=\s|$)/gi, nome);
}

function paresDeIndice(sql: string): Par[] {
  const criacoes = criacoesDeIndice(sql);
  const drops = ocorrencias(sql, /drop index (?:concurrently )?(?:if exists )?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi, nome);
  return pares(sql, drops, criacoes, criacoes);
}

/** Só as que constroem índice: é o índice que custa lock e que falha por duplicata. */
function paresDeConstraint(sql: string): Par[] {
  const drops = ocorrencias(sql, /drop constraint (?:if exists )?"?([a-z0-9_]+)"?/gi, nome);
  const criacoes = ocorrencias(sql, /add constraint\s+"?([a-z0-9_]+)"?\s+(?:unique|primary key|exclude)\b/gi, nome);
  const recriacoes = [
    ...ocorrencias(sql, /add constraint\s+"?([a-z0-9_]+)"?(?=\s)/gi, nome),
    ...criacoesDeIndice(sql),
  ];
  return pares(sql, drops, criacoes, recriacoes);
}

// O `(?![\w".])` no fim é o que impede `on public.%I` (dentro de um `execute
// format`) de ser lido como uma policy na tabela chamada "public": sem ele o
// regex voltava atrás e capturava o schema como tabela — 11 chaves fantasma no
// arquivo real, contra o escopo escrito aqui em cima.
const ALVO_DE_POLICY = String.raw`"?([a-z0-9_]+)"?\s+on\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?([a-z0-9_]+)"?(?![\w".])`;

/** `foreach t in array[...] loop … format('… policy x_%s_y on public.%I …')`, expandido por tabela. */
function policiesEmLaco(sql: string, verbo: "create" | "drop"): Ocorrencia[] {
  const achadas: Ocorrencia[] = [];
  const laco = /foreach\s+\w+\s+in\s+array\s+(?:array\s*)?\[([^\]]*)\]\s*loop([\s\S]*?)end\s+loop/gi;
  const comando =
    verbo === "create"
      ? /create policy\s+([a-z0-9_]*)%s([a-z0-9_]*)\s+on\s+public\.%I/gi
      : /drop policy\s+(?:if exists\s+)?([a-z0-9_]*)%s([a-z0-9_]*)\s+on\s+public\.%I/gi;
  for (const m of sql.matchAll(laco)) {
    const tabelas = [...m[1]!.matchAll(/'([a-z0-9_]+)'/g)].map((t) => t[1]!);
    const inicioDoCorpo = m.index! + m[0].indexOf(m[2]!);
    for (const f of m[2]!.matchAll(comando)) {
      for (const t of tabelas) {
        const nomeDaPolicy = `${f[1]}${t}${f[2]}`;
        achadas.push({ chave: `${nomeDaPolicy} on ${t}`, nomeProprio: nomeDaPolicy, pos: inicioDoCorpo + f.index! });
      }
    }
  }
  return achadas;
}

function criacoesDePolicy(sql: string): Ocorrencia[] {
  return [
    ...ocorrencias(sql, new RegExp(String.raw`create policy\s+` + ALVO_DE_POLICY, "gi"), nomeNaTabela),
    ...policiesEmLaco(sql, "create"),
  ];
}

function paresDePolicy(sql: string): Par[] {
  const criacoes = criacoesDePolicy(sql);
  const drops = [
    ...ocorrencias(sql, new RegExp(String.raw`drop policy\s+(?:if exists\s+)?` + ALVO_DE_POLICY, "gi"), nomeNaTabela),
    ...policiesEmLaco(sql, "drop"),
  ];
  return pares(sql, drops, criacoes, criacoes);
}

/**
 * O comando `create policy … ;` a partir da posição, normalizado para comparar
 * definições. Os comentários `--` saem ANTES do corte: no arquivo real, 4 desses
 * comandos têm um `;` dentro de um comentário, e cortar ali comparava um prefixo
 * (o `cae_select` final terminava em "de outro;", com parênteses desbalanceados).
 */
function textoDaPolicy(sql: string, pos: number): string {
  const semComentario = sql.slice(pos).replace(/--[^\n]*/g, "");
  const fim = semComentario.indexOf(";");
  return semComentario
    .slice(0, fim === -1 ? semComentario.length : fim)
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Definições LITERAIS de policy que rodam a cada update (sem guarda) e diferem da
 * definição final da mesma chave: a versão intermediária vale até a final chegar.
 */
function redefinicoesIntermediarias(sql: string): string[] {
  const porChave = new Map<string, Ocorrencia[]>();
  for (const c of ocorrencias(sql, new RegExp(String.raw`create policy\s+` + ALVO_DE_POLICY, "gi"), nomeNaTabela)) {
    porChave.set(c.chave, [...(porChave.get(c.chave) ?? []), c]);
  }
  const achadas: string[] = [];
  for (const [chave, lista] of porChave) {
    if (lista.length < 2) continue;
    const final = lista[lista.length - 1]!;
    for (const c of lista.slice(0, -1)) {
      if (guardaEm(sql, c.pos, c.nomeProprio) !== "nenhuma") continue;
      if (textoDaPolicy(sql, c.pos) !== textoDaPolicy(sql, final.pos)) {
        achadas.push(`${chave}: linha ${linhaDe(sql, c.pos)} difere da final na linha ${linhaDe(sql, final.pos)}`);
      }
    }
  }
  return achadas;
}

function proibidos(achados: Par[]): string[] {
  return achados
    .filter((p) => p.guarda !== "condicao")
    .map((p) => `${p.nome}: criado na linha ${p.linhaDaCriacao}, derrubado na ${p.linhaDoDrop}`);
}

const nomes = (achados: Par[]) => [...new Set(achados.map((p) => p.nome))].sort();
const nomesProibidos = (achados: Par[]) => nomes(achados.filter((p) => p.guarda !== "condicao"));

/**
 * As formas que o arquivo teve até 2026-09-16, e as que NÃO são defeito. Cada
 * propriedade tem o seu caso, para que cada sabotagem reprove com a mensagem da
 * propriedade que quebrou, e não com a de outra.
 */
const SINTETICO = `
CREATE UNIQUE INDEX IF NOT EXISTS "velho_idx" ON "public"."t" USING "btree" ("a") WHERE "ativo";

DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'velha_uk' AND conrelid = '"public"."t"'::regclass)
   AND to_regclass('"public"."velha_uk"') IS NULL THEN
ALTER TABLE ONLY "public"."t"
    ADD CONSTRAINT "velha_uk" UNIQUE ("a", "b");
END IF; END $baseline_guard$;

ALTER TABLE ONLY "public"."t"
    ADD CONSTRAINT "velha_pk" PRIMARY KEY ("a");

alter table public.t add constraint velha_ex exclude using gist (a with =);

alter table public.t add constraint vira_indice unique (c);

DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'velha_pol' AND polrelid = '"public"."t"'::regclass) THEN
CREATE POLICY "velha_pol" ON "public"."t" USING (true);
END IF; END $baseline_guard$;

create policy "mesmo_nome" on public.outra using (true);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'outra_uk') then
    create unique index if not exists cond_idx on public.t (a);
  end if;
end$$;

create policy "depois_de_end_colado" on public.t using (true);

do $$ begin create policy pol_sem_if on public.t using (true); end $$;

do $$
begin
  if to_regclass('public.outra') is not null then
    perform 1;
  end if;
  create policy pol_fora_do_if on public.t using (true);
end $$;

do $$ begin
  create policy pol_duplicate_object on public.t using (true);
exception when duplicate_object then null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['tab_a', 'tab_b'] loop
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format('create policy tenant_isolation_%s_all on public.%I for all using (true)', t, t);
  end loop;
end $$;

drop policy if exists "sel_larga" on public.t;
create policy "sel_larga" on public.t for select using (true);

drop policy if exists "sel_igual" on public.t;
create policy "sel_igual" on public.t for select using (dono = auth.uid());

-- ---- apêndice (migration 9999) ----
drop index if exists public.velho_idx;
drop index if exists public.cond_idx;
alter table public.t drop constraint if exists velha_uk;
alter table public.t drop constraint velha_pk;
alter table public.t drop constraint if exists velha_ex;
alter table public.t drop constraint vira_indice;
create unique index if not exists vira_indice on public.t (c);
alter table public.t drop constraint if exists redefinida_uk;
alter table public.t add constraint redefinida_uk unique (b);
drop policy if exists velha_pol on public.t;
drop policy if exists "mesmo_nome" on public.t;
drop policy if exists depois_de_end_colado on public.t;
drop policy if exists pol_sem_if on public.t;
drop policy if exists pol_fora_do_if on public.t;
drop policy if exists pol_duplicate_object on public.t;
drop policy if exists tenant_isolation_tab_a_all on public.tab_a;
drop policy if exists "sel_larga" on public.t;
create policy "sel_larga" on public.t for select using (dono = auth.uid());
drop policy if exists "sel_igual" on public.t;
create policy "sel_igual" on public.t for select using (dono = auth.uid());
`;

describe("o instrumento, contra formas conhecidas", () => {
  it("índice: acha a criação incondicional e poupa a condicional", () => {
    expect(proibidos(paresDeIndice(SINTETICO))).toEqual([
      expect.stringMatching(/^velho_idx: criado na linha 2, derrubado na \d+$/),
    ]);
    expect(paresDeIndice(SINTETICO).find((p) => p.nome === "cond_idx")?.guarda).toBe("condicao");
  });

  it("constraint: a régua enxerga UNIQUE, PRIMARY KEY e EXCLUDE, com drop com ou sem if exists", () => {
    expect(nomes(paresDeConstraint(SINTETICO))).toEqual(expect.arrayContaining(["velha_ex", "velha_pk", "velha_uk"]));
  });

  it("guarda de existência não é condição: nem a do dump, nem exception when duplicate_object", () => {
    expect(paresDeConstraint(SINTETICO).find((p) => p.nome === "velha_uk")?.guarda).toBe("existencia");
    expect(paresDePolicy(SINTETICO).find((p) => p.nome === "pol_duplicate_object on t")?.guarda).toBe("existencia");
  });

  it("constraint: voltar como índice único do mesmo nome é redefinição, e drop + add também", () => {
    const achados = nomes(paresDeConstraint(SINTETICO));
    expect(achados).not.toContain("vira_indice");
    expect(achados).not.toContain("redefinida_uk");
  });

  it("policy: casa nome E tabela", () => {
    const achados = nomesProibidos(paresDePolicy(SINTETICO));
    expect(achados).toContain("velha_pol on t");
    expect(achados).not.toContain("mesmo_nome on outra");
  });

  it("um bloco fechado com end$$ colado não esconde o que vem depois dele", () => {
    expect(nomesProibidos(paresDePolicy(SINTETICO))).toContain("depois_de_end_colado on t");
  });

  it("do sem if nenhum não é condicional", () => {
    expect(paresDePolicy(SINTETICO).find((p) => p.nome === "pol_sem_if on t")?.guarda).toBe("nenhuma");
  });

  it("só o if que CONTÉM a criação isenta — um if ao lado, no mesmo do, não", () => {
    expect(paresDePolicy(SINTETICO).find((p) => p.nome === "pol_fora_do_if on t")?.guarda).toBe("nenhuma");
  });

  it("laço foreach … format('… %s … public.%I') é expandido por tabela", () => {
    const achados = nomesProibidos(paresDePolicy(SINTETICO));
    expect(achados).toContain("tenant_isolation_tab_a_all on tab_a");
    expect(achados).not.toContain("tenant_isolation_tab_b_all on tab_b");
  });

  it("redefinição intermediária: acusa a que difere da final e poupa a idêntica", () => {
    expect(redefinicoesIntermediarias(SINTETICO)).toEqual([expect.stringMatching(/^sel_larga on t: /)]);
  });
});

describe("baseline.sql não reconstrói o que ele mesmo derruba ou substitui", () => {
  it("o instrumento está vivo no arquivo real: acha pares, laços e redefinições", () => {
    expect(paresDeIndice(SQL).length, "nenhum par cria→derruba encontrado — o parser mudou?").toBeGreaterThan(0);
    expect(policiesEmLaco(SQL, "create").length, "nenhum laço de policy encontrado — o parser mudou?").toBeGreaterThan(10);
    // A LIGAÇÃO, e não só a função: sem ela o caso das policies do arquivo real
    // passa por omissão (foi o que a sabotagem que desligou a expansão mostrou —
    // `policiesEmLaco` sozinha continuava verde).
    expect(
      criacoesDePolicy(SQL).map((c) => c.chave),
      "a expansão do laço não chega ao localizador de pares",
    ).toContain("tenant_isolation_lead_state_all on lead_state");
  });

  it("nenhuma criação de índice antes do próprio drop, fora de condição de verdade", () => {
    expect(
      proibidos(paresDeIndice(SQL)),
      "Índice construído e jogado fora a cada install/update. Tire a criação (ou a torne " +
        "condicional ao mesmo predicado do drop, invertido).\n",
    ).toEqual([]);
  });

  it("nenhuma constraint que constrói índice é criada antes do próprio drop", () => {
    expect(
      proibidos(paresDeConstraint(SQL)),
      "Constraint UNIQUE/PK/EXCLUDE construída e derrubada a cada install/update — e num clone " +
        "com dados do modelo novo ela falha por duplicata. Tire a criação.\n",
    ).toEqual([]);
  });

  it("nenhuma policy é criada antes do próprio drop", () => {
    expect(
      proibidos(paresDePolicy(SQL)),
      "Policy recriada e derrubada a cada install/update: entre as duas, a regra antiga volta a " +
        "valer somada às novas. Tire a criação.\n",
    ).toEqual([]);
  });

  it("nenhuma policy é reinstalada numa versão intermediária diferente da final", () => {
    expect(
      redefinicoesIntermediarias(SQL),
      "Definição intermediária roda a cada update e vale até a final chegar. Tire a intermediária " +
        "(o drop da final já cuida do clone antigo).\n",
    ).toEqual([]);
  });

  it("a criação condicional de ai_models_provider_model_unique depende da AUSÊNCIA da constraint", () => {
    // O bloco `do` sozinho não prova nada: um `if true then create …` passaria no
    // caso acima. O que torna a criação inofensiva é o predicado ser o inverso do
    // guard do drop da 0259 — os dois nunca agem sobre o mesmo banco.
    const par = paresDeIndice(SQL).find((p) => p.nome === "ai_models_provider_model_unique");
    expect(par, "a criação da 0127 sumiu — confira se a unicidade ainda tem fallback").toBeDefined();
    expect(par!.guarda).toBe("condicao");
    const linhas = SQL.split("\n");
    const janela = linhas.slice(Math.max(0, par!.linhaDaCriacao - 8), par!.linhaDaCriacao).join("\n");
    expect(janela).toMatch(/if not exists \(\s*select 1 from pg_constraint\s+where conname = 'ai_models_unique'/);
  });
});

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
 * Nome literal, com ou sem `if exists`, mais DUAS formas de laço com
 * `execute format(…)`:
 *
 * - `foreach t in array[...]`, com a lista de tabelas LITERAL — expandido por
 *   tabela, porque o conjunto é conhecível ao ler o arquivo;
 * - `for r in <select …> loop`, a varredura de CATÁLOGO — expandido para UMA
 *   chave simbólica por comando (a tabela vira `<r>`), porque o conjunto NÃO é
 *   conhecível estaticamente. Preserva a ordem criar↔derruba dentro do corpo,
 *   que é o que esta régua cobra, sem inventar uma lista que o SQL não declara.
 *
 * A segunda entrou em 2026-09-19: a migration 0325 trocou o laço de 30 tabelas
 * literais pela varredura, e o controle de vivacidade acusou que o instrumento
 * tinha ficado cego. Outras formas dinâmicas (um `execute` montado por
 * concatenação, por exemplo) continuam fora. CHECK e FOREIGN KEY ficam fora:
 * não constroem índice, e as instâncias medidas validam coluna recriada vazia.
 * Trigger e concessão entraram na régua: gatilho criado e derrubado adiante SEM
 * recriação, e `grant` a `anon`/`public` revogado adiante sem reconceder, voltam
 * a valer entre os dois pontos em todo install/update. Os `execute format(...)`
 * de laço ficam fora — medidos, são drop+create (e as concessões, grant+revoke)
 * na MESMA iteração. Função: régua PRÓPRIA em
 * `baseline-funcao-intermediaria-sem-guarda.test.ts` — a intermediária não pode
 * enfraquecer guarda forte rumo à final (98 intermediárias medidas; 11
 * declaradas; o portão legado do #2196 corrigido).
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

/**
 * `for r in select … from pg_class … loop … format('… policy x_%s_y on public.%I …')`
 * — o laço que varre o CATÁLOGO em vez de uma lista literal.
 *
 * A lista de tabelas NÃO é conhecível estaticamente, e isso é de propósito: a
 * migration 0325 trocou o `foreach … in array[30 nomes]` por esta forma
 * justamente para a proteção alcançar tabela que ainda não existe quando o
 * baseline é escrito. Expandir por tabela aqui seria inventar uma lista que o
 * SQL não declara.
 *
 * O que o parser faz então é emitir UMA ocorrência SIMBÓLICA por comando, com a
 * tabela substituída pela variável do laço (`r`). Isso preserva exatamente o que
 * este arquivo cobra — a ORDEM entre criar e derrubar o MESMO nome dentro do
 * MESMO corpo — sem afirmar nada sobre quais tabelas serão alcançadas em tempo
 * de execução. Duas policies de nomes diferentes no mesmo laço continuam sendo
 * chaves diferentes; a mesma policy criada antes do próprio drop continua sendo
 * um par proibido.
 *
 * O cabeçalho exige `select` para não casar com `for all using (…)` dentro da
 * definição de uma policy, e `\bfor\s` não alcança `foreach` — as duas formas
 * não se sobrepõem.
 */
function policiesEmLacoDeCatalogo(sql: string, verbo: "create" | "drop"): Ocorrencia[] {
  const achadas: Ocorrencia[] = [];
  const laco = /\bfor\s+(\w+)\s+in\s+(?=[\s\S]{0,2000}?\bselect\b)([\s\S]*?)\bloop\b([\s\S]*?)end\s+loop/gi;
  // O `%s` no NOME é opcional, ao contrário da forma de array. Medido no arquivo
  // real: a varredura da 0325 usa `tenant_isolation_%s_all` (nome derivado da
  // tabela), e a das travas de suporte (0274) usa `support_write_insert` — nome
  // LITERAL sobre tabela dinâmica. Exigir `%s`, como a forma de array faz,
  // deixava a segunda invisível: 1 ocorrência vista de 4 existentes.
  const comando =
    verbo === "create"
      ? /create policy\s+((?:[a-z0-9_]|%s)+)\s+on\s+public\.%I/gi
      : /drop policy\s+(?:if exists\s+)?((?:[a-z0-9_]|%s)+)\s+on\s+public\.%I/gi;
  for (const m of sql.matchAll(laco)) {
    const variavel = m[1]!;
    const corpo = m[3]!;
    const inicioDoCorpo = m.index! + m[0].lastIndexOf(corpo);
    for (const f of corpo.matchAll(comando)) {
      const nomeDaPolicy = f[1]!.replaceAll("%s", `<${variavel}>`);
      achadas.push({
        chave: `${nomeDaPolicy} on <catálogo:${variavel}>`,
        nomeProprio: nomeDaPolicy,
        pos: inicioDoCorpo + f.index!,
      });
    }
  }
  return achadas;
}

function criacoesDePolicy(sql: string): Ocorrencia[] {
  return [
    ...ocorrencias(sql, new RegExp(String.raw`create policy\s+` + ALVO_DE_POLICY, "gi"), nomeNaTabela),
    ...policiesEmLaco(sql, "create"),
    ...policiesEmLacoDeCatalogo(sql, "create"),
  ];
}

function paresDePolicy(sql: string): Par[] {
  const criacoes = criacoesDePolicy(sql);
  const drops = [
    ...ocorrencias(sql, new RegExp(String.raw`drop policy\s+(?:if exists\s+)?` + ALVO_DE_POLICY, "gi"), nomeNaTabela),
    ...policiesEmLaco(sql, "drop"),
    ...policiesEmLacoDeCatalogo(sql, "drop"),
  ];
  return pares(sql, drops, criacoes, criacoes);
}

/**
 * Trigger LITERAL — `create trigger <nome> … on <tabela>` e o
 * `drop trigger [if exists] <nome> on <tabela>`. A chave é nome + tabela, como
 * nas policies.
 *
 * O `[\s\S]{0,240}?` cobre o miolo entre o nome e o `on` (`after update of
 * status`, `before insert …`), que não é whitespace.
 *
 * Os `execute format('create trigger …')` de laço ficam fora, e de propósito:
 * medidos, os quatro são `drop`+`create` na MESMA iteração (substituição), que
 * é justamente a forma que esta regra permite.
 */
const ALVO_DE_TRIGGER = String.raw`"?([a-z0-9_]+)"?[\s\S]{0,240}?\son\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?([a-z0-9_]+)"?(?![\w".])`;

function criacoesDeTrigger(sql: string): Ocorrencia[] {
  return ocorrencias(
    sql,
    new RegExp(String.raw`create\s+(?:or\s+replace\s+)?trigger\s+` + ALVO_DE_TRIGGER, "gi"),
    nomeNaTabela,
  );
}

function paresDeTrigger(sql: string): Par[] {
  const criacoes = criacoesDeTrigger(sql);
  const drops = ocorrencias(
    sql,
    new RegExp(String.raw`drop\s+trigger\s+(?:if\s+exists\s+)?` + ALVO_DE_TRIGGER, "gi"),
    nomeNaTabela,
  );
  return pares(sql, drops, criacoes, criacoes);
}

/**
 * Concessão TRANSITÓRIA — `grant` a `anon`/`public` que o PRÓPRIO arquivo
 * revoga adiante, sem reconceder. A cada install/update o papel recupera o
 * privilégio até o revoke; uma atualização que morra no meio deixa o papel com
 * ele (autocommit, como as regras de isolamento do update.sh).
 *
 * A chave é objeto CANÔNICO + papel. O canônico ignora a FORMA do alvo — aspas,
 * o tipo (`table`/`function`) e o schema `public.` —, porque o dump escreve
 * `on table "public"."x"` e o apêndice escreve `on public.x` (ou `on x`): sem
 * isso as duas pontas da MESMA concessão não se encontram (issue #2251).
 *
 * Fora do escopo, de propósito: `alter default privileges` (não é concessão a
 * um objeto) e `execute format('grant …')` de laço (não nomeia objeto).
 * Papéis cobertos: `anon` (chave pública do browser), `public` (todo mundo) e
 * `service_role` — o terceiro entrou na #2258: a janela dele em `api_audit_log`
 * também fica de pé se a passada morrer, e a cerca não a via.
 */
interface ConcessaoTransitoria {
  chave: string;
  linhaDoGrant: number;
  /** O último evento da sequência: revogação aqui = estado final não concede. */
  linhaDoRevoke: number;
  /**
   * O MAIOR par concessão → revogação seguinte. É a janela que a declaração
   * precisa cobrir: um re-grant no meio reabre a janela do segundo em diante, e
   * medir só o primeiro par não veria (issue #2258).
   */
  maiorJanela: { grant: number; revoke: number; distancia: number };
}

function objetoCanonico(bruto: string): string {
  return bruto
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^(?:tables?|functions?|sequences?|schemas?)\s+/, "")
    .replace(/^public\./, "");
}

function concessoesTransitorias(sql: string): ConcessaoTransitoria[] {
  // `--` vira espaço do MESMO comprimento: posição e linha de cada comando não
  // mudam, e um `GRANT` CITADO num comentário deixa de engolir o `revoke` real
  // logo abaixo (issue #2255 — era assim que `ai_budgets` e `api_audit_log`
  // passavam invisíveis).
  const semComentarios = sql.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
  const historico = new Map<string, { tipo: "grant" | "revoke"; linha: number }[]>();
  for (const m of semComentarios.matchAll(/\b(grant|revoke)\b[^;]*;/gi)) {
    const texto = m[0].replace(/\s+/g, " ");
    if (/alter\s+default\s+privileges/i.test(texto)) continue;
    const alvo = /\bon\s+([\s\S]*?)\s+(?:to|from)\s+([\s\S]*)$/i.exec(texto.replace(/;\s*$/, ""));
    if (!alvo) continue;
    const objeto = objetoCanonico(alvo[1]!);
    for (const papel of alvo[2]!.toLowerCase().split(",").map((x) => x.replace(/"/g, "").trim())) {
      if (papel !== "anon" && papel !== "public" && papel !== "service_role") continue;
      const chave = `${objeto} :: ${papel}`;
      historico.set(chave, [
        ...(historico.get(chave) ?? []),
        { tipo: m[1]!.toLowerCase() as "grant" | "revoke", linha: linhaDe(sql, m.index!) },
      ]);
    }
  }
  const achadas: ConcessaoTransitoria[] = [];
  for (const [chave, seq] of historico) {
    const ultimo = seq[seq.length - 1]!;
    if (ultimo.tipo !== "revoke") continue; // estado final concedido: a concessão é real
    const primeiro = seq.find((x) => x.tipo === "grant");
    if (!primeiro) continue;
    let maiorJanela = { grant: primeiro.linha, revoke: ultimo.linha, distancia: -1 };
    for (const g of seq.filter((x) => x.tipo === "grant")) {
      const seguinte = seq.find((x) => x.tipo === "revoke" && x.linha > g.linha);
      if (!seguinte) continue;
      const distancia = seguinte.linha - g.linha;
      if (distancia > maiorJanela.distancia) {
        maiorJanela = { grant: g.linha, revoke: seguinte.linha, distancia };
      }
    }
    if (maiorJanela.distancia < 0) continue;
    achadas.push({ chave, linhaDoGrant: primeiro.linha, linhaDoRevoke: ultimo.linha, maiorJanela });
  }
  return achadas.sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * Concessões transitórias ACEITAS, com o motivo escrito — o mesmo desenho do
 * `DIVERGENCIAS_CONHECIDAS` do manifest. A cerca as VÊ (o caso do arquivo real
 * exige que continuem aparecendo); esta lista é a decisão, não o esquecimento.
 * Resolveu? Remova daqui — a asserção de que as declaradas continuam existindo
 * fica vermelha.
 */
const CONCESSOES_ACEITAS = new Map<string, string>([
  [
    "ai_budgets :: anon",
    "O snapshot concede ALL e o bloco da 0160 + a companheira revogam I/U/D/T (só o serviço escreve " +
      "orçamento; o T saiu na #2258 — não passa pela RLS e nenhum consumidor o usa). Estreitar mais mudaria o " +
      "ACL FINAL: a chave anon fica com SELECT/REFERENCES/TRIGGER, e o SELECT é lido pelo PostgREST; a " +
      "revogação acompanha o grant desde a #2255.",
  ],
  [
    "api_audit_log :: anon",
    "O snapshot concede SELECT/INSERT/REFERENCES/TRIGGER/TRUNCATE e a 0258 revoga U/D/T. O bloco fica no fim " +
      "por ser a fonte do contrato (extraído por rótulo pelo invariante); a companheira ao lado do grant tira " +
      "o TRUNCATE desde já — o único desses que a RLS não alcança (issue #2255).",
  ],
  [
    "api_audit_log :: service_role",
    "O snapshot concede TRUNCATE a service_role e a 0258 revoga U/D/T; a companheira cobre service_role desde " +
      "a #2258 — era a única janela de 20 mil linhas que a cerca não via. O bloco continua a fonte do " +
      "contrato.",
  ],
  [
    "idempotency_keys :: anon",
    "O snapshot concede ALL e o hardening revoga TRUNCATE (que a RLS não alcança). Estreitar a concessão " +
      "mudaria o ACL FINAL " +
      "(REFERENCES/TRIGGER nas duas majors, MAINTAIN no pg17), e o invariante " +
      "organizacoes-recibo-confiavel prova o contrato final com TRUNCATE negado. A revogação passou a " +
      "acompanhar a concessão (issue #2251): a forma fica, com esta justificativa, e a janela some.",
  ],
]);

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

-- trigger criado e derrubado adiante sem recriação: par proibido
create trigger "trg_velho" after update on public.t for each row execute function public.f();
-- trigger com o MESMO nome em outra tabela: a chave é nome + tabela
create trigger trg_mesmo after update on public.t for each row execute function public.f();
create trigger trg_mesmo after update on public.outra for each row execute function public.f();
-- par drop+create: substituição, permitido
drop trigger if exists trg_par on public.t;
create trigger trg_par before update on public.t for each row execute function public.f();
-- criação guardada pela existência do próprio trigger
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_guardado') then
    create trigger trg_guardado after insert on public.t for each row execute function public.f();
  end if;
end $$;

-- concessão a anon revogada adiante: transitória (proibida)
grant all on table public.t2 to anon;
-- revogação antes da concessão: estado final concedido (permitida)
revoke all on table public.t3 from anon;
grant all on table public.t3 to anon;
-- as MESMAS pontas em grafias diferentes: o canônico tem de casar (issue #2251)
grant all on table public.t5 to anon;
grant all on t6 to anon;
-- re-grant no meio: cada concessão tem a SUA janela até a revogação seguinte
grant all on table public.t7 to anon;
revoke all on table public.t7 from anon;
grant all on table public.t7 to anon;

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
drop trigger if exists trg_velho on public.t;
drop trigger if exists trg_mesmo on public.t;
drop trigger if exists trg_guardado on public.t;
revoke all on table public.t2 from anon;
revoke truncate on public.t5 from anon;
revoke all on public.t6 from anon;
revoke truncate on public.t7 from anon;
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

  it("trigger: casa nome E tabela, poupa o par drop+create e classifica a guarda", () => {
    const achados = nomesProibidos(paresDeTrigger(SINTETICO));
    expect(achados).toContain("trg_velho on t");
    expect(achados).not.toContain("trg_par on t");
    expect(achados).toContain("trg_mesmo on t");
    expect(achados).not.toContain("trg_mesmo on outra");
    expect(paresDeTrigger(SINTETICO).find((p) => p.nome === "trg_guardado on t")?.guarda).toBe(
      "existencia",
    );
  });

  it("concessão transitória: casa as grafias, poupa o re-grant e vê a janela do RE-grant", () => {
    const achados = concessoesTransitorias(SINTETICO);
    expect(achados.map((c) => c.chave)).toEqual([
      "t2 :: anon",
      "t5 :: anon",
      "t6 :: anon",
      "t7 :: anon",
    ]);
    expect(achados.every((c) => c.maiorJanela.distancia > 0)).toBe(true);
    // t7: grant → revoke curto → grant → revoke no apêndice. A chave já era
    // detectada pelo último evento; o que o #2258 exige é a MAIOR janela ser a
    // do SEGUNDO grant — olhar só o primeiro par dava distância curta.
    const t7 = achados.find((c) => c.chave === "t7 :: anon")!;
    const primeira = SINTETICO.indexOf("grant all on table public.t7 to anon;");
    const segunda = SINTETICO.indexOf("grant all on table public.t7 to anon;", primeira + 1);
    const linha = (pos: number) => SINTETICO.slice(0, pos).split("\n").length;
    expect(t7.linhaDoGrant).toBe(linha(primeira));
    expect(t7.maiorJanela.grant).toBe(linha(segunda));
  });
});

describe("baseline.sql não reconstrói o que ele mesmo derruba ou substitui", () => {
  it("o instrumento está vivo no arquivo real: acha pares, laços e redefinições", () => {
    expect(paresDeIndice(SQL).length, "nenhum par cria→derruba encontrado — o parser mudou?").toBeGreaterThan(0);
    // ⚠️ ESTE CONTROLE JÁ DISPAROU DE VERDADE, e a história explica o formato de
    // agora. Ele exigia `policiesEmLaco(create) > 10`, contando SÓ a forma
    // `foreach t in array[...]`. A migration 0325 trocou o laço de 30 tabelas
    // literais pela varredura de catálogo de `fn_proteger_tabelas_de_organizacao`
    // — e o número caiu de 34 para ZERO num PR que não introduziu defeito
    // nenhum. O controle fez o que devia: acusou que o instrumento tinha ficado
    // cego para a única forma que passou a existir.
    //
    // A saída NÃO foi baixar o número, que é a cura que satisfaz a catraca pelo
    // motivo errado: o parser aprendeu a forma nova (`policiesEmLacoDeCatalogo`).
    // A soma é que se cobra, porque QUAL das duas formas o arquivo usa é decisão
    // de quem escreve SQL, e trocar uma pela outra não pode reprovar o PR.
    const emLaco = policiesEmLaco(SQL, "create").length + policiesEmLacoDeCatalogo(SQL, "create").length;
    expect(emLaco, "nenhum laço de policy encontrado, nas DUAS formas — o parser mudou?").toBeGreaterThan(0);
    // A LIGAÇÃO, e não só a função: sem ela o caso das policies do arquivo real
    // passa por omissão (foi o que a sabotagem que desligou a expansão mostrou —
    // `policiesEmLaco` sozinha continuava verde). A âncora saiu de uma tabela
    // nomeada (`lead_state`, que vinha do array literal de 30) para a chave
    // simbólica da varredura, porque é ela que existe hoje.
    expect(
      criacoesDePolicy(SQL).map((c) => c.chave),
      "a expansão do laço não chega ao localizador de pares",
    ).toContain("tenant_isolation_<r>_all on <catálogo:r>");
    expect(
      criacoesDeTrigger(SQL).length,
      "nenhum trigger literal encontrado — o parser mudou?",
    ).toBeGreaterThan(0);
    expect(
      SQL,
      "nenhuma concessão a anon/public no arquivo — o parser de concessões ficou cego?",
    ).toMatch(/grant[^;]*\bto\b[^;]*\banon\b/i);
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

  it("nenhum trigger é criado antes do próprio drop", () => {
    expect(
      proibidos(paresDeTrigger(SQL)),
      "Trigger criado e derrubado adiante a cada install/update: entre os dois pontos, o gatilho " +
        "antigo volta a valer. Tire a criação (ou a torne condicional ao mesmo predicado do drop, " +
        "invertido).\n",
    ).toEqual([]);
  });

  it("concessões transitórias: só as declaradas, e nenhuma declarada envelhece", () => {
    const chaves = concessoesTransitorias(SQL).map((c) => c.chave);
    expect(
      [...chaves].sort(),
      "Concessão reaplicada a cada install/update só para ser revogada adiante — conserte ou declare " +
        "com o motivo escrito em CONCESSOES_ACEITAS.\n",
    ).toEqual([...CONCESSOES_ACEITAS.keys()].sort());
    expect(
      [...CONCESSOES_ACEITAS.keys()].filter((k) => !chaves.includes(k)),
      "a concessão declarada sumiu do arquivo: remova de CONCESSOES_ACEITAS",
    ).toEqual([]);
    // Declarar não basta: a declaração só vale com a revogação AO LADO do grant.
    // A régua mede CADA concessão até a revogação seguinte e usa a MAIOR janela —
    // um re-grant no meio reabre a janela, e olhar só o primeiro par não veria
    // (issue #2258). O bloco da 0258 pode continuar no fim (é a fonte do
    // contrato, extraída por rótulo), desde que a companheira esteja colada no
    // grant.
    const largas = concessoesTransitorias(SQL)
      .filter((c) => c.maiorJanela.distancia > 20)
      .map(
        (c) =>
          `${c.chave}: grant ${c.maiorJanela.grant} → revogação ${c.maiorJanela.revoke} (${c.maiorJanela.distancia} linhas)`,
      );
    expect(
      largas,
      "concessão aceita só vale com a revogação ao lado do grant (issues #2251, #2255, #2258)\n",
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

/**
 * UMA MIGRATION NUNCA ENCOLHE UM VOCABULÁRIO — E ESTE É O SEGUNDO ANDAR DA MESMA LIÇÃO.
 *
 * ## O defeito, medido
 *
 * `agent_inbox_items_kind_check` não se altera: ela é DERRUBADA e RECONSTRUÍDA a
 * cada `kind` novo, sete vezes ao longo da cadeia. O contrato implícito é que
 * cada reconstrução repita a lista inteira, e nada verificava isso.
 *
 * A 0129 (`midia_nao_lida`) reconstruiu a constraint a partir de uma lista que
 * era verdade antes da 0111, e **derrubou três kinds**: `promise_unfulfilled`
 * (0111, o aviso do papel Operador), `contact_proposal_expired` (0124) e
 * `other`. Num clone que aplica migrations em ordem — o caminho documentado para
 * quem usa o Supabase CLI —, esses três valores deixam de ser aceitos pelo
 * banco.
 *
 * O modo de falha é o silencioso, que é o que torna isto caro: `insertInboxItem`
 * bate 23514, quem chama captura e emite `log.warn`
 * (`lib/agent-engine/agent/operator-turn.ts`), e a Central simplesmente para de
 * receber aquele aviso. Ninguém vê um erro; alguém deixa de ver um sinal.
 *
 * ## Por que a lição anterior não pegou este caso
 *
 * A issue #159 ensinou que reconstruir a mesma constraint em **N blocos** faz o
 * último bloco vencer e apagar os anteriores. O repo aprendeu isso e vigia o
 * `baseline.sql`, que hoje tem um bloco único e correto — é por isso que o kit
 * self-host nunca perdeu os três kinds.
 *
 * A 0129 aplicou essa lição corretamente (entrou na MESMA constraint, e o
 * comentário dela diz isso com todas as letras) e ainda assim reintroduziu o
 * defeito, porque a lição foi aprendida sobre BLOCOS e o mecanismo é sobre
 * LISTAS: reconstruir com uma lista velha tem exatamente o mesmo efeito de um
 * bloco novo. Pegar um padrão numa ocorrência dá álibi às irmãs que não se
 * parecem por fora.
 *
 * ## O que se guarda, e por que estaticamente
 *
 * A propriedade é **monotonicidade**: percorrendo as migrations em ordem de
 * timestamp, o conjunto de valores de uma constraint só cresce. É enumerável a
 * partir do repositório, então o teste ganha do hábito — a régua do
 * `navegacao-completude`, que achou telas órfãs que três varreduras manuais não
 * acharam.
 *
 * Um teste de banco não substituiria este: `pnpm test:db` aplica o
 * `baseline.sql`, não a cadeia de migrations, e é justamente por aí que o defeito
 * passou. O caminho que quebra é o do clone que atualiza.
 *
 * Remoção deliberada de vocabulário existe (depreciar um termo é legítimo) e tem
 * porta: `REMOCOES_DELIBERADAS`, com justificativa escrita — cobrada por teste,
 * porque allowlist sem razão é a dívida voltando pela porta de serviço.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR_MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

/**
 * Remoções deliberadas de valor, por `<arquivo da migration>::<constraint>`.
 *
 * Vazio hoje, e isso é informação: nenhuma migration da cadeia tirou vocabulário
 * de propósito. Ao acrescentar uma entrada, escreva POR QUE o valor saiu e o que
 * acontece com as linhas que já o usam — remover valor de CHECK sem tratar o
 * dado existente faz o `update.sh` de um clone quebrar no meio.
 */
const REMOCOES_DELIBERADAS: Record<string, { valores: string[]; porque: string }> = {
  "20261124190725_9471_canal_chat_no_site.sql::conversations_channel_check": {
    valores: ["olx"],
    porque:
      "NÃO é remoção de propósito: é o ENCONTRO de duas branches represadas, " +
      "mecanicamente igual à 0312 acima. A 9471 (chat no site, Spec 36) reconstruiu " +
      "`conversations_channel_check` a partir do estado que a `main` enxergava, sem o " +
      "`olx` que a 9422 (#2927) acrescentou no ramo do canal da OLX. Na `main` sozinha " +
      "a 9471 não remove nada; o buraco só existe na árvore em que as duas se " +
      "encontram. A forward-fix é a 9513 " +
      "(`canal_olx_e_chat_no_site_no_vocabulario`), que reafirma a UNIÃO medida: os " +
      "seis canais, com `olx` e `webchat`. O estado FINAL da cadeia tem o valor de " +
      "volta, então nenhum clone fica sem ele — e editar a 9471 é proibido, porque já " +
      "foi aplicada. Coberto pelo teste de banco do vocabulário de canal das conversas.",
  },
  "20260918231000_0312_aviso_de_followup_sem_agente.sql::agent_inbox_items_kind_check": {
    valores: ["aviso_de_caso_nao_entregue"],
    porque:
      "NÃO é remoção de propósito, e NÃO existe na `main`: é o ENCONTRO de duas " +
      "branches represadas. A 0292 (casos vivos) acrescentou `aviso_de_caso_nao_entregue` " +
      "e ficou parada; a 0312 reconstruiu a constraint a partir do estado que ENXERGAVA, " +
      "sem o valor da outra. Nenhum dos dois lados errou — na `main` sozinha a 0312 não " +
      "remove nada, porque a 0292 não está lá, e por isso este gate é verde lá. O buraco " +
      "só existe na árvore em que as duas se encontram. A forward-fix é a 0326 " +
      "(`reconciliacao_das_branches_represadas`), que reafirma a UNIÃO medida: os 28 " +
      "valores da 0312 mais o da 0292. O estado FINAL da cadeia tem o valor de volta, " +
      "então nenhum clone fica sem ele. Mesma forma da 0062→0065 acima, 58 dias depois — " +
      "e a lição nova é que represar branch longa reproduz a classe sem ninguém errar.",
  },
  "20260722160000_0062_conversation_snooze.sql::agent_inbox_items_kind_check": {
    valores: ["followup_dead"],
    porque:
      "A PRIMEIRA instância desta mesma classe, de 2026-07-22: a 0062 reconstruiu a " +
      "constraint com a lista de antes da 0057 e perdeu `followup_dead`. Foi notada e " +
      "reparada um dia depois pela 0065, cujo nome é literalmente " +
      "`reconcile_inbox_kind_check` — o estado FINAL da cadeia tem o valor de volta, " +
      "então nenhum clone atual está quebrado por isto. Fica liberado como registro " +
      "histórico, não como dívida: editar a 0062 é proibido (migration aplicada não se " +
      "edita) e a 0065 já é a forward-fix. Que a classe tenha reincidido 15 dias depois, " +
      "na 0129, é a razão de este teste existir.",
  },
  "20260807180000_0129_midia_nao_lida.sql::agent_inbox_items_kind_check": {
    valores: ["contact_proposal_expired", "other", "promise_unfulfilled"],
    porque:
      "A REINCIDÊNCIA, de 2026-08-07: a 0129 acrescentou `midia_nao_lida` a partir de " +
      "uma lista que era verdade antes da 0111 e derrubou três kinds. Ela aplicou " +
      "corretamente a lição da issue #159 (entrar na MESMA constraint, e o comentário " +
      "dela diz isso com todas as letras) e ainda assim reintroduziu o defeito, porque " +
      "aquela lição era sobre BLOCOS e o mecanismo é sobre LISTAS. Reparada pela 0139 " +
      "(`kind_check_completo`), que restaura os 18 valores canônicos. Liberado aqui só " +
      "porque migration aplicada não se edita: o evento é história, a consequência foi " +
      "consertada.",
  },
};

/** Uma reconstrução de constraint encontrada na cadeia. */
interface Reconstrucao {
  arquivo: string;
  constraint: string;
  coluna: string;
  valores: Set<string>;
}

/**
 * Tira comentário de linha SQL antes de procurar valores.
 *
 * O bloco canônico do `baseline.sql` carrega parágrafos de `--` DENTRO da lista
 * de valores; sem esta limpeza, um valor citado dentro de um comentário entraria
 * na contagem e o teste passaria a medir prosa.
 */
function semComentarios(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => {
      const i = linha.indexOf("--");
      return i === -1 ? linha : linha.slice(0, i);
    })
    .join("\n");
}

/**
 * Acha toda reconstrução da forma `add constraint X check (col in ('a','b'))`.
 *
 * A lista termina no primeiro `)` porque valor de vocabulário não contém
 * parêntese — e se um dia contiver, o parser para de achar a constraint em vez de
 * medir errado, que é a direção segura de falhar.
 */
function reconstrucoesEm(arquivo: string, sql: string): Reconstrucao[] {
  const limpo = semComentarios(sql);
  const achados: Reconstrucao[] = [];
  const re = /add\s+constraint\s+([a-z0-9_]+)\s+check\s*\(\s*([a-z0-9_]+)\s+in\s*\(([^)]*)\)/gi;
  for (const m of limpo.matchAll(re)) {
    // Os `!` são pelo `noUncheckedIndexedAccess` do tsconfig: um grupo que casou
    // sempre tem valor, mas o compilador não sabe disso a partir do regex.
    const valores = new Set([...m[3]!.matchAll(/'([^']*)'/g)].map((v) => v[1]!));
    if (valores.size === 0) continue;
    achados.push({ arquivo, constraint: m[1]!, coluna: m[2]!, valores });
  }
  return achados;
}

function cadeiaDeMigrations(): Reconstrucao[] {
  const arquivos = readdirSync(DIR_MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    // O prefixo é timestamp de largura fixa, então ordem lexicográfica É ordem de
    // aplicação — a mesma que o Supabase CLI usa.
    .sort();
  return arquivos.flatMap((f) =>
    reconstrucoesEm(f, readFileSync(path.join(DIR_MIGRATIONS, f), "utf8")),
  );
}

describe("a cadeia de migrations não encolhe vocabulário de CHECK", () => {
  it("acha as reconstruções que existem — controle positivo do parser", () => {
    const cadeia = cadeiaDeMigrations();
    // Sem esta asserção, um parser quebrado devolveria zero reconstruções e o
    // teste da monotonicidade passaria vazio: verde por não ter medido nada.
    expect(cadeia.length).toBeGreaterThan(5);
    const kinds = cadeia.filter((r) => r.constraint === "agent_inbox_items_kind_check");
    expect(kinds.length).toBeGreaterThan(3);
    // A 0111 é onde `promise_unfulfilled` nasce. Se este valor sumir daqui, o
    // parser ou a cadeia mudaram, e o teste abaixo perdeu o sentido.
    const nasce = kinds.find((r) => r.valores.has("promise_unfulfilled"));
    expect(nasce, "nenhuma migration declara promise_unfulfilled").toBeTruthy();
  });

  it("cada reconstrução repete tudo o que a anterior aceitava", () => {
    const acumulado = new Map<string, Set<string>>();
    const perdas: string[] = [];

    for (const r of cadeiaDeMigrations()) {
      const anterior = acumulado.get(r.constraint);
      if (anterior !== undefined) {
        const liberado = REMOCOES_DELIBERADAS[`${r.arquivo}::${r.constraint}`]?.valores ?? [];
        const sumiram = [...anterior].filter(
          (v) => !r.valores.has(v) && !liberado.includes(v),
        );
        if (sumiram.length > 0) {
          perdas.push(
            `${r.arquivo} reconstrói ${r.constraint} e perde: ${sumiram.sort().join(", ")}`,
          );
        }
      }
      // O acumulado é a UNIÃO, não a última lista: o estado do banco depois de
      // aplicar tudo em ordem é o que a última reconstrução diz, mas o que
      // queremos vigiar é o vocabulário que alguma migration já prometeu aceitar.
      acumulado.set(r.constraint, new Set([...(anterior ?? []), ...r.valores]));
    }

    expect(
      perdas,
      "Reconstruir uma constraint com uma lista velha apaga valores em silêncio — " +
        "o clone que aplica migrations em ordem para de aceitar o que já aceitava, " +
        "e quem grava captura o 23514 e segue. Repita a lista inteira, ou declare a " +
        "remoção em REMOCOES_DELIBERADAS com o porquê.\n",
    ).toEqual([]);
  });

  // A ASSERÇÃO DE ESTADO (a cadeia termina igual ao baseline) VIVE EM OUTRO
  // ARQUIVO, e isso é deliberado.
  //
  // `tests/unit/kind-check-migration-x-baseline.test.ts` — escrito em paralelo a
  // este, na main, para o MESMO defeito da 0129 — já compara a última reconstrução
  // de cada constraint com o bloco canônico do baseline, com controle positivo
  // próprio. Duplicar aqui criaria a terceira lista que este tipo de invariante
  // existe para matar.
  //
  // A divisão: lá se mede a CONSEQUÊNCIA (um clone está quebrado agora); aqui se
  // mede o EVENTO (alguém encolheu, mesmo que outra migration repare depois). O
  // evento importa sozinho no caso em que autor encolhe a migration E o baseline
  // na mesma mudança: o estado bate, os dois estão errados, e só a monotonicidade
  // contra o histórico da cadeia percebe.

  it("toda remoção liberada tem justificativa escrita", () => {
    for (const [chave, entrada] of Object.entries(REMOCOES_DELIBERADAS)) {
      expect(entrada.valores.length, `${chave} libera nada`).toBeGreaterThan(0);
      expect(
        entrada.porque.trim().length,
        `${chave} não diz por que o valor saiu`,
      ).toBeGreaterThan(30);
    }
  });
});

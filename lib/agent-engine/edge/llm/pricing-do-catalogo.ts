/**
 * O PREÇO DO MODELO QUE A TABELA ESTÁTICA NÃO CONHECE VEM DO CATÁLOGO DA INSTALAÇÃO.
 *
 * ═══ O defeito medido (issue #3013) ════════════════════════════════════════════
 *
 * Provedor PERSONALIZADO apontando para o Groq (`https://api.groq.com/openai/v1`),
 * modelo `openai/gpt-oss-120b` no propósito `checkpoint`. Medição de 12/10 a
 * 16/10 numa instalação real: 180 chamadas `custom` + `openai/gpt-oss-120b` e 256
 * `custom` + `openai/gpt-oss-20b`, TODAS com `llm_calls.cost_cents` nulo —
 * enquanto as do Haiku 5.5 do mesmo turno gravavam custo.
 *
 * A causa: `pricing.ts` casa o id contra `USD_PER_MTOK`, e a tabela estática do
 * motor não tem nenhum `gpt-oss` (grep = 0). O `null` que sai daí é o contrato
 * antigo ("modelo fora da tabela → custo desconhecido"), mas ele era MUDO: a
 * tela de Uso e o teto mensal somam `coalesce(cost_cents, 0)`, então a chamada
 * paga não aparecia em lugar nenhum e quem opera não tinha como saber que o
 * gasto estava incompleto.
 *
 * ═══ Por que o banco, e não mais duas linhas na tabela ════════════════════════
 *
 * O provedor personalizado serve QUALQUER modelo, de QUALQUER fabricante, com
 * QUALQUER preço — o endereço é do operador. Escrever o preço do gpt-oss em
 * `pricing.ts` resolveria um id e deixaria o defeito inteiro para o próximo:
 * seria o mesmo erro que o cabeçalho de `pricing.ts` já descreve três vezes (a
 * tabela estática ficou na geração 4 enquanto o catálogo andou).
 *
 * E o preço JÁ EXISTE no banco de quem instalou: `ai_pricing` tem a linha
 * `openai/gpt-oss-120b` (15/60 centavos por milhão, medido pelo dono na issue) e
 * `ai_models` — a tabela que a tela de Provedores mostra e que o cron diário
 * `sync-model-catalog` preenche com o preço publicado pelo agregador — é a
 * origem dela (o backfill 0113 deriva uma da outra). Era só esse preço que o
 * seam não consultava.
 *
 * Não é caminho novo: `lib/ai/cost.ts` (`computeCost`) e `lib/ai/runtime/cost.ts`
 * (`computeCostCents`) JÁ resolvem custo por essas duas tabelas. O seam era o
 * único resolvedor parado na tabela estática — e é por isso que só ele gravava
 * nulo com um id desses.
 *
 * ═══ O que este módulo NÃO faz ════════════════════════════════════════════════
 *
 *  · NÃO inventa preço. O número sai da linha que a instalação tem; id que não
 *    está em tabela nenhuma continua sem preço.
 *  · NÃO arredonda. Centavo fracionado, como `costCents` e as colunas `numeric`
 *    de `llm_calls` — arredondar para cima foi defeito medido neste repo (uma
 *    classificação de ~0,01¢ virava 1¢, 100× o real).
 *  · NÃO é silencioso. Sem preço em lugar nenhum, o custo continua `null` MAS
 *    passa a sair aviso no log, uma vez por (provedor, modelo): o nulo explícito
 *    do contrato, e não o nulo calado que a issue mediu.
 *  · NÃO derruba o turno. Leitura que falha devolve `null` (o estado de antes
 *    desta frente) — nunca um preço inventado, nunca uma exceção no meio da
 *    chamada já paga.
 */

import type pg from "pg";

import type { Logger } from "../../obs/logger";
import type { TokenUsage } from "./pricing";

/** O mínimo que este módulo precisa do pool — o seam passa o `pg.Pool` inteiro. */
export type DbDePreco = Pick<pg.Pool, "query">;

/** Uma linha de preço achada no banco, já em CENTAVOS por milhão de tokens. */
export interface PrecoDaInstalacao {
  entradaCentsPorMilhao: number;
  saidaCentsPorMilhao: number;
  /**
   * De qual das duas tabelas a linha veio. Vai para o log da chamada: preço do
   * catálogo é preço que o operador vê na tela de Provedores, e é isso que
   * permite auditar de onde saiu o número gravado.
   */
  origem: "catalogo" | "tabela_de_preco";
}

/** TTL do memo — o mesmo dos irmãos (`lib/ai/cost.ts`, `lib/ai/runtime/cost.ts`). */
const TTL_MS = 5 * 60_000;

interface Guardado {
  lidoEm: number;
  preco: PrecoDaInstalacao | null;
}

/**
 * Memo por (provedor, modelo): sem ele, o id desconhecido pagaria uma ida ao
 * banco em TODO turno — e o ausente é memoizado também, que é o caso do modelo
 * que não tem preço em tabela nenhuma.
 */
const memo = new Map<string, Guardado>();

/**
 * Uma linha por (provedor, modelo) já avisada. `null` de custo passa a ser
 * VISÍVEL; sem esta dedup, um turno de 40 chamadas viraria 40 linhas iguais e o
 * aviso que importa se perderia no meio.
 */
const avisados = new Set<string>();

/** Só para teste — zera o memo e a dedup dos avisos. */
export function _esquecerPrecosDoCatalogoParaTestes(): void {
  memo.clear();
  avisados.clear();
}

/**
 * As formas do id que o banco pode ter: o id completo, sem o sufixo de data do
 * vendor (`-20250805`, `-2024-08-06`) e o recorte sem o prefixo `provider/`
 * (formato de roteador) — as MESMAS três tolerâncias de `chaveDoModelo`
 * (`pricing.ts`), na mesma ordem: id exato primeiro, generalização depois.
 *
 * Nenhuma delas é heurística de nome: são as formas que o próprio repo já
 * tolera no outro lado da mesma conta.
 *
 * No FIM vêm as variantes com o PONTO trocado por hífen: o catálogo do OpenRouter
 * publica `anthropic/claude-haiku-5.5` e a linha da instalação fica gravada como
 * `claude-haiku-5-5`. Anexadas por último para o id exato (e as formas de hoje)
 * continuarem vencendo (issue #1931).
 */
export function candidatosDeId(model: string): string[] {
  const semPrefixo = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const semData = (id: string) => id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const comHifen = (id: string) => id.replace(/\./g, "-");
  return [
    ...new Set([
      model,
      semData(model),
      semPrefixo,
      semData(semPrefixo),
      comHifen(semPrefixo),
      semData(comHifen(semPrefixo)),
      comHifen(model),
    ]),
  ].filter((id) => id !== "");
}

/**
 * O preço, em uma ida ao banco: `ai_models` (o catálogo que a tela mostra, o que
 * o cron diário reescreve) e `ai_pricing` (a tabela do orçamento, derivada do
 * catálogo pelo backfill 0113) para TODOS os candidatos de uma vez.
 *
 * `ordinality` guarda a posição do candidato: quem decide é a ORDEM de
 * `candidatosDeId`, em JS — o id exato vence a forma sem prefixo, que vence a
 * sem data. Assim o "match exato primeiro" fica no código testável, e não
 * escondido num `order by` de SQL.
 *
 * O CTE tem nome (`candidatos_de_preco`) porque os dublês de `pg.Pool` da suíte
 * identificam a consulta por trecho de SQL — trocar a consulta tem de quebrar
 * alto, e não devolver `undefined` em silêncio.
 */
const SQL = `
with candidatos_de_preco as (
  select id, ordem
    from unnest($1::text[]) with ordinality as c(id, ordem)
)
select c.id                                     as id,
       c.ordem::int                             as ordem,
       m.provider                               as provider,
       m.input_price_per_million_cents          as entrada,
       m.output_price_per_million_cents         as saida,
       'catalogo'                               as origem
  from candidatos_de_preco c
  join public.ai_models m
    on m.model_id = c.id
   and m.deprecated_at is null
union all
select c.id,
       c.ordem::int,
       null,
       p.prompt_cents_per_million_tokens,
       p.completion_cents_per_million_tokens,
       'tabela_de_preco'
  from candidatos_de_preco c
  join public.ai_pricing p
    on p.model = c.id
   and p.superseded_at is null
`;

interface LinhaDePrecoDoBanco {
  id: string;
  ordem: number;
  provider: string | null;
  entrada: string | number | null;
  saida: string | number | null;
  origem: string;
}

function numero(valor: string | number | null): number {
  if (valor === null || valor === undefined) return 0;
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Qual linha do banco vale para este id. PURA e exportada: é aqui que mora a
 * decisão (ordem dos candidatos, catálogo × tabela, empate de provedor), e é o
 * que o teste precisa poder exercitar sem banco.
 *
 * - `null` quando NENHUMA linha do banco tem o id — preço desconhecido de
 *   verdade, o único caso em que o custo pode continuar nulo;
 * - `null` também quando o banco CONHECE o id mas deixa as duas taxas nulas
 *   (linha aberta por um agregador que não publicou o preço): conhecer o modelo
 *   e não saber o preço não é melhor que não o conhecer, e devolver zero aqui
 *   seria declarar "de graça" — o oposto do que a issue pede.
 * - `0/0` devolve zero: é grátis DE VERDADE (o tradutor da OpenRouter grava 0 de
 *   propósito no degrau gratuito, `precoParaCentavosPorMilhao`). É a mesma
 *   doutrina de `lib/ai/runtime/cost.ts`.
 */
export function escolherPrecoDaLinha(
  linhas: readonly LinhaDePrecoDoBanco[],
  candidatos: readonly string[],
  provider: string,
): PrecoDaInstalacao | null {
  for (const id of candidatos) {
    const doId = linhas.filter((l) => l.id === id);
    if (doId.length === 0) continue;

    // O catálogo é a linha VIVA (o cron diário a reescreve com o preço publicado
    // hoje); `ai_pricing` é a cópia derivada dele. Havendo as duas, a viva manda.
    const doCatalogo = doId.filter((l) => l.origem === "catalogo");
    const candidatas = doCatalogo.length > 0 ? doCatalogo : doId;

    const comPreco = candidatas.filter((l) => l.entrada !== null || l.saida !== null);
    if (comPreco.length === 0) return null;

    // O MESMO id pode estar em mais de um provedor do catálogo (OpenRouter e
    // Requesty servem `openai/gpt-oss-120b` com preços próprios) — limite de
    // esquema que a migration 0410 já documenta. O provedor DA CHAMADA desempata
    // quando está lá; sem ele, ordem de nome: determinístico, para o mesmo id
    // nunca cobrar dois preços diferentes entre dois turnos.
    const escolhida =
      comPreco.find((l) => l.provider === provider) ??
      [...comPreco].sort((a, b) => (a.provider ?? "").localeCompare(b.provider ?? ""))[0]!;

    return {
      entradaCentsPorMilhao: numero(escolhida.entrada),
      saidaCentsPorMilhao: numero(escolhida.saida),
      origem: escolhida.origem === "catalogo" ? "catalogo" : "tabela_de_preco",
    };
  }
  return null;
}

/** A leitura do banco falhou — distinto de "o banco não tem preço". */
const FALHOU = Symbol("leitura_do_preco_falhou");

async function lerPreco(
  db: DbDePreco,
  model: string,
  provider: string,
  agora: number,
  log?: Logger,
): Promise<PrecoDaInstalacao | null | typeof FALHOU> {
  const chave = `${provider}|${model}`;
  const guardado = memo.get(chave);
  if (guardado !== undefined && agora - guardado.lidoEm < TTL_MS) return guardado.preco;

  try {
    const candidatos = candidatosDeId(model);
    // Só `$1`: o provedor desempata em JS (`escolherPrecoDaLinha`). Um segundo
    // parâmetro sem `$2` no SQL é recusado pelo Postgres ("bind message supplies
    // 2 parameters, but prepared statement requires 1") — medido na triagem do
    // #3034, onde isso fazia TODA leitura cair no `catch` com os testes de dublê
    // verdes. Guardado por `tests/invariants/custo-do-catalogo-no-postgres-de-verdade.test.ts`.
    const { rows } = await db.query<LinhaDePrecoDoBanco>(SQL, [candidatos]);
    const preco = escolherPrecoDaLinha(rows ?? [], candidatos, provider);
    memo.set(chave, { lidoEm: agora, preco });
    return preco;
  } catch (erro) {
    // Catálogo fora do ar NÃO pode derrubar uma chamada já paga: o custo volta a
    // ser desconhecido, que é exatamente o estado de antes desta frente. Mas a
    // falha é DITA (e não memoizada): calada, ela se passaria por "sem preço".
    log?.warn("llm: leitura do preço do catálogo falhou — a chamada grava custo nulo", {
      provider,
      model,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return FALHOU;
  }
}

/**
 * O preço da instalação para um id que a tabela estática do motor não conhece.
 * Memoizado por (provedor, modelo); leitura que falha devolve `null`.
 */
export async function precoDaInstalacao(
  db: DbDePreco,
  model: string,
  provider: string,
  agora = Date.now(),
): Promise<PrecoDaInstalacao | null> {
  const preco = await lerPreco(db, model, provider, agora);
  return preco === FALHOU ? null : preco;
}

/**
 * O custo em centavos (fracionário) pela tarifa que a instalação cadastrou.
 *
 * As duas tabelas do banco declaram SÓ entrada e saída — não existe coluna de
 * tarifa de cache. Os tokens de cache (quando o provedor reporta) entram pela
 * tarifa de ENTRADA: é o que a linha declara sobre eles. Supor 0.1× na leitura
 * seria inventar um desconto que ninguém cadastrou, e a diferença é justamente a
 * que o teto de orçamento sente.
 */
export function custoComPrecoDaInstalacao(preco: PrecoDaInstalacao, usage: TokenUsage): number {
  return (
    (usage.inputTokens * preco.entradaCentsPorMilhao +
      usage.outputTokens * preco.saidaCentsPorMilhao) /
    1_000_000
  );
}

/**
 * O QUE O SEAM CHAMA quando `costCents` devolveu `null`: custo em centavos pela
 * linha que a instalação tem, ou `null` com aviso no log quando não há preço em
 * lugar nenhum.
 *
 * O aviso é a metade "explícita" do contrato da issue: custo nulo por preço
 * desconhecido é legítimo — custo nulo CALADO, não.
 */
export async function custoDoModeloForaDoMotor(
  db: DbDePreco,
  input: { model: string; provider: string; usage: TokenUsage; log?: Logger; agora?: number },
): Promise<number | null> {
  const preco = await lerPreco(
    db,
    input.model,
    input.provider,
    input.agora ?? Date.now(),
    input.log,
  );
  if (preco === FALHOU) return null;
  if (preco === null) {
    const chave = `${input.provider}|${input.model}`;
    if (!avisados.has(chave)) {
      avisados.add(chave);
      input.log?.warn(
        "llm: modelo sem preço no motor nem no catálogo — a chamada grava custo nulo",
        {
          provider: input.provider,
          model: input.model,
        },
      );
    }
    return null;
  }
  return custoComPrecoDaInstalacao(preco, input.usage);
}

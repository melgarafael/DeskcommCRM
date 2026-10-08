/**
 * O TETO DE ORÇAMENTO QUE VINCULA — a decisão, sem I/O.
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE ═══
 *
 * A tela editava `ai_budgets.monthly_limit_cents` e o enforcement lia
 * `organizations.settings.llm.monthly_budget_cents`. Dois campos, duas fontes,
 * nenhuma ligação: quem preenchia a tela acreditava estar protegido e não
 * estava. Ligar um no outro, sozinho, estrangularia todo mundo — a coluna nasce
 * com `DEFAULT 5000` (`supabase/baseline.sql:1053`), o que torna "escolhi US$ 50"
 * indistinguível de "nunca abri a tela".
 *
 * A saída não é adivinhar a intenção a partir do valor herdado: é tornar o valor
 * INERTE até um admin declarar a intenção, num campo que só existe para isso
 * (`ai_budgets.enforcement_mode`, cujo default é `'off'`).
 *
 * ═══ A DECISÃO MORA AQUI, PURA ═══
 *
 * `decidirOrcamento` recebe o estado e devolve o veredito. Zero banco, zero
 * rede, zero relógio implícito (`agora` é argumento). É o único lugar onde a
 * pergunta "esta chamada de LLM pode sair?" é respondida — o chamador
 * (`run-model-call.ts`) executa o veredito, não o recalcula.
 *
 * ⚠️ TODA CONDIÇÃO AMBÍGUA RESOLVE PARA "NÃO BLOQUEIA". Errar frouxo custa
 * dinheiro de provedor, é visível na tela de Uso e é recuperável; errar duro
 * mata o WhatsApp de um negócio numa VPS onde não há para quem ligar, e a
 * descoberta vem pelo cliente dele. Os custos não são simétricos, e a ordem das
 * recusas abaixo é essa assimetria escrita.
 */

import type pg from 'pg';

import type { RecursoDoPlano } from '@/lib/cobranca/vocabulario';

import type { OrigemDaChaveLlm } from './credentials';

/**
 * Piso do teto: US$ 1,00/mês. Abaixo disto o número não é orçamento de um agente
 * de WhatsApp, é erro de unidade — e um erro de unidade não pode calar a IA.
 */
export const PISO_DE_TETO_CENTS = 100;

/**
 * Chamadas que o teto NUNCA bloqueia — o custo delas continua somando no gasto
 * (excluí-las da soma faria o número mentir), mas a recusa não as alcança:
 *
 * - `connection_test` (`lib/agent-engine/edge/llm/test-model.ts:31`) é o único
 *   diagnóstico de quem está no escuro; bloqueá-lo tira a lanterna de quem está
 *   justamente tentando entender por que a IA parou.
 * - `jailbreak_detect` (`lib/agent-engine/guardrails/jailbreak/classifier.ts:114`)
 *   e `promise_semantic` (`lib/agent-engine/guardrails/promise/semantic.ts:113`)
 *   são guardrails. Estouro de orçamento não pode virar desligamento de
 *   proteção. (NÃO MEDIDO se algum chamador desses dois trata a exceção como
 *   "sem veto" — a isenção mata a pergunta em vez de deixá-la aberta.)
 */
export const PURPOSES_ISENTOS = [
  'connection_test',
  'jailbreak_detect',
  'promise_semantic',
] as const;

/** `ai_budgets.enforcement_mode`. Nasce `'off'` por DEFAULT do ALTER. */
export type ModoDeOrcamento = 'off' | 'avisar' | 'bloquear';

/**
 * A CÓPIA DOS DOIS ITENS DA CENTRAL mora aqui, e não no emissor, porque há DOIS
 * emissores: o statement do engine (`SQL_ORCAMENTO`, que recebe título e corpo
 * do aviso por parâmetro) e o guard do caminho legado
 * (`workers/ai-response-worker.ts`). Duas cópias do mesmo texto viram dois
 * textos, e o usuário lê os dois na mesma tela sem saber que são a mesma coisa.
 *
 * `warn` vs `critical` é deliberado: o aviso diz que o gasto passou do ponto que
 * a pessoa escolheu e a IA CONTINUA respondendo; a parada diz que algo parou.
 */
export const AVISO_TITULO = 'O gasto de IA passou do aviso que você definiu';
export const AVISO_CORPO =
  'A IA continua respondendo normalmente — isto é o aviso, não a parada. ' +
  'Veja quanto já foi gasto e ajuste o limite em Uso de IA › Orçamento.';
export const BLOQUEIO_TITULO = 'O limite de gasto com IA foi atingido';

/**
 * Razão gravada em `conversations.last_handoff_reason` quando o teto de gasto
 * interrompe o atendimento. Constante exportada porque quem for procurar "por
 * que esta conversa foi parar na fila humana" busca por este valor no banco.
 *
 * ⚠️ MORA AQUI, e não no emissor, pela MESMA razão dos textos acima: há DOIS
 * caminhos que devolvem a conversa ao humano por orçamento — a escolta do engine
 * (`lib/agent-engine/agent/inbound-turn.ts`) e o guard do caminho legado
 * (`workers/ai-response-worker.ts`, que não pode importar o engine sem arrastar
 * `pg` e o SDK para o bundle do Next). Dois literais seriam duas razões no banco
 * para o mesmo fato, e quem filtrasse por uma acharia metade das conversas.
 */
export const HANDOFF_REASON_ORCAMENTO = 'orcamento_de_ia';

/** Escreve dólar, porque o número É dólar (`pricing.ts` calcula em USD). */
function emDolares(cents: number): string {
  return `US$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * ⚠️ ESTE TEXTO JÁ MENTIU UMA VEZ, e a mentira era exatamente do tipo que este
 * trabalho existe para matar. Ele dizia "as respostas automáticas estão
 * suspensas até você aumentar o limite, desligar a parada, ou o mês virar" —
 * descrevendo uma recuperação AUTOMÁTICA que não acontece. Quem para o turno
 * chama `performHumanHandoff` (engine) ou `triggerHandoff` (caminho legado), e
 * os dois gravam `contacts.force_human = true` + `conversations.bot_silenced_until
 * = 'infinity'`. O ÚNICO escritor de `force_human = false` em todo o repositório
 * é `lib/escalacao/retomada.ts`, acionado por um botão POR CONVERSA. Subir o
 * teto evita paradas NOVAS; ele não devolve a IA a nenhuma conversa já parada.
 */
export function corpoDoBloqueio(gastoCents: number, tetoCents: number): string {
  const pct = tetoCents > 0 ? Math.round((gastoCents / tetoCents) * 100) : 0;
  return (
    `O gasto de IA deste mês chegou a ${emDolares(gastoCents)} de um limite de ${emDolares(tetoCents)} (${pct}%), ` +
    'e você escolheu que a IA parasse ao chegar nele. ' +
    'As conversas que estavam sendo atendidas foram para a FILA DE ATENDIMENTO HUMANO — ' +
    'ninguém ficou sem próximo passo, mas alguém precisa responder. ' +
    'Aumentar o limite ou desligar a parada em Uso de IA › Orçamento evita paradas NOVAS; ' +
    'cada conversa já parada volta ao automático pelo botão "Devolver ao automático" ' +
    'no cabeçalho dela.'
  );
}

/**
 * Fallback do `alarm_threshold_pct` quando a coluna volta nula — o que só
 * acontece se a organização não tem linha em `ai_budgets`, porque a coluna é
 * `not null default 80` (`supabase/baseline.sql:1055`). Existe como constante
 * nomeada, e não como `?? 80` solto, para que o dia em que o DEFAULT do banco
 * mudar haja UM lugar a conferir.
 */
export const LIMIAR_PADRAO_PCT = 80;

/**
 * Valor efetivo de `AI_BUDGET_ENFORCEMENT`, já normalizado. A chave só sabe
 * AFROUXAR: `'off'` cala tudo, `'avisar'` rebaixa qualquer `bloquear`, `'on'`
 * apenas respeita o que cada organização escolheu — `on` não liga nada.
 */
export type ChaveDeOrcamento = 'on' | 'avisar' | 'off';

/** Por que a chamada seguiu. É enum porque o log e o teste comparam este valor. */
export type RazaoDeSeguir =
  /** `enforcement_mode = 'off'`: a organização nunca ligou a proteção. */
  | 'modo_desligado'
  /** `AI_BUDGET_ENFORCEMENT=off`: kill switch do operador da instalação. */
  | 'chave_de_emergencia'
  /** `purpose` em `PURPOSES_ISENTOS`. */
  | 'purpose_isento'
  /** Teto ≤ 0 — "sem limite", nunca "bloqueia tudo". */
  | 'sem_teto'
  /** Teto abaixo de `PISO_DE_TETO_CENTS`: baixo demais para ser honrado. */
  | 'teto_abaixo_do_piso'
  /** Gasto ainda abaixo do limiar de alarme. O caminho normal. */
  | 'abaixo_do_limiar';

export interface EntradaDeOrcamento {
  /** `ai_budgets.enforcement_mode`. Linha ausente ⇒ o chamador resolve `'off'`. */
  modo: ModoDeOrcamento;
  /** `ai_budgets.monthly_limit_cents` — centavo de DÓLAR (ver `pricing.ts`). */
  tetoCents: number;
  /** Gasto do mês corrente, na régua única `fn_gasto_de_ia_do_mes`. */
  gastoCents: number;
  /** `ai_budgets.enforcement_effective_at`. `null` = carência sem prazo ⇒ nunca bloqueia. */
  efetivoEm: Date | null;
  /** Injetado, nunca `new Date()` aqui dentro: dois relógios no teste é um bug. */
  agora: Date;
  /** `RunModelCallInput.purpose` já resolvido pelo seam. */
  purpose: string;
  /** `AI_BUDGET_ENFORCEMENT` normalizado por `normalizarChaveDeOrcamento`. */
  chave: ChaveDeOrcamento;
  /**
   * `ai_budgets.alarm_threshold_pct` — percentual do teto em que o aviso abre.
   * O banco restringe a 50..99 (`ai_budgets_alarm_threshold_pct_check`).
   */
  limiarPct: number;
  /**
   * Já houve `agent_inbox_items` kind `budget_warning` NESTE MÊS. É `created_at`
   * no mês, não `status = 'open'`: fechar o aviso à mão não pode virar bypass
   * permanente do bloqueio.
   */
  avisadoNesteMes: boolean;
}

export type Veredito =
  | { acao: 'seguir'; porque: RazaoDeSeguir }
  | { acao: 'avisar_e_seguir'; porque: 'primeiro_cruzamento' | 'limiar' }
  | { acao: 'bloquear'; porque: 'teto_atingido' };

function ehPurposeIsento(purpose: string): boolean {
  return (PURPOSES_ISENTOS as readonly string[]).includes(purpose);
}

/**
 * As SEIS condições conjuntivas do bloqueio — todas precisam valer, e qualquer
 * uma sozinha basta para a chamada seguir:
 *
 *   1. `modo === 'bloquear'`
 *   2. `efetivoEm !== null && efetivoEm <= agora`   (a carência venceu)
 *   3. `tetoCents >= PISO_DE_TETO_CENTS`
 *   4. a chave de emergência não afrouxa
 *   5. `purpose` fora de `PURPOSES_ISENTOS`
 *   6. já houve aviso neste mês
 *
 * ...e só então o gatilho: `gastoCents >= tetoCents`.
 *
 * ⚠️ A CONDIÇÃO 6 É O QUE IMPEDE "CALOU SEM NUNCA TER AVISADO" — mesmo no salto
 * de 79% para 101% entre duas chamadas, a primeira que cruza o teto avisa e
 * segue. Custo máximo: uma chamada além do teto.
 *
 * ⚠️ TETO 0 SEGUE, SEMPRE. Hoje `0` significa "sem limite" na tela
 * (`components/ai/BudgetCard.tsx:192`, verbatim: "0 desativa o orçamento (sem
 * limite, sem alertas)") e "bloqueia tudo" no enforcement — o teste vivo é
 * `spent < budgetCents` (`lib/agent-engine/edge/llm/run-model-call.ts:127`), e
 * com teto 0 ele é falso já com gasto zero. É assim que `scripts/smoke-llm.ts:168`
 * prova o bloqueio: gravando `'0'`. A inversão perfeita — quem recusou o
 * orçamento de propósito levando o corte mais duro — morre aqui por construção.
 */
export function decidirOrcamento(entrada: EntradaDeOrcamento): Veredito {
  // (1) Retorno mais cedo de todos. Para 100% das organizações no dia 1 o modo é
  // 'off', e o chamador nem chega a consultar o gasto: menos trabalho que hoje.
  if (entrada.modo === 'off') {
    return { acao: 'seguir', porque: 'modo_desligado' };
  }

  // (2) Kill switch do operador da VPS às 2h da manhã: põe `off`, reinicia, a IA
  // volta — sem psql, sem saber SQL.
  if (entrada.chave === 'off') {
    return { acao: 'seguir', porque: 'chave_de_emergencia' };
  }

  // (3) Diagnóstico e guardrail nunca são recusados por gasto.
  if (ehPurposeIsento(entrada.purpose)) {
    return { acao: 'seguir', porque: 'purpose_isento' };
  }

  // (4) e (5) — teto sem valor útil não vincula ninguém.
  if (entrada.tetoCents <= 0) {
    return { acao: 'seguir', porque: 'sem_teto' };
  }
  if (entrada.tetoCents < PISO_DE_TETO_CENTS) {
    return { acao: 'seguir', porque: 'teto_abaixo_do_piso' };
  }

  const limiarCents = (entrada.tetoCents * entrada.limiarPct) / 100;
  if (entrada.gastoCents < limiarCents) {
    return { acao: 'seguir', porque: 'abaixo_do_limiar' };
  }
  if (entrada.gastoCents < entrada.tetoCents) {
    return { acao: 'avisar_e_seguir', porque: 'limiar' };
  }

  // Daqui para baixo o gasto JÁ atingiu o teto. Cada recusa restante troca o
  // bloqueio por aviso — nenhuma delas volta a 'seguir', porque a partir do teto
  // o silêncio é que seria a resposta errada.

  // Modo 'avisar' é o degrau do meio da escada: acompanha e avisa, nunca para.
  if (entrada.modo !== 'bloquear') {
    return { acao: 'avisar_e_seguir', porque: 'limiar' };
  }

  // A chave só sabe afrouxar: 'avisar' rebaixa qualquer 'bloquear'.
  if (entrada.chave === 'avisar') {
    return { acao: 'avisar_e_seguir', porque: 'limiar' };
  }

  // (6) Carência. `null` nasce da coluna nova e nunca vence — `null <= now()` é
  // `null` no banco, e aqui é uma recusa explícita, não um `undefined` de sorte.
  if (entrada.efetivoEm === null || entrada.agora.getTime() < entrada.efetivoEm.getTime()) {
    return { acao: 'avisar_e_seguir', porque: 'limiar' };
  }

  // (7) Ninguém é bloqueado sem ter sido avisado.
  if (!entrada.avisadoNesteMes) {
    return { acao: 'avisar_e_seguir', porque: 'primeiro_cruzamento' };
  }

  return { acao: 'bloquear', porque: 'teto_atingido' };
}

/**
 * Grafias que o operador escreve quando quer desligar. Case-insensitive e com
 * trim; `'não'` entra junto com `'nao'` porque o `.toLowerCase()` preserva o til.
 */
const GRAFIAS_DE_DESLIGADO = new Set([
  'off',
  'false',
  '0',
  'no',
  'nao',
  'não',
  'disabled',
]);

/**
 * `AI_BUDGET_ENFORCEMENT` cru → valor efetivo. QUALQUER outra coisa, inclusive
 * vazio e lixo, vira `'on'`.
 *
 * ⚠️ POR QUE A NORMALIZAÇÃO MORA AQUI E NÃO NUM `z.enum` DO `lib/env.ts`: aquele
 * arquivo faz `safeParse` (`:204`) e LANÇA quando o schema recusa (`:223`). Um
 * `z.enum` para o kill switch transformaria a alavanca de emergência num
 * derrubador do app inteiro no dia em que o operador escrevesse `false` — o
 * idioma do vizinho `AGENT_DISPATCH_CONSUMER`. (O outro exemplo citado aqui era
 * `EVENT_LOG_WORKER_ENABLED`, removido em 2026-08-25 por nunca ter tido
 * leitor.) O precedente correto no mesmo arquivo é
 * `APP_ACCENT_HEX: z.string().optional().default("")` (`:201`): string crua no
 * env, normalização no código.
 */
export function normalizarChaveDeOrcamento(v: string | undefined): ChaveDeOrcamento {
  const bruto = (v ?? '').trim().toLowerCase();
  if (GRAFIAS_DE_DESLIGADO.has(bruto)) return 'off';
  if (bruto === 'avisar' || bruto === 'warn') return 'avisar';
  return 'on';
}

/**
 * `ai_budgets.enforcement_mode` cru (vindo do banco) → o tipo do domínio.
 * QUALQUER coisa fora dos três valores — inclusive `null`, que é o que o
 * `left join` devolve para organização SEM linha em `ai_budgets` — vira `'off'`.
 *
 * ⚠️ É a irmã de `normalizarChaveDeOrcamento`, e as duas moram juntas de
 * propósito: são os dois pontos por onde um valor de fora entra na decisão, e
 * as duas resolvem o desconhecido para o lado que NÃO bloqueia. O CHECK
 * `ai_budgets_enforcement_mode_check` (migration 0159) já barra lixo na
 * escrita; isto é a segunda camada, para o caso do clone cujo `update.sh`
 * engoliu o erro do CHECK e deixou a coluna sem validação — o `update.sh` roda
 * **sem** `ON_ERROR_STOP`, então esse caso não é hipotético.
 */
export function normalizarModoDeOrcamento(v: string | null | undefined): ModoDeOrcamento {
  if (v === 'avisar' || v === 'bloquear') return v;
  return 'off';
}

/**
 * O statement ÚNICO do gate: lê o estado, retrata alerta obsoleto e abre o aviso
 * do limiar — uma ida ao banco.
 *
 * É constante exportada, e não SQL inline, porque o invariante de banco precisa
 * executar ESTE texto contra um Postgres real. Reimplementá-lo no teste mediria
 * a cópia, e a cópia continuaria certa com o original sabotado.
 *
 * Parâmetros: `$1` organization_id, `$2` título do aviso, `$3` corpo do aviso.
 *
 * Sem linha em `ai_budgets` a CTE `orc` é vazia, `modo` volta `null`, e o
 * chamador resolve para `'off'`. Nulo é sempre a resposta mais frouxa.
 */
export const SQL_ORCAMENTO = `
with orc as (
  select b.monthly_limit_cents            as teto,
         b.enforcement_mode               as modo,
         b.enforcement_effective_at       as efetivo_em,
         b.alarm_threshold_pct            as limiar_pct
    from ai_budgets b
   where b.organization_id = $1
),
gasto as (
  select public.fn_gasto_de_ia_do_mes($1) as spent
),
-- Lido ANTES dos inserts: todas as CTEs enxergam o MESMO snapshot, então
-- \`avisado_antes\` reflete o estado anterior a qualquer insert deste statement.
-- É \`created_at >= date_trunc('month', now())\` e NÃO \`status = 'open'\`: fechar o
-- aviso à mão não pode virar um bypass permanente do bloqueio.
avisado_antes as (
  select exists (
    select 1 from agent_inbox_items
     where organization_id = $1 and kind = 'budget_warning'
       and created_at >= date_trunc('month', now())
  ) as ja
),
-- LAÇO DE RETORNO: o gasto caiu abaixo do limiar — virou o mês, ou o admin
-- subiu o teto. Retrata os dois avisos. Sem isto o alerta CRÍTICO fica aceso
-- para sempre: o único auto-resolvedor do produto é o de circuit.ts, escopado
-- por ref_kind próprio, e o item de orçamento nunca teve ref_kind.
-- As TRÊS condições que retratam. A primeira é a do laço normal (o gasto caiu
-- abaixo do limiar); as outras duas fecham o item quando o gate PERDEU a
-- capacidade de reabri-lo — teto apagado ou derrubado abaixo do piso —, porque
-- \`decidirOrcamento\` devolve 'seguir' nesses dois casos e o alerta ficaria
-- aceso para sempre afirmando uma parada que não existe mais.
retrata as (
  update agent_inbox_items set status = 'resolved'
   where organization_id = $1
     and kind in ('budget_exceeded','budget_warning')
     and status = 'open'
     -- Só os itens do orçamento da ORG, e o legado sem referência. O item do
     -- teto do PLANO (ref_kind 'plano') tem retratação própria, em SQL_TETO_DO_PLANO.
     and (ref_kind is null or ref_kind = 'ai_budget')
     and (
       (select teto from orc) is null
       or (select teto from orc) < ${PISO_DE_TETO_CENTS}
       or (select spent from gasto) < (select teto * limiar_pct / 100.0 from orc)
     )
  returning 1
),
-- ⚠️ O \`teto >= piso\` NÃO é zelo: sem ele, teto 0 torna a condição do limiar
-- \`spent >= 0\` — SEMPRE verdadeira, já na primeira chamada, com gasto zero —, e
-- a CTE \`retrata\` acima exigia \`spent < 0\` para fechar. O par produzia um aviso
-- PERMANENTE e FALSO na Central, no caminho de primeira impressão (organização
-- nova, sem linha em \`ai_budgets\`, admin escolhendo "Me avisar" sem digitar
-- teto). Espelha as recusas 'sem_teto' e 'teto_abaixo_do_piso' de
-- \`decidirOrcamento\`: o efeito colateral não pode aplicar uma régua que a
-- decisão pura não aplica. A porta de escrita (PATCH /api/v1/ai/budget) recusa
-- o mesmo estado com 422 — isto aqui é a segunda camada, para a linha que
-- chegou por outro caminho.
avisa as (
  insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
  select $1, 'budget_warning', 'warn', $2, $3, 'ai_budget', $1
   where (select modo from orc) in ('avisar','bloquear')
     and (select teto from orc) >= ${PISO_DE_TETO_CENTS}
     and (select spent from gasto) >= (select teto * limiar_pct / 100.0 from orc)
     and not exists (
       select 1 from agent_inbox_items
        where organization_id = $1 and kind = 'budget_warning' and status = 'open'
     )
  -- on conflict SEM ALVO de propósito: com o alvo (organization_id, kind) e o
  -- predicado do índice, este statement passaria a EXIGIR que o índice único
  -- parcial da 0540 exista — num clone que aplicou o código antes do banco, a
  -- consulta do orçamento falharia com 42P10 e o chamador seguiria SEM TETO.
  -- Sem alvo a cláusula não depende de inferência nenhuma, e o veredito viaja
  -- inteiro; para estas linhas (kind de orçamento) o único conflito possível é
  -- o do índice da 0540. Quem chega segundo simplesmente não insere.
  on conflict do nothing
  returning 1
)
select (select teto from orc)         as teto,
       (select modo from orc)         as modo,
       (select efetivo_em from orc)   as efetivo_em,
       (select limiar_pct from orc)   as limiar_pct,
       (select spent from gasto)      as gasto,
       (select ja from avisado_antes) as avisado_antes;
`;

// ═══ O TETO DE IA DO PLANO (spec da cobrança do revendedor §5) ═══
//
// Separado de `ai_budgets`: aquele é o orçamento que a ORGANIZAÇÃO escolhe; este
// é o bolso do DONO da instalação, que vende o plano. Por isso o `modo 'off'` da
// organização não o desliga, e só a chave da instalação o consulta (decisão D-9:
// conta o mês inteiro, inclusive BYOK, mas só BLOQUEIA a chave da instalação).
//
// ⚠️ `lerTetoDoPlano` é o único I/O deste arquivo — mora aqui, ao lado de
// `SQL_ORCAMENTO`, porque o invariante de banco precisa executar ESTE texto, e o
// caminho legado (`workers/ai-response-worker.ts`) importa a decisão e os
// textos sem poder arrastar o engine.

export const TITULO_TETO_DO_PLANO = 'O uso de IA do plano acabou';
export const CORPO_TETO_DO_PLANO =
  'O uso de IA incluído no plano acabou neste mês. As conversas foram para a equipe. ' +
  'Peça a quem administra o sistema para trocar de plano, cadastre uma chave de IA própria ou aguarde o próximo mês.';
/** Vai para `llm_calls.error_message` e para o `last_error` da fila — a instrução numa linha. */
export const MOTIVO_TETO_DO_PLANO =
  'uso de IA incluído no plano da empresa esgotado neste mês — chamada recusada antes de sair byte para o provedor; peça a quem administra o sistema para trocar de plano, cadastre uma chave de IA própria ou aguarde a virada do mês (agent_inbox_items kind=budget_exceeded ref_kind=plano)';

export type VereditoDoPlano =
  | {
      acao: 'seguir';
      porque: 'chave_de_emergencia' | 'chave_da_organizacao' | 'purpose_isento' | 'sem_teto' | 'abaixo_do_teto';
    }
  | { acao: 'bloquear'; porque: 'teto_do_plano' };

/**
 * A decisão do teto do plano, pura. Só `chave === 'off'` afrouxa: é o
 * interruptor único do dono (D-9). `'avisar'` rebaixa o orçamento da org, e o
 * teto do plano não é da org.
 */
export function decidirTetoDoPlano(e: {
  tetoUsdCents: number | null;
  gastoUsdCents: number;
  origemDaChave: OrigemDaChaveLlm;
  purpose: string;
  chave: ChaveDeOrcamento;
}): VereditoDoPlano {
  if (e.chave === 'off') return { acao: 'seguir', porque: 'chave_de_emergencia' };
  if (e.origemDaChave !== 'chave_da_instalacao') return { acao: 'seguir', porque: 'chave_da_organizacao' };
  if (ehPurposeIsento(e.purpose)) return { acao: 'seguir', porque: 'purpose_isento' };
  if (e.tetoUsdCents === null) return { acao: 'seguir', porque: 'sem_teto' };
  if (e.gastoUsdCents < e.tetoUsdCents) return { acao: 'seguir', porque: 'abaixo_do_teto' };
  return { acao: 'bloquear', porque: 'teto_do_plano' };
}

const RECURSO_TETO_DE_IA: RecursoDoPlano = 'ia_usd_cents';

/**
 * Lê o teto e o gasto numa ida, e fecha o item do plano que perdeu a razão.
 *
 * Parâmetros: `$1` organization_id, `$2` o recurso (`'ia_usd_cents'`).
 *
 * Sem teto — a instalação de empresa única, com a cobrança desligada —, o gasto
 * NÃO é somado: essa instalação não paga uma soma de `llm_calls` por chamada por
 * uma capacidade que não usa.
 *
 * LAÇO DE RETORNO: o `budget_exceeded` do PLANO aberto é resolvido quando o gate
 * perdeu a razão de bloquear — gasto abaixo do teto (virou o mês, ou o plano
 * subiu) OU teto nenhum (a empresa ficou isenta, ou o plano perdeu o teto). A
 * mesma régua de `SQL_ORCAMENTO`: sem o caso do teto nulo, o aviso "as conversas
 * foram para a equipe" ficaria aceso para sempre, porque não há outro resolvedor.
 * A cobrança DESLIGADA não chega aqui, salvo a janela do memo (o gate nem roda o
 * statement); quem fecha esse caso é `fn_cobranca_liberar_suspensoes`, no ato de
 * desligar.
 */
export const SQL_TETO_DO_PLANO = `
with plano as (
  select public.fn_limite_do_plano($1, $2) as teto
),
leitura as (
  select teto,
         case when teto is null then null else public.fn_gasto_de_ia_do_mes($1) end as gasto
    from plano
),
retrata as (
  update agent_inbox_items set status = 'resolved'
   where organization_id = $1
     and kind = 'budget_exceeded'
     and ref_kind = 'plano'
     and status = 'open'
     and ((select teto from leitura) is null or (select gasto from leitura) < (select teto from leitura))
  returning 1
)
select teto, gasto from leitura;
`;

export type LeituraDoTetoDoPlano =
  | { tetoUsdCents: number | null; gastoUsdCents: number }
  | { indisponivel: string };

/**
 * Nunca lança. Erro → `indisponivel` com o SQLSTATE, e quem chama SEGUE: o teto
 * do plano falhando não pode levar junto o orçamento da org, que é consultado
 * depois, por outro statement.
 */
export async function lerTetoDoPlano(
  db: Pick<pg.Pool, 'query'>,
  organizationId: string,
): Promise<LeituraDoTetoDoPlano> {
  try {
    const { rows } = await db.query<{ teto: number | string | null; gasto: number | string | null }>(
      SQL_TETO_DO_PLANO,
      [organizationId, RECURSO_TETO_DE_IA],
    );
    const linha = rows[0];
    return {
      tetoUsdCents: linha?.teto === null || linha?.teto === undefined ? null : Number(linha.teto),
      gastoUsdCents: Number(linha?.gasto ?? 0),
    };
  } catch (err) {
    const codigo = (err as { code?: unknown } | null)?.code;
    const texto = err instanceof Error ? err.message : String(err);
    return { indisponivel: `${typeof codigo === 'string' ? codigo : 'sem_sqlstate'}: ${texto}`.slice(0, 300) };
  }
}

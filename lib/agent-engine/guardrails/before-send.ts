/**
 * Cadeia de guardrails `before_send` (F2-13; edge-contract §2, blueprint 5.2) — o
 * seam determinístico entre a decisão do modelo (tool `send_message`) e o canal.
 * Estilo exit-2 do Claude Code: cada gate pode VETAR e a razão volta AO MODELO
 * como erro instrutivo (o modelo a vê no turno seguinte); só se TODOS passarem a
 * mensagem alcança o `ChannelAdapter` (e, por baixo, o sink idempotente F2-06).
 *
 * Ordem FINAL v6 (DECLARATIVA + VERSIONADA — `BEFORE_SEND_GATES`/`BEFORE_SEND_CHAIN_VERSION`,
 * F4-08/F4-09): (1) stop/opt-out — irrevogável; (2) lgpd — anonimização/base legal de
 * prospecção (F4-09); (3) anti-ban (janela/throttle/warm-up/caps — F2-11); (3.5) janela de
 * atendimento; (4) spinning (F2-12); (5) promise determinística (F4-01); (6) promise
 * semântica (F4-02); (6.5) case promise — anti-alucinação de casos humanos (spec 15 §10.2,
 * Wave 4); (6.7) internal_vocabulary — vazamento de vocabulário interno ao cliente
 * (`docs/doctrine/separacao-fala-e-operacao.md`); (7) disclosure
 * (F4-05). A ordem é código-constante DE PROPÓSITO, não config de
 * runtime: "stop primeiro" é invariante de segurança (regra dura nº 2) e mudar a ordem sem
 * bumpar a versão quebra o CI — deixá-la mutável em disco seria um footgun.
 *
 * ⚠️ Nota de 2026-07-28: a frase acima descrevia um guarda que **não existia**. Medido —
 * `BEFORE_SEND_CHAIN_VERSION` e `BEFORE_SEND_GATES` só apareciam neste arquivo, e nenhum
 * teste os referenciava. Agora existe: `tests/unit/before-send-chain-shape.test.ts`, que
 * trava ordem, tamanho, versão e unicidade. Ao mudar a cadeia de propósito, ele vermelha
 * PRIMEIRO — é o sinal de que a mudança foi vista, e não presumida. Cada gate
 * AVALIADO por tentativa vira registro estruturado de auditoria (gate + veredito + código)
 * pelo logger de obs/ E linha durável em `before_send_traces` (exportável por run — o
 * comando `pnpm audit:run`, acceptance 3).
 *
 * SERIALIZAÇÃO por número (INBOX-008): o read-then-act (ler estado de pacing/copies
 * → decidir → enviar → registrar) roda sob `pg_advisory_xact_lock(hashtext(
 * channel_session_id))` numa transação dedicada. Dois workers no MESMO número não
 * leem cap-1 ambos e estouram o cap em 1 (nem enviam copy duplicada): o segundo
 * espera o lock, relê o estado JÁ com o envio do primeiro contabilizado e veta.
 * O `channel.send` (POST ao CRM) roda na sua PRÓPRIA conexão/tx — o advisory lock
 * do nosso client serializa os concorrentes enquanto ele acontece.
 * ponytail: o lock fica retido durante o POST ao CRM (bounded por CRM_MCP_TIMEOUT_MS)
 * — aceitável no volume do MVP (throttle já espaça o número); se um número virar
 * gargalo, o upgrade é reservar o slot antes do POST e reconciliar no watchdog.
 */
import type pg from 'pg';
import type { ChannelSendResult } from '../channel-adapter';

import type { Logger } from '../obs/logger';
import { emitVetoActivity } from '@/lib/leads/veto-activity';
import type { Queryable } from '../queue/queue';
import { decidePacing } from '../pacing/engine';
import type { PacingState } from '../pacing/engine';
import type { PacingKnobs } from '../pacing/defaults';
import { loadChannelKnobs, loadPacingState, recordSend } from '../pacing/store';
import { decideSpinning } from '../spinning/engine';
import type { RecentCopy } from '../spinning/engine';
import { loadRecentCopies, loadSpinningKnobs, recordCopy } from '../spinning/store';
import type { SpinningKnobs } from '../spinning/defaults';
import { decidePromise } from './promise/engine';
import { loadPromiseTable } from './promise/table';
import type { PromiseTable } from './promise/table';
import { renderSemanticPromiseVeto } from './promise/semantic';
import type { PromiseClassification } from './promise/semantic';
import {
  bodyContainsDisclosure,
  countPriorAcceptedSends,
  loadDisclosureTemplate,
  prependDisclosure,
} from './disclosure/template';
import type { DisclosureMode } from './disclosure/template';
import { escalateLgpdVeto, isLegalBasisValid } from './lgpd/legal-basis';
import type { LgpdInput } from './lgpd/legal-basis';
import { detectHumanPromise } from './human-promise';
import { detectarVazamentoInterno, renderVetoDeVazamento } from './vazamento-interno';
// Módulo PURO de propósito (`capabilities`, não `index`): o seam não arrasta o
// adapter — e com ele o cliente HTTP do canal — para dentro do worker.
import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';
import { isWindowOpen } from './messaging-window';
import type { ChannelProvider } from '@/lib/channels/capabilities';

/** O que os gates enxergam — carregado UMA vez sob o lock, por tentativa de envio. */
export interface GateContext {
  now: Date;
  /** corpo candidato (para o gate de spinning). */
  body: string;
  /**
   * STOP irrevogável: `contacts.is_blocked` OR `contacts.force_human`, lidos DIRETO da
   * fonte (mesmo banco pós-fusão — não existe mais cache) SOB o lock desta tentativa,
   * OR o sinal lido no `get_lead_context` deste turno.
   */
  optedOut: boolean;
  /**
   * `conversations.assignee_kind === 'user'`, lido FRESCO sob o mesmo advisory
   * lock desta tentativa (G3-02: assignee de 1ª classe). Um atendente humano que
   * clica "Assumir" veta a IA aqui, no ÚLTIMO seam antes do envio físico — mesmo
   * que o turno tenha começado antes do clique (a corrida entre "worker gerando
   * resposta" e "humano assumindo" é o próprio bug: sem esta releitura, os dois
   * respondem o mesmo cliente). Ausente/false = não assumido → gate no-op nesta
   * checagem, retrocompatível com todo caller que ainda não lê esta coluna.
   */
  humanAssigned?: boolean;
  /**
   * Canal desta tentativa. Nenhum gate pergunta QUEM é o provider (invariante 1
   * de `docs/doctrine/restricao-de-canal.md`) — só o entrega a `capabilitiesOf`
   * para perguntar o que o canal permite.
   */
  provider: ChannelProvider;
  /**
   * Insumo da janela de 24h. Guardamos o CARIMBO, não o veredito: a janela é
   * derivada (ver `messaging-window.ts`), e passar um booleano já decidido faria o
   * gate confiar numa conta feita em outro lugar, em outro instante.
   *
   * **OPCIONAL de propósito, diferente de `provider`** — e a razão não é conveniência.
   * Ausente vale `lastInboundAt: null`, que a janela lê como FECHADA: um chamador que
   * esqueça o campo produz VETOS visíveis, não envios errados silenciosos. `provider`
   * não tinha default seguro (qualquer escolha mente sobre metade dos canais), então
   * lá a obrigatoriedade se paga; aqui o default é a direção segura, e mantê-lo
   * opcional evita tocar num invariante congelado só para satisfazer o compilador.
   */
  messagingWindow?: {
    /** `conversations.last_inbound_at`. `null` = contato nunca escreveu. */
    lastInboundAt: Date | null;
    /**
     * Esta tentativa é um TEMPLATE aprovado? Fora da janela, template é
     * exatamente o que a plataforma permite — então o gate passa.
     *
     * Só ESTE gate muda; `stop`, `lgpd`, `pacing` e os demais continuam valendo.
     * Sem esta flag haveria só duas saídas, ambas erradas: o `send_template`
     * seria vetado pelo gate que ele existe para resolver, ou pularia a cadeia
     * inteira — e aí template viraria bypass de opt-out, LGPD e horário.
     */
    isTemplate?: boolean;
  };
  pacing: {
    knobs: PacingKnobs;
    state: PacingState;
    crmDailyLimit: number | null;
    rng?: () => number;
  };
  spinning: {
    knobs: SpinningKnobs;
    window: RecentCopy[];
  };
  /**
   * Tabela de preços/promessas versionada da org (F4-01), carregada por ponteiro
   * sob o lock. null = org não fiscaliza promessa (gate no-op).
   */
  promise: {
    table: PromiseTable | null;
    versionId?: string;
  };
  /**
   * Resultado da camada SEMÂNTICA de promessa (F4-02), classificado ASSÍNCRONO na carga do
   * ctx (sob o lock) via camada de modelo agnóstica — o complemento da camada determinística
   * (`promise`) para texto livre que a regex não pega. null = camada não rodou (sem
   * classificador injetado → gate no-op). suspectPhrase é trecho da PRÓPRIA candidata: volta
   * ao modelo no veto (erro de ensino), mas nunca vai a log (PII fora de log).
   */
  semanticPromise: PromiseClassification | null;
  /**
   * Disclosure "assistente virtual" (F4-05; blueprint 5.7) — carregado por ponteiro sob o
   * lock. `template` null = org não configurou disclosure (gate no-op). `isFirstOutbound`
   * = não há envio `accepted` prévio a ESTE contato (send_ledger F2-06). `mode` (knob) decide o
   * que fazer quando a 1ª mensagem sai sem disclosure: 'veto' (bloqueia + ensina) ou 'inject'
   * (o gate devolve `amendBody` com o disclosure prependado).
   */
  disclosure: {
    template: string | null;
    versionId?: string;
    isFirstOutbound: boolean;
    mode: DisclosureMode;
  };
  /**
   * Conformidade LGPD (F4-09) lida do CRM no turno (get_lead_context) — fonte da verdade,
   * nunca do body. null = não injetado (gate no-op; testes que não exercitam LGPD). `isAnonymized`
   * veta QUALQUER envio; a base legal veta o 1º toque de PROSPECÇÃO. `isFirstOutbound` é o mesmo
   * sinal do disclosure (send_ledger accepted == 0), computado uma vez sob o lock.
   */
  lgpd: (LgpdInput & { isFirstOutbound: boolean }) | null;
  /**
   * Guardrail anti-alucinação de casos humanos (spec 15 §10.2, Wave 4) — a invariante
   * sagrada é: o lead NUNCA recebe promessa-de-humano sem um caso aberto. `casesEnabled`
   * false = feature off para a org → `casePromiseGate` no-op (default retrocompatível para
   * TODOS os outros callers de `runBeforeSend`, que nem sabem desta camada). `hasOpenCase`
   * (lido no turno via `hasOpenCaseForContact`) OU `openedCaseThisTurn` (a IA já chamou
   * `open_human_case` neste turno) tornam o gate no-op também — só veta quando a candidata
   * promete humano E não há caso nenhum.
   */
  casesEnabled: boolean;
  hasOpenCase: boolean;
  openedCaseThisTurn: boolean;
  /**
   * Arma o `internalVocabularyGate` (vazamento de vocabulário interno ao cliente).
   *
   * **OPCIONAL, e ausente = DESARMADO — a direção segura AQUI é o oposto da do
   * `messagingWindow`, e a diferença é o que acontece com o veto em cada caminho.**
   *
   * No caminho do AGENTE (`send_message` do inbound-turn) existe um modelo no laço: o
   * veto volta a ele como erro instrutivo, ele reescreve, e o fail-safe libera se
   * insistir. Lá o gate arma.
   *
   * No caminho DETERMINÍSTICO (`followup-turn.ts`, re-entrada por template versionado)
   * não há ninguém para ensinar: veto ali é DROP SILENCIOSO — o follow-up morre sem
   * sintoma, desligando por dentro o invariante 4 de `docs/doctrine/sistema-vivo.md`
   * ("nada morre sem próximo passo"). Um default ARMADO faria exatamente isso em todo
   * chamador que não conhece este campo. Por isso ausente = no-op: na pior hipótese o
   * vazamento continua (o defeito que já existe e que este gate veio MEDIR), nunca o
   * cliente mudo.
   *
   * O contra-risco — um caller do agente esquecer o campo e desarmar o guarda em
   * silêncio — é coberto por `tests/unit/gate-vazamento-interno.test.ts`, que cobra a
   * fiação nos dois sentidos: presente no `send_message`, ausente no follow-up.
   */
  internalVocabularyEnforced?: boolean;
}

/**
 * Veredito de UM gate. `waitMs` (só no pacing) é o throttle a respeitar antes do
 * envio. `detail` (só em veto, ex.: promise) leva valores estruturados detectado vs
 * permitido ao trace — números/rótulos curtos, NUNCA o corpo (sem PII).
 */
export type GateVerdict =
  // `amendBody` (só o disclosureGate F4-05 o usa hoje): o gate PASSA mas pede que o corpo a
  // enviar seja reescrito (disclosure prependado). O runner aplica ao ctx.body (gates
  // seguintes veem o corpo emendado) E ao corpo que vai ao `send` — sem novo status de veredito.
  //
  // `skipped: 'not_applicable'` (invariante 4 de `docs/doctrine/restricao-de-canal.md`): a
  // restrição não existe NESTE canal. Passa, mas o trace registra que não se aplicava — um
  // `pass` silencioso apagaria a diferença entre "não regrediu" e "provo que não regrediu".
  | { pass: true; waitMs?: number; amendBody?: string; skipped?: 'not_applicable' }
  | { pass: false; code: string; reason: string; nextAllowedAt?: Date; detail?: Record<string, string | number> };

export interface Gate {
  readonly name: string;
  evaluate(ctx: GateContext): GateVerdict;
}

/**
 * Gate 1 — STOP/opt-out/força-humano/assumido-por-humano: veto IRREVOGÁVEL
 * (regra dura nº 2), 1ª linha.
 *
 * `humanAssigned` entra ANTES de `optedOut` de propósito: são vetos irmãos da
 * mesma família (nenhum dos dois é "recuperável" dentro do turno), mas a ordem
 * entre eles não muda o resultado — os dois curto-circuitam a cadeia inteira.
 */
export const stopGate: Gate = {
  name: 'stop',
  evaluate: (ctx) => {
    if (ctx.humanAssigned === true) {
      return {
        pass: false,
        code: 'assumido_por_humano',
        reason:
          'um atendente humano assumiu esta conversa — a IA não pode responder enquanto isso ' +
          'valer; encerre o turno sem tentar de novo.',
      };
    }
    if (ctx.optedOut) {
      return {
        pass: false,
        code: 'contato_bloqueado',
        reason:
          'o lead optou por sair do atendimento (bloqueio/opt-out irrevogável) — não é ' +
          'possível enviar nada a ele; encerre o turno sem tentar de novo.',
      };
    }
    return { pass: true };
  },
};

/**
 * Gate LGPD (F4-09; edge-contract §5 achado 5.6) — veto de conformidade HARD, agrupado com o
 * stop entre os vetos IRREVOGÁVEIS de negócio, ANTES do anti-ban (posição 2 de
 * `BEFORE_SEND_GATES`): checar base legal/anonimização não faz sentido depois de gastar janela.
 *   - `isAnonymized` → veta QUALQUER envio (`lgpd_anonymized`), sempre (anonimização é irreversível);
 *   - 1º toque de PROSPECÇÃO (isProspecting && isFirstOutbound) sem base legal válida →
 *     `lgpd_missing_legal_basis`. Responder a inbound (isProspecting=false, o MVP) NÃO dispara.
 * Sem contexto LGPD injetado (null) = no-op. A escala à agent_inbox_items acontece no runner (precisa
 * de DB), não aqui — o gate é puro/síncrono como os demais.
 */
export const lgpdGate: Gate = {
  name: 'lgpd',
  evaluate: (ctx) => {
    const lgpd = ctx.lgpd;
    if (lgpd === null) return { pass: true };
    if (lgpd.isAnonymized) {
      return {
        pass: false,
        code: 'lgpd_anonymized',
        reason:
          'este contato está anonimizado no CRM (LGPD) — é proibido enviar qualquer mensagem a ' +
          'ele; encerre o turno sem tentar de novo.',
      };
    }
    if (lgpd.isProspecting && lgpd.isFirstOutbound && !isLegalBasisValid(lgpd.legalBasis)) {
      return {
        pass: false,
        code: 'lgpd_missing_legal_basis',
        reason:
          'não há base legal válida (LGPD) para o 1º contato de prospecção com este lead ' +
          '(consentimento, ou legítimo interesse com LIA registrada); não é possível iniciar a ' +
          'abordagem — encerre o turno, o time comercial vai regularizar a base legal no CRM.',
      };
    }
    return { pass: true };
  },
};

/**
 * Gate de promessa (F4-01) — validação determinística de preço/desconto/parcelamento
 * candidato contra a tabela versionada da org; contradição clara vira veto instrutivo
 * (anti-"vendo por R$1", blueprint 6.5). Sem tabela = no-op. Posição 4 de
 * `BEFORE_SEND_GATES` (F4-08), após spinning e antes da camada semântica.
 */
export const promiseGate: Gate = {
  name: 'promise',
  evaluate: (ctx) => {
    if (ctx.promise.table === null) return { pass: true };
    const decision = decidePromise({ candidate: ctx.body, table: ctx.promise.table });
    return decision.allow
      ? { pass: true }
      : {
          pass: false,
          code: decision.code ?? 'promise_out_of_table',
          reason: decision.reason ?? '',
          ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
        };
  },
};

/**
 * Gate semântico de promessa (F4-02) — lê o veredito do classificador binário barato
 * (rodado async na carga do ctx, DEPOIS da camada determinística `promiseGate`) e veta
 * promessa em texto livre que a regex não pega ("faço de graça", "garanto entrega amanhã").
 * Sem classificação (camada off) ou sem promessa = no-op. O veto devolve ao modelo a frase
 * suspeita destacada (erro de ensino). Posição 5 de `BEFORE_SEND_GATES` (F4-08), logo após
 * a camada determinística `promiseGate`.
 */
export const semanticPromiseGate: Gate = {
  name: 'semantic_promise',
  evaluate: (ctx) => {
    if (ctx.semanticPromise === null || !ctx.semanticPromise.isPromise) return { pass: true };
    return {
      pass: false,
      code: 'promise_semantic',
      reason: renderSemanticPromiseVeto(ctx.semanticPromise.suspectPhrase),
      // detail é LOGADO: só o rótulo da camada, nunca a frase (trecho da candidata — sem PII).
      detail: { promise_layer: 'semantic' },
    };
  },
};

/**
 * Gate anti-alucinação de casos humanos (spec 15 §10.2, Wave 4) — a garantia DURA da
 * invariante "o lead nunca recebe promessa-de-humano sem caso aberto". Off (`casesEnabled`
 * false) ou já há caso (`hasOpenCase`/`openedCaseThisTurn` — a IA abriu um NESTE turno) =
 * no-op. Só veta quando o detector determinístico (`detectHumanPromise`) acha uma promessa
 * clara na candidata E nenhum caso existe. O fail-safe de 2ª camada (auto-abre caso e
 * re-roda a cadeia) vive na orquestração do `send_message` (inbound-turn.ts), não aqui — o
 * gate em si é síncrono/puro como os demais. Posição 6.5 de `BEFORE_SEND_GATES` (logo após
 * `semanticPromiseGate`, antes do `disclosureGate`): roda depois das duas camadas de
 * promessa comercial (preço/desconto) porque é uma categoria distinta de promessa
 * (envolvimento humano, não oferta).
 */
export const casePromiseGate: Gate = {
  name: 'case_promise',
  evaluate: (ctx) => {
    if (!ctx.casesEnabled) return { pass: true };
    if (ctx.hasOpenCase || ctx.openedCaseThisTurn) return { pass: true };
    if (!detectHumanPromise(ctx.body)) return { pass: true };
    return {
      pass: false,
      code: 'case_promise_without_case',
      reason:
        'Você prometeu envolver um humano mas não abriu um caso. Chame a tool ' +
        'open_human_case (descrevendo o que precisa) OU reformule a mensagem sem prometer humano.',
    };
  },
};

/**
 * Gate de VAZAMENTO DE VOCABULÁRIO INTERNO (`docs/doctrine/separacao-fala-e-operacao.md`)
 * — barra a mensagem ao cliente final que carrega nome de ferramenta, tabela/coluna,
 * papel de acesso, termo de arquitetura ou erro cru. Desarmado (campo ausente) = no-op;
 * a razão do default e a assimetria entre os caminhos estão em `GateContext`.
 *
 * ⚠️ É REDE, NÃO CURA. A cura é o Conversador nunca ter visto esse vocabulário (a
 * separação falar/operar da doutrina). O valor imediato e independente deste gate é
 * transformar "acho que vaza" em NÚMERO: cada veto vira linha em `before_send_traces`
 * com a categoria do vazamento, antes de qualquer refatoração.
 *
 * Posição 6.7 de `BEFORE_SEND_GATES`: DEPOIS do `casePromiseGate` e ANTES do
 * `disclosureGate`. Antes do disclosure de propósito — o disclosure pode EMENDAR o corpo
 * (`amendBody`), e o que se quer inspecionar é o texto que o MODELO escreveu, não um
 * texto já costurado pelo runtime (o disclosure é template do tenant; vetá-lo devolveria
 * ao modelo a culpa por uma frase que não é dele).
 */
export const internalVocabularyGate: Gate = {
  name: 'internal_vocabulary',
  evaluate: (ctx) => {
    if (ctx.internalVocabularyEnforced !== true) return { pass: true };
    const achado = detectarVazamentoInterno(ctx.body);
    if (!achado.achou) return { pass: true };
    return {
      pass: false,
      code: 'internal_vocabulary_leak',
      reason: renderVetoDeVazamento(achado.termos),
      // detail é LOGADO e persistido: contagem + CATEGORIAS (rótulos nossos, fechados),
      // nunca os termos — termo casado é trecho da candidata, e um snake_case pode ter
      // vindo de um dado do lead. A medição que a doutrina pede cabe nestes dois campos.
      detail: { leaked_count: achado.termos.length, leaked_kinds: achado.categorias.join(',') },
    };
  },
};

/**
 * Gate de disclosure (F4-05; blueprint 5.7) — garante que a PRIMEIRA mensagem outbound a um
 * lead novo se apresenta como assistente virtual (template versionado por org). Decisão de
 * produto que blinda hoje (CDC) e amanhã (PL 2338), não exigência da Meta. Sem template
 * configurado OU não sendo o 1º outbound → PASS (segundo em diante não repete). 1º outbound
 * que JÁ contém o disclosure → PASS. 1º sem disclosure → conforme o knob `mode`: 'veto'
 * bloqueia com erro de ensino; 'inject' devolve `amendBody` com o disclosure prependado.
 * Posição 7 (última) de `BEFORE_SEND_GATES` (F4-08): roda sobre o corpo já validado pelos
 * gates anteriores e pode emendá-lo (inject) antes do envio.
 */
export const disclosureGate: Gate = {
  name: 'disclosure',
  evaluate: (ctx) => {
    const template = ctx.disclosure.template;
    if (template === null || !ctx.disclosure.isFirstOutbound) return { pass: true };
    if (bodyContainsDisclosure(ctx.body, template)) return { pass: true };
    if (ctx.disclosure.mode === 'inject') {
      return { pass: true, amendBody: prependDisclosure(ctx.body, template) };
    }
    return {
      pass: false,
      code: 'disclosure_required',
      reason:
        'a 1ª mensagem a um lead novo precisa se apresentar como assistente virtual antes de ' +
        `qualquer outra coisa; inclua no início: "${template.trim()}"`,
    };
  },
};

/**
 * Gate 2 — anti-ban: janela/warm-up/cap vetam; throttle vira `waitMs` (espera, não veto).
 *
 * A capability `banRisk` do canal decide se a parte ANTI-BAN arma. Ela entra em
 * `decidePacing` em vez de curto-circuitar o gate porque a janela horária/domingo/fuso
 * que vive no mesmo motor é CORTESIA e vale em todo canal (invariante 3 da doutrina):
 * um `return` antes da decisão desarmaria o horário comercial junto e faria a IA acordar
 * cliente às 3h. Quando o anti-ban não se aplica, o veredito carrega
 * `skipped: 'not_applicable'` — o trace registra a inaplicabilidade (invariante 4); se a
 * cortesia vetar, o veredito é veto normal e o skipped nem existe.
 */
export const pacingGate: Gate = {
  name: 'pacing',
  evaluate: (ctx) => {
    const { banRisk } = capabilitiesOf(ctx.provider);
    const decision = decidePacing({
      now: ctx.now,
      knobs: ctx.pacing.knobs,
      state: ctx.pacing.state,
      crmDailyLimit: ctx.pacing.crmDailyLimit,
      banRisk,
      rng: ctx.pacing.rng,
    });
    if (!decision.allow) {
      return { pass: false, code: decision.code, reason: decision.reason, nextAllowedAt: decision.nextAllowedAt };
    }
    return banRisk
      ? { pass: true, waitMs: decision.waitMs }
      : { pass: true, waitMs: decision.waitMs, skipped: 'not_applicable' };
  },
};

/** Gate 3 — spinning: template idêntico em massa na janela do número → veto ("varie"). */
/**
 * Gate 3.5 — janela de atendimento. **Irmão do anti-ban, com física invertida.**
 *
 * O anti-ban é auto-restrição: posso falar quando quiser, mas o canal me bane se eu
 * abusar. Este é hetero-restrição: não me banem, mas a plataforma me PROÍBE e me
 * COBRA. Nenhum é subconjunto do outro, e por isso convivem lado a lado em vez de
 * um generalizar o outro (doutrina `restricao-de-canal.md`).
 *
 * Posição: logo após `pacing`, depois dos vetos irrevogáveis (`stop`, `lgpd`) e antes
 * de `spinning`, que só faz sentido se o envio for acontecer.
 *
 * A `reason` diz a SAÍDA, não só o problema. Veto que apenas nega faz o modelo tentar
 * de novo igual — e a cadeia devolve a razão a ele como erro instrutivo.
 */
export const messagingWindowGate: Gate = {
  name: 'messaging_window',
  evaluate: (ctx) => {
    const caps = capabilitiesOf(ctx.provider);
    // Canal que fala livre a qualquer hora não tem janela. `skipped`, nunca `pass`
    // silencioso: a diferença entre "não regrediu" e "consigo PROVAR que não
    // regrediu" é esta linha no trace (invariante 4 da doutrina).
    if (caps.freeformOutsideWindow) return { pass: true, skipped: 'not_applicable' };

    // Template é a saída legítima fora da janela — é o que a `reason` do veto
    // manda usar. Vetá-lo aqui fecharia a única porta que este gate abre.
    if (ctx.messagingWindow?.isTemplate === true) return { pass: true };

    if (isWindowOpen(ctx.now, ctx.messagingWindow?.lastInboundAt ?? null)) return { pass: true };

    return {
      pass: false,
      code: 'messaging_window_closed',
      reason:
        'a janela de 24 horas com este contato fechou; o canal vai recusar texto livre. ' +
        'Use um template aprovado (ferramenta send_template) ou encerre o turno sem enviar.',
    };
  },
};

const spinningGate: Gate = {
  name: 'spinning',
  evaluate: (ctx) => {
    const decision = decideSpinning({
      candidate: ctx.body,
      window: ctx.spinning.window,
      knobs: ctx.spinning.knobs,
    });
    return decision.allow ? { pass: true } : { pass: false, code: decision.code, reason: decision.reason };
  },
};

/**
 * VERSÃO da ordem da cadeia (F4-08, acceptance 2). Toda mudança na ordem/composição de
 * `BEFORE_SEND_GATES` EXIGE bumpar esta versão, porque a ordem é contrato e não detalhe
 * de implementação. Quem cobra isso é `tests/unit/before-send-chain-shape.test.ts`.
 *
 * ⚠️ Este comentário citava `before-send.test.ts` como o guarda. **Esse arquivo nunca
 * existiu** (medido 2026-07-28: `find . -name before-send.test.ts` → nada). Era a segunda
 * frase deste mesmo módulo a prometer um mecanismo ausente. Se você chegou aqui procurando
 * a trava, ela é a citada acima — e ela é real: sabotada em três eixos (ordem, tamanho +
 * versão, unicidade), cada um vermelho no caso certo. v1 = [stop, pacing, spinning] (F2-13); v2 = ordem final da
 * cadeia definitiva com os gates F4 (F4-08); v3 = insere o gate LGPD (F4-09) na posição 2,
 * junto do stop entre os vetos de conformidade irrevogáveis, antes do anti-ban; v4 = insere
 * `casePromiseGate` (spec 15 §10.2, Wave 4) logo após `semanticPromiseGate` — a garantia dura
 * do guardrail anti-alucinação de casos humanos; v5 = insere `messagingWindowGate`
 * logo após `pacing` — o irmão de hetero-restrição do anti-ban (Fase 4 do seam de
 * canais). Em canal sem janela ele registra `skipped`, então nenhum envio muda de
 * destino: a v5 muda o TRACE, não o comportamento. v6 = insere
 * `internalVocabularyGate` entre `case_promise` e `disclosure` — a rede contra vazamento
 * de vocabulário interno ao cliente (`docs/doctrine/separacao-fala-e-operacao.md`). Ele
 * nasce DESARMADO por default (ver `GateContext.internalVocabularyEnforced`): só o
 * caminho do agente o arma, então, como a v5, a v6 não muda o destino de nenhum envio
 * que já existia — muda o TRACE, e passa a medir o vazamento onde há modelo para ensinar.
 */
export const BEFORE_SEND_CHAIN_VERSION = 6;

/**
 * Ordem FINAL da cadeia (F4-08/F4-09; edge-contract §before_send / blueprint órgão 5) — DADO
 * declarativo iterado pelo runner (acceptance 2). Constante de código de propósito: a
 * precedência é invariante de segurança/compliance, não config de runtime.
 *   (1) stop/opt-out/force_human — irrevogável, 1ª linha (regra dura nº 2);
 *   (2) lgpd — anonimização/base legal de prospecção, veto de conformidade HARD (F4-09);
 *   (3) pacing — janela/throttle/warm-up/caps anti-ban (F2-11);
 *   (4) spinning — template idêntico em massa (F2-12);
 *   (5) promise — validação determinística de preço/desconto/parcelamento (F4-01);
 *   (6) semantic_promise — promessa em texto livre que a regex não pega (F4-02);
 *   (6.5) case_promise — anti-alucinação de casos humanos (spec 15 §10.2, Wave 4);
 *   (6.7) internal_vocabulary — vazamento de vocabulário interno ao cliente (doutrina
 *         `separacao-fala-e-operacao.md`); antes do disclosure porque ele pode emendar o corpo;
 *   (7) disclosure — 1ª mensagem se apresenta como assistente virtual (F4-05).
 * (O anti-jailbreak F4-04 é INBOUND advisório, não gate de before_send — não entra aqui.)
 */
export const BEFORE_SEND_GATES: readonly Gate[] = [
  stopGate,
  lgpdGate,
  pacingGate,
  messagingWindowGate,
  spinningGate,
  promiseGate,
  semanticPromiseGate,
  casePromiseGate,
  internalVocabularyGate,
  disclosureGate,
];

/** Uma linha do trace de auditoria — um registro por gate avaliado na tentativa. */
export interface GateTraceEntry {
  gate: string;
  verdict: 'pass' | 'veto' | 'skipped';
  code?: string;
  /** só em veto com valores estruturados (promise): detectado vs permitido — sem PII. */
  detail?: Record<string, string | number>;
}

export type BeforeSendResult =
  | { status: 'sent'; outcome: ChannelSendResult; trace: GateTraceEntry[] }
  | {
      status: 'vetoed';
      gate: string;
      code: string;
      /** erro instrutivo pt-br que volta ao modelo (o quê foi vetado + o que fazer). */
      message: string;
      nextAllowedAt?: Date;
      trace: GateTraceEntry[];
    };

export interface RunBeforeSendArgs {
  pool: pg.Pool;
  log: Logger;
  tenantId: string;
  leadId: string;
  /**
   * Esta tentativa é um template aprovado? Chega até `ctx.messagingWindow.isTemplate`,
   * e SÓ o gate de janela o consulta — todos os demais continuam valendo.
   */
  isTemplate?: boolean;
  /**
   * RUN a que a tentativa pertence (job_queue.id) — chave de export da auditoria
   * (`before_send_traces`, acceptance 3 F4-08). Ausente = trace NÃO persistido em DB (só
   * emitido ao logger); usado por testes que exercitam a cadeia sem um job real.
   */
  jobId?: string;
  /** número (channel_sessions.id do CRM) — chave da serialização e do estado anti-ban. */
  channelSessionId: string;
  body: string;
  /** `contacts.is_blocked` lido no get_lead_context deste turno; OR com a leitura direta da fonte no gate stop. */
  optedOutThisTurn: boolean;
  /**
   * Agente do turno (`ai_agents.id`), quando o chamador o conhece. Sem ele a
   * atividade de veto entra como 'system' — com o lastro do trace, mas sem
   * afirmar QUAL agente decidiu calar. Opcional de propósito: nem todo caminho
   * de envio nasce de um agente identificado.
   */
  agentId?: string | null;
  /**
   * channel_sessions.daily_message_limit do CRM (fonte única do cap absoluto). null =
   * ainda não lido do CRM no runtime → os degraus de warm-up (conservadores) seguram
   * o cap. Ponto de injeção: quando o drain expuser o limite da sessão, passar aqui.
   */
  crmDailyLimit: number | null;
  now: Date;
  /** injeções de teste (jitter determinístico + espera sem relógio real). */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** override da cadeia (testes); default `BEFORE_SEND_GATES`. */
  gates?: readonly Gate[];
  /**
   * Classificador semântico de promessa (F4-02) — closure ASYNC injetada por quem monta o
   * run (com tenantId/llm cfg/registry fechados dentro; o seam agnóstico F2-23 vive em edge/).
   * Roda na carga do ctx SOB o lock, complementando a camada determinística. Ausente = camada
   * semântica off (gate no-op). A montagem/ordem final da cadeia é da F4-08.
   */
  classifyPromiseSemantic?: (body: string) => Promise<PromiseClassification>;
  /**
   * Modo do gate de disclosure (F4-05) quando a 1ª mensagem sai sem disclosure: 'inject'
   * (default conservador — o disclosure é sempre adicionado, garantindo a apresentação) ou
   * 'veto' (bloqueia + ensina o modelo). Knob do env (DISCLOSURE_MODE).
   */
  disclosureMode?: DisclosureMode;
  /**
   * Conformidade LGPD (F4-09) montada de fonte confiável (CRM lido no turno via
   * get_lead_context — regra dura nº 1). Ausente = gate LGPD no-op (testes que não a exercitam).
   * O runner completa com `isFirstOutbound` (send_ledger accepted) sob o lock.
   */
  lgpd?: LgpdInput;
  /**
   * Guardrail anti-alucinação de casos humanos (spec 15 §10.2, Wave 4) — ver `GateContext`.
   * TODOS ausentes (default) = `casesEnabled` false → `casePromiseGate` no-op, retrocompatível
   * com todo caller de `runBeforeSend` que não conhece casos (o guardrail existente F4-01/02).
   */
  casesEnabled?: boolean;
  hasOpenCase?: boolean;
  openedCaseThisTurn?: boolean;
  /**
   * Arma o `internalVocabularyGate`. Ausente (default) = gate no-op — ver a justificativa
   * do default em `GateContext.internalVocabularyEnforced`: um veto no caminho
   * determinístico seria drop silencioso, e cliente mudo não pode ser desfecho.
   *
   * O caminho do agente também o passa `false` de propósito no re-run do fail-safe:
   * depois de N vetos no mesmo turno o envio sai, com registro.
   */
  enforceInternalVocabulary?: boolean;
  /**
   * Enviado SÓ se TODOS os gates passarem — ChannelAdapter (própria tx/idempotência). Recebe o
   * corpo FINAL (o disclosureGate F4-05 pode emendá-lo via `amendBody`): quem monta o send DEVE
   * enviar este `body`, não o corpo original capturado antes da cadeia.
   */
  send: (body: string) => Promise<ChannelSendResult>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Roda a cadeia before_send para UMA tentativa de envio. Curto-circuita no 1º veto
 * (o resto da cadeia é registrado como 'skipped'); só chama `send()` se todos passam.
 * Serializa o read-then-act por número via advisory xact lock (ver cabeçalho).
 */
export async function runBeforeSend(args: RunBeforeSendArgs): Promise<BeforeSendResult> {
  const gates = args.gates ?? BEFORE_SEND_GATES;
  const client = await args.pool.connect();
  try {
    await client.query('begin');
    // Serialização por número: dois workers no MESMO channel_session esperam a vez.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [args.channelSessionId]);

    // Estado confiável carregado SOB o lock (os contadores de cap/janela de copies
    // são racy — precisam ver o que o worker anterior já efetivou).
    const provider = await loadChannelProvider(client, args.tenantId, args.channelSessionId);
    const optedOut = args.optedOutThisTurn || (await readStopFlags(client, args.tenantId, args.leadId));
    const humanAssigned =
      (await readAssigneeKind(client, args.tenantId, args.leadId, args.channelSessionId)) === 'user';
    const pacingCfg = await loadChannelKnobs(client, args.tenantId, args.channelSessionId, args.log);
    const pacingState = await loadPacingState(client, args.tenantId, args.channelSessionId, {
      now: args.now,
      timezone: pacingCfg.knobs.timezone,
      numberActivatedAt: pacingCfg.numberActivatedAt,
    });
    const spinningKnobs = await loadSpinningKnobs(client, args.tenantId, args.channelSessionId, args.log);
    const window = await loadRecentCopies(client, args.tenantId, args.channelSessionId, spinningKnobs.windowSize);
    // org de fonte confiável (RunBeforeSendArgs.tenantId = organization_id do row do job) — regra dura nº 1.
    const promise = await loadPromiseTable(client, args.tenantId);
    // Camada semântica (F4-02): a chamada de modelo (async) roda AQUI, sob o lock, e o
    // veredito entra no ctx para o `semanticPromiseGate` (sync) ler. Ausente = camada off.
    const semanticPromise = args.classifyPromiseSemantic ? await args.classifyPromiseSemantic(args.body) : null;
    // Disclosure (F4-05): template por ponteiro da org + detecção de 1º outbound via
    // send_ledger (só conta se há template — sem template o gate é no-op de qualquer forma).
    const disclosure = await loadDisclosureTemplate(client, args.tenantId);
    // "1º outbound" (send_ledger accepted == 0): sinal compartilhado pelo disclosure (F4-05) e
    // pelo gate LGPD (F4-09). Só consulta o ledger se ALGUM dos dois precisa (senão no-op).
    const isFirstOutbound =
      disclosure !== null || args.lgpd !== undefined
        ? (await countPriorAcceptedSends(client, args.tenantId, args.leadId)) === 0
        : false;

    const lastInboundAt = await readLastInboundAt(
      client,
      args.tenantId,
      args.leadId,
      args.channelSessionId,
    );

    const ctx: GateContext = {
      now: args.now,
      body: args.body,
      optedOut,
      humanAssigned,
      provider,
      messagingWindow: { lastInboundAt, ...(args.isTemplate === true ? { isTemplate: true } : {}) },
      pacing: { knobs: pacingCfg.knobs, state: pacingState, crmDailyLimit: args.crmDailyLimit, rng: args.rng },
      spinning: { knobs: spinningKnobs, window },
      promise: { table: promise?.table ?? null, ...(promise?.versionId !== undefined ? { versionId: promise.versionId } : {}) },
      semanticPromise,
      disclosure: {
        template: disclosure?.body ?? null,
        ...(disclosure?.versionId !== undefined ? { versionId: disclosure.versionId } : {}),
        isFirstOutbound,
        mode: args.disclosureMode ?? 'inject',
      },
      lgpd: args.lgpd !== undefined ? { ...args.lgpd, isFirstOutbound } : null,
      casesEnabled: args.casesEnabled ?? false,
      hasOpenCase: args.hasOpenCase ?? false,
      openedCaseThisTurn: args.openedCaseThisTurn ?? false,
      internalVocabularyEnforced: args.enforceInternalVocabulary ?? false,
    };

    const trace: GateTraceEntry[] = [];
    let veto: { gate: string; code: string; message: string; nextAllowedAt?: Date } | null = null;
    let throttleWaitMs = 0;
    for (const gate of gates) {
      if (veto !== null) {
        trace.push({ gate: gate.name, verdict: 'skipped' });
        continue;
      }
      const verdict = gate.evaluate(ctx);
      if (verdict.pass) {
        // Gate que não se aplicava ao canal entra no trace como 'skipped' COM código
        // (invariante 4): o 'skipped' sem código acima é o outro caso — gate não avaliado
        // porque um anterior vetou. Passar como 'pass' apagaria a distinção na auditoria.
        trace.push(
          verdict.skipped !== undefined
            ? { gate: gate.name, verdict: 'skipped', code: verdict.skipped }
            : { gate: gate.name, verdict: 'pass' },
        );
        if (verdict.waitMs !== undefined && verdict.waitMs > throttleWaitMs) throttleWaitMs = verdict.waitMs;
        // Emenda de corpo (F4-05 inject): o corpo a enviar passa a ser o emendado; gates
        // seguintes na cadeia o veem (ex.: spinning avalia o texto que de fato vai ao lead).
        if (verdict.amendBody !== undefined) ctx.body = verdict.amendBody;
      } else {
        trace.push({
          gate: gate.name,
          verdict: 'veto',
          code: verdict.code,
          ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
        });
        veto = {
          gate: gate.name,
          code: verdict.code,
          message: verdict.reason,
          ...(verdict.nextAllowedAt !== undefined ? { nextAllowedAt: verdict.nextAllowedAt } : {}),
        };
      }
    }
    emitTrace(args.log, args.channelSessionId, trace);
    // Auditoria DURÁVEL por run (F4-08 acceptance 3): escrita autônoma (pool, fora da tx
    // serializada) — o trace do VETO tem de sobreviver ao rollback abaixo. Nunca bloqueia
    // o message-plane: falha aqui vira log.error (o trace do logger já é o backup), não
    // exceção. ponytail: 1 insert por tentativa; se virar gargalo, batelar por run.
    const traceId = await persistTrace(args, trace, veto);

    // Wave 3 (CORE 2), cenário 11: o agente decidir NÃO falar é evento. Silêncio
    // com motivo é informação; silêncio sem registro é abandono. Só o VETO entra
    // — gate que passou é telemetria e fica na tabela de origem.
    if (veto && traceId) {
      try {
        const r = await emitVetoActivity({
          pool: args.pool,
          organizationId: args.tenantId,
          contactId: args.leadId,
          traceId,
          gate: veto.gate,
          code: veto.code,
          agentId: args.agentId ?? null,
        });
        if (!r.routed) {
          args.log.info('veto sem negócio para pendurar: registrado no event_log', {
            channel_session_id: args.channelSessionId,
            reason: r.reason,
          });
        }
      } catch (err) {
        // A timeline do veto não pode derrubar o veto.
        args.log.error('falha ao registrar atividade de veto (segue)', {
          channel_session_id: args.channelSessionId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }

    // Veto de LGPD (F4-09): escala à inbox do runtime (regra dura nº 13) para o DPO/comercial
    // regularizar. Escrita autônoma no pool (fora da tx serializada), como o trace — sobrevive
    // ao rollback do veto e nunca derruba o message-plane (o gate já barrou o envio).
    if (veto !== null && veto.code.startsWith('lgpd_')) {
      await escalateLgpdVeto(args.pool, { tenantId: args.tenantId, leadId: args.leadId, code: veto.code }, args.log);
    }

    if (veto !== null) {
      // Nada foi escrito: rollback fecha a tx e solta o lock. O envio NÃO acontece.
      await client.query('rollback');
      return { status: 'vetoed', trace, ...veto };
    }

    // Throttle: espera o gap restante (bounded pelos knobs) antes do envio.
    if (throttleWaitMs > 0) await (args.sleep ?? realSleep)(throttleWaitMs);

    // ctx.body é o corpo FINAL (emendado pelo disclosureGate F4-05 quando aplicável).
    const outcome = await args.send(ctx.body);

    // Registra pacing + copy SÓ no envio físico fresco ('sent'). 'already_sent'/'queued'
    // já foram (ou serão) contabilizados na tentativa original — o ledger F2-06 faz as
    // repetições curto-circuitarem, então re-registrar aqui inflaria o cap.
    if (outcome.kind === 'sent') {
      await recordSend(client, args.tenantId, args.channelSessionId, args.now);
      await recordCopy(client, args.tenantId, args.channelSessionId, ctx.body, args.now);
    }
    await client.query('commit');
    return { status: 'sent', outcome, trace };
  } catch (err) {
    await rollback(client, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * STOP direto da fonte (pós-fusão, mesmo banco): `contacts.is_blocked` OR
 * `contacts.force_human`, lidos sob o lock — não existe mais cache no harness.
 */
/**
 * O canal desta sessão, do banco (migration 0087) — nunca suposto.
 *
 * Sessão ilegível cai no default conservador em vez de estourar: o valor é o
 * mesmo do `default` da coluna, então o comportamento é idêntico ao do literal
 * que esta função substitui. Errar para o lado de um canal SEM risco de ban
 * desarmaria o anti-ban (`banRisk`) num número que pode ser banido — o erro
 * caro é esse, e é por isso que o default é o canal conservador.
 */
/**
 * Provider da sessão. Exportado porque o TURNO também precisa: é o que decide se a
 * ferramenta de template entra no run (canal sem janela não tem o que fazer com ela,
 * e tool inútil no prompt degrada a escolha do modelo).
 */
export async function loadChannelProvider(
  db: Queryable,
  organizationId: string,
  channelSessionId: string,
): Promise<ChannelProvider> {
  const { rows } = await db.query<{ provider: string }>(
    'select provider from channel_sessions where organization_id = $1 and id = $2',
    [organizationId, channelSessionId],
  );
  const provider = rows[0]?.provider;
  return provider === undefined ? DEFAULT_CHANNEL_PROVIDER : (provider as ChannelProvider);
}

async function readStopFlags(db: Queryable, organizationId: string, contactId: string): Promise<boolean> {
  const { rows } = await db.query<{ stopped: boolean }>(
    'select (is_blocked or force_human) as stopped from contacts where organization_id = $1 and id = $2',
    [organizationId, contactId],
  );
  return rows[0]?.stopped === true;
}

/**
 * `conversations.assignee_kind` FRESCO sob o lock desta tentativa (G3-02) — o
 * insumo do veto `assumido_por_humano` do `stopGate`. Mesma chave de
 * `readLastInboundAt` (contato + canal, não só contato: a mesma pessoa pode ter
 * conversas em números diferentes, e posse é por conversa). Sem conversa
 * encontrada = `null`, que o gate lê como "ninguém assumiu" — a direção segura
 * é não vetar por falta de dado, não o contrário: um `null` tratado como
 * "assumido" silenciaria a IA em toda conversa nova, que ainda não tem linha em
 * `conversations` populada com este par contato/canal.
 */
async function readAssigneeKind(
  db: Queryable,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ assignee_kind: string | null }>(
    `select assignee_kind from conversations
      where organization_id = $1 and contact_id = $2 and channel_session_id = $3
      order by last_inbound_at desc nulls last
      limit 1`,
    [organizationId, contactId, channelSessionId],
  );
  return rows[0]?.assignee_kind ?? null;
}

/**
 * `conversations.last_inbound_at` da conversa deste turno — o INSUMO da janela de 24h.
 *
 * Lê o carimbo, não o veredito: a janela é derivada (`messaging-window.ts`). Se a
 * conversa não existe (ou nunca teve inbound), devolve `null`, que o gate lê como
 * janela FECHADA — a direção segura.
 *
 * `channel_session_id` entra na chave porque o mesmo contato pode ter conversas em
 * números diferentes, e a janela é por conversa, não por pessoa: responder no número
 * A não abre licença para escrever pelo número B.
 */
async function readLastInboundAt(
  db: Queryable,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ last_inbound_at: Date | null }>(
    `select last_inbound_at from conversations
      where organization_id = $1 and contact_id = $2 and channel_session_id = $3
      order by last_inbound_at desc nulls last
      limit 1`,
    [organizationId, contactId, channelSessionId],
  );
  return rows[0]?.last_inbound_at ?? null;
}

/** Trace estruturado: uma linha por gate avaliado (ids não são PII; corpo nunca é logado). */
function emitTrace(log: Logger, channelSessionId: string, trace: GateTraceEntry[]): void {
  for (const entry of trace) {
    log.info('before_send gate avaliado', {
      channel_session_id: channelSessionId,
      gate: entry.gate,
      verdict: entry.verdict,
      ...(entry.code !== undefined ? { code: entry.code } : {}),
      // detected vs allowed (só promise): números/rótulos, nunca o corpo (sem PII).
      ...(entry.detail ?? {}),
    });
  }
}

/**
 * Persiste o trace da tentativa em `before_send_traces` para export por run (F4-08 acc 3).
 * Escrita autônoma no pool (não no client sob lock) para sobreviver ao rollback do veto.
 * Sem jobId = pula (testes sem job real). Falha de escrita → log.error + segue: a auditoria
 * durável é importante, mas não pode derrubar um envio legítimo (o trace do logger cobre).
 */
async function persistTrace(
  args: RunBeforeSendArgs,
  trace: GateTraceEntry[],
  veto: { gate: string; code: string } | null,
): Promise<string | null> {
  if (args.jobId === undefined) return null;
  try {
    const { rows } = await args.pool.query<{ id: string }>(
      `insert into before_send_traces
         (organization_id, job_id, contact_id, channel_session_id, trace, vetoed_gate, vetoed_code)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        args.tenantId,
        args.jobId,
        args.leadId,
        args.channelSessionId,
        JSON.stringify(trace),
        veto?.gate ?? null,
        veto?.code ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    args.log.error('falha ao persistir trace de auditoria before_send (segue: logger é backup)', {
      channel_session_id: args.channelSessionId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

async function rollback(client: pg.PoolClient, cause: unknown): Promise<void> {
  try {
    await client.query('rollback');
  } catch (rollbackErr) {
    throw new AggregateError([cause, rollbackErr], 'rollback falhou após erro na cadeia before_send');
  }
}

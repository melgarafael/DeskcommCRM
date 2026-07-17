/**
 * Cadeia de guardrails `before_send` (F2-13; edge-contract §2, blueprint 5.2) — o
 * seam determinístico entre a decisão do modelo (tool `send_message`) e o canal.
 * Estilo exit-2 do Claude Code: cada gate pode VETAR e a razão volta AO MODELO
 * como erro instrutivo (o modelo a vê no turno seguinte); só se TODOS passarem a
 * mensagem alcança o `ChannelAdapter` (e, por baixo, o sink idempotente F2-06).
 *
 * Ordem FINAL v3 (DECLARATIVA + VERSIONADA — `BEFORE_SEND_GATES`/`BEFORE_SEND_CHAIN_VERSION`,
 * F4-08/F4-09): (1) stop/opt-out — irrevogável; (2) lgpd — anonimização/base legal de
 * prospecção (F4-09); (3) anti-ban (janela/throttle/warm-up/caps — F2-11); (4) spinning
 * (F2-12); (5) promise determinística (F4-01); (6) promise semântica (F4-02); (7) disclosure
 * (F4-05). A ordem é código-constante DE PROPÓSITO, não config de
 * runtime: "stop primeiro" é invariante de segurança (regra dura nº 2) e mudar a ordem sem
 * bumpar a versão quebra o CI — deixá-la mutável em disco seria um footgun. Cada gate
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

/** O que os gates enxergam — carregado UMA vez sob o lock, por tentativa de envio. */
export interface GateContext {
  now: Date;
  /** corpo candidato (para o gate de spinning). */
  body: string;
  /**
   * STOP irrevogável: `leads.is_opted_out` (cache do harness) OU `contacts.is_blocked`
   * lido no `get_lead_context` deste turno (fonte: CRM). `force_human` entra no MESMO
   * OR quando a leitura direta chegar (o `crm_get_contact` do MCP não expõe a coluna
   * hoje — gap documentado em edge/crm/get-lead-context.ts).
   */
  optedOut: boolean;
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
   * Tabela de preços/promessas versionada do tenant (F4-01), carregada por ponteiro
   * sob o lock. null = tenant não fiscaliza promessa (gate no-op).
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
   * lock. `template` null = tenant não configurou disclosure (gate no-op). `isFirstOutbound`
   * = não há envio `accepted` prévio a ESTE lead (send_ledger F2-06). `mode` (knob) decide o
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
  | { pass: true; waitMs?: number; amendBody?: string }
  | { pass: false; code: string; reason: string; nextAllowedAt?: Date; detail?: Record<string, string | number> };

export interface Gate {
  readonly name: string;
  evaluate(ctx: GateContext): GateVerdict;
}

/** Gate 1 — STOP/opt-out/força-humano: veto IRREVOGÁVEL (regra dura nº 2), 1ª linha. */
const stopGate: Gate = {
  name: 'stop',
  evaluate: (ctx) =>
    ctx.optedOut
      ? {
          pass: false,
          code: 'contato_bloqueado',
          reason:
            'o lead optou por sair do atendimento (bloqueio/opt-out irrevogável) — não é ' +
            'possível enviar nada a ele; encerre o turno sem tentar de novo.',
        }
      : { pass: true },
};

/**
 * Gate LGPD (F4-09; edge-contract §5 achado 5.6) — veto de conformidade HARD, agrupado com o
 * stop entre os vetos IRREVOGÁVEIS de negócio, ANTES do anti-ban (posição 2 de
 * `BEFORE_SEND_GATES`): checar base legal/anonimização não faz sentido depois de gastar janela.
 *   - `isAnonymized` → veta QUALQUER envio (`lgpd_anonymized`), sempre (anonimização é irreversível);
 *   - 1º toque de PROSPECÇÃO (isProspecting && isFirstOutbound) sem base legal válida →
 *     `lgpd_missing_legal_basis`. Responder a inbound (isProspecting=false, o MVP) NÃO dispara.
 * Sem contexto LGPD injetado (null) = no-op. A escala à inbox_items acontece no runner (precisa
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
 * candidato contra a tabela versionada do tenant; contradição clara vira veto instrutivo
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
 * Gate de disclosure (F4-05; blueprint 5.7) — garante que a PRIMEIRA mensagem outbound a um
 * lead novo se apresenta como assistente virtual (template versionado por tenant). Decisão de
 * produto que blinda hoje (CDC) e amanhã (PL 2338), não exigência da Meta. Sem template
 * configurado OU não sendo o 1º outbound → PASS (segundo em diante não repete). 1º outbound
 * que JÁ contém o disclosure → PASS. 1º sem disclosure → conforme o knob `mode`: 'veto'
 * bloqueia com erro de ensino; 'inject' devolve `amendBody` com o disclosure prependado.
 * Posição 6 (última) de `BEFORE_SEND_GATES` (F4-08): roda sobre o corpo já validado pelos
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

/** Gate 2 — anti-ban: janela/warm-up/cap vetam; throttle vira `waitMs` (espera, não veto). */
const pacingGate: Gate = {
  name: 'pacing',
  evaluate: (ctx) => {
    const decision = decidePacing({
      now: ctx.now,
      knobs: ctx.pacing.knobs,
      state: ctx.pacing.state,
      crmDailyLimit: ctx.pacing.crmDailyLimit,
      rng: ctx.pacing.rng,
    });
    return decision.allow
      ? { pass: true, waitMs: decision.waitMs }
      : { pass: false, code: decision.code, reason: decision.reason, nextAllowedAt: decision.nextAllowedAt };
  },
};

/** Gate 3 — spinning: template idêntico em massa na janela do número → veto ("varie"). */
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
 * `BEFORE_SEND_GATES` EXIGE bumpar esta versão — o snapshot pinado por versão em
 * before-send.test.ts quebra o CI se a ordem mudar sem o bump (a ordem é contrato, não
 * detalhe de implementação). v1 = [stop, pacing, spinning] (F2-13); v2 = ordem final da
 * cadeia definitiva com os gates F4 (F4-08); v3 = insere o gate LGPD (F4-09) na posição 2,
 * junto do stop entre os vetos de conformidade irrevogáveis, antes do anti-ban.
 */
export const BEFORE_SEND_CHAIN_VERSION = 3;

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
 *   (7) disclosure — 1ª mensagem se apresenta como assistente virtual (F4-05).
 * (O anti-jailbreak F4-04 é INBOUND advisório, não gate de before_send — não entra aqui.)
 */
export const BEFORE_SEND_GATES: readonly Gate[] = [
  stopGate,
  lgpdGate,
  pacingGate,
  spinningGate,
  promiseGate,
  semanticPromiseGate,
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
   * RUN a que a tentativa pertence (job_queue.id) — chave de export da auditoria
   * (`before_send_traces`, acceptance 3 F4-08). Ausente = trace NÃO persistido em DB (só
   * emitido ao logger); usado por testes que exercitam a cadeia sem um job real.
   */
  jobId?: string;
  /** número (channel_sessions.id do CRM) — chave da serialização e do estado anti-ban. */
  channelSessionId: string;
  body: string;
  /** `contacts.is_blocked` lido no get_lead_context deste turno; combina com o cache no gate stop. */
  optedOutThisTurn: boolean;
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
    const optedOut = args.optedOutThisTurn || (await readOptedOutCache(client, args.tenantId, args.leadId));
    const pacingCfg = await loadChannelKnobs(client, args.tenantId, args.channelSessionId, args.log);
    const pacingState = await loadPacingState(client, args.tenantId, args.channelSessionId, {
      now: args.now,
      timezone: pacingCfg.knobs.timezone,
      numberActivatedAt: pacingCfg.numberActivatedAt,
    });
    const spinningKnobs = await loadSpinningKnobs(client, args.tenantId, args.channelSessionId, args.log);
    const window = await loadRecentCopies(client, args.tenantId, args.channelSessionId, spinningKnobs.windowSize);
    // tenant de fonte confiável (RunBeforeSendArgs.tenantId, do row do job) — regra dura nº 1.
    const promise = await loadPromiseTable(client, args.tenantId);
    // Camada semântica (F4-02): a chamada de modelo (async) roda AQUI, sob o lock, e o
    // veredito entra no ctx para o `semanticPromiseGate` (sync) ler. Ausente = camada off.
    const semanticPromise = args.classifyPromiseSemantic ? await args.classifyPromiseSemantic(args.body) : null;
    // Disclosure (F4-05): template por ponteiro do tenant + detecção de 1º outbound via
    // send_ledger (só conta se há template — sem template o gate é no-op de qualquer forma).
    const disclosure = await loadDisclosureTemplate(client, args.tenantId);
    // "1º outbound" (send_ledger accepted == 0): sinal compartilhado pelo disclosure (F4-05) e
    // pelo gate LGPD (F4-09). Só consulta o ledger se ALGUM dos dois precisa (senão no-op).
    const isFirstOutbound =
      disclosure !== null || args.lgpd !== undefined
        ? (await countPriorAcceptedSends(client, args.tenantId, args.leadId)) === 0
        : false;

    const ctx: GateContext = {
      now: args.now,
      body: args.body,
      optedOut,
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
        trace.push({ gate: gate.name, verdict: 'pass' });
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
    await persistTrace(args, trace, veto);

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

async function readOptedOutCache(db: Queryable, tenantId: string, leadId: string): Promise<boolean> {
  const { rows } = await db.query<{ is_opted_out: boolean }>(
    'select is_opted_out from leads where tenant_id = $1 and id = $2',
    [tenantId, leadId],
  );
  return rows[0]?.is_opted_out === true;
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
): Promise<void> {
  if (args.jobId === undefined) return;
  try {
    await args.pool.query(
      `insert into before_send_traces
         (tenant_id, job_id, lead_id, channel_session_id, trace, vetoed_gate, vetoed_code)
       values ($1, $2, $3, $4, $5, $6, $7)`,
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
  } catch (err) {
    args.log.error('falha ao persistir trace de auditoria before_send (segue: logger é backup)', {
      channel_session_id: args.channelSessionId,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

async function rollback(client: pg.PoolClient, cause: unknown): Promise<void> {
  try {
    await client.query('rollback');
  } catch (rollbackErr) {
    throw new AggregateError([cause, rollbackErr], 'rollback falhou após erro na cadeia before_send');
  }
}

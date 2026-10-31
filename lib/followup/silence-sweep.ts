import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { StaleServiceBoundaryError, parseServiceBoundary, assertCurrentServiceBoundary, type ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * Gatilho de SILÊNCIO (Task 8.1) — TIME-DRIVEN, não event-driven. Roda como
 * uma varredura periódica dentro do MESMO tick do cron
 * `app/api/v1/cron/followup-flow-worker/route.ts`, lado a lado com
 * `runFollowupTick` (lib/followup/engine.ts) — decisão de arquitetura já
 * tomada (ver HANDOFF): silêncio não tem um EVENTO que o dispare (é ausência
 * de evento por um período), então não pertence a `reactivity.ts` (que reage
 * a linhas de `event_log`).
 *
 * Fluxo por tick: acha pointers `status='active'` com `trigger_config.kind=
 * 'silence'` (de TODAS as orgs — mesmo design cross-org do
 * `fn_claim_due_followup_enrollments`) → GATEIA cada um via
 * `decidirAgenteDoEnrollmentAutomatico` (grafo que pede IA só enrolla se
 * algum agente PUBLICADO da org arma o pointer; texto fixo segue com
 * `agent_id` nulo) → acha contatos silenciosos da org (sem inbound há >=
 * threshold_minutes) → cria 1 enrollment por (pointer, contato) qualificado,
 * nascendo no nó `trigger` do grafo pinado com `next_eval_at=now`. Como
 * `runSilenceSweep` roda DEPOIS de `runFollowupTick` no MESMO tick do cron
 * (route.ts), esse enrollment recém-criado só é reclamado no PRÓXIMO tick
 * (~1min depois), não neste.
 *
 * Idempotência + exclusividade: o índice único `idx_followup_enrollments_one_live`
 * é ORG-WIDE `(organization_id, contact_id)` (migration 0062, Task 8.6) — um
 * contato já vivo em QUALQUER fluxo da org barra novo enrollment (1 follow-up
 * vivo por lead), 23505 vira skip silencioso (`insertEnrollment` devolve
 * `inserted:false`), nunca erro. Um contato que COMPLETOU ou foi cancelado
 * pode ser re-enrollado na varredura seguinte se continuar silencioso — e É
 * ISSO QUE O COOLDOWN ABAIXO LIMITA.
 *
 * ─── Cooldown pós-conclusão (issue reportada em produção, 2026-09-25) ───────
 *
 * Esta linha dizia "aceitável no MVP, sem cooldown table" — e o "aceitável"
 * presumia que o intervalo entre tentativas seguiria sendo, na pior das
 * hipóteses, próximo do `threshold_minutes` configurado. Não é: o cron roda a
 * CADA MINUTO (`docker/scheduler/entrypoint.sh`), e como o contato que nunca
 * responde permanece "silencioso" para sempre (nada atualiza
 * `last_inbound_at`), a varredura seguinte reinscreve assim que o enrollment
 * anterior sai de `active`/`waiting_reply` — não depois de outro
 * `threshold_minutes`. Medido numa instalação real: um pointer "Triagem
 * parada" com `threshold_minutes: 120` reinscreveu o MESMO contato 32 vezes
 * em ~9 horas, a cada ~3 minutos (o tempo de vida de um enrollment de um nó
 * só), não a cada 2 horas — risco de banimento por spam no WhatsApp.
 *
 * O conserto reusa o MESMO `cutoffIso` já calculado para "está silencioso":
 * um contato só é elegível de novo se NENHUM enrollment TERMINADO deste
 * pointer para ele tiver sido concluído depois desse corte — ou seja, precisa
 * ter passado o `threshold_minutes` inteiro desde que a ÚLTIMA tentativa
 * (completed, cancelled ou dead) TERMINOU, não desde que ela começou.
 *
 * ⚠️ Duas armadilhas que a primeira versão deste conserto tinha (achadas em
 * revisão, antes de qualquer instalação real ver o defeito):
 *
 *  1. Ancorar em `started_at` em vez do fim da tentativa. Um nó `wait` do
 *     grafo aceita de 5 minutos a 90 dias (`graph-schema.ts`) — um fluxo cujo
 *     tempo total de execução passa do `threshold_minutes` do pointer já teria
 *     `started_at` fora da janela no momento em que finalmente termina, e a
 *     PRÓXIMA varredura (≤1min depois) reinscreveria na hora — reproduzindo o
 *     defeito original para qualquer fluxo mais lento que o de hoje. A âncora
 *     certa é `updated_at` de um enrollment TERMINAL (o mesmo commit que grava
 *     `completed_at` sempre regrava `updated_at` junto — `engine.ts` linhas
 *     301-302 e 576 — então não precisa de `coalesce`).
 *  2. Não excluir os status VIVOS (`active`, `waiting_reply`, `paused_handoff`,
 *     `paused_manual` — o mesmo conjunto do índice único
 *     `idx_followup_enrollments_one_live`) da consulta de cooldown. Um
 *     enrollment ainda em andamento SEMPRE bateria no filtro (acabou de
 *     começar), e passaria a contar como `skipped_cooldown` em vez do
 *     `skipped_existing` que o índice único já garante via 23505 — trocando o
 *     que cada contador mede sem nenhuma mudança de comportamento real.
 *
 * ─── Pausa de reentrada e pessoa no comando (2026-09-26) ─────────────────
 *
 * O cooldown acima é o PISO de todo fluxo e conta do fim da tentativa. Ele não
 * segura quem RESPONDE: com `cancel_on_reply`, a resposta do cliente encerra a
 * inscrição e começa o silêncio no mesmo instante — cooldown e limiar vencem
 * juntos, e o fluxo recomeça do primeiro passo um limiar depois de cada
 * "obrigado". Por isso o fluxo pode declarar `reentry_pause_minutes`: quem já
 * encerrou uma inscrição deste fluxo espera a pausa, contada também da última
 * mensagem do cliente (`pausa-de-reentrada.ts`). Sem pausa, vale só o cooldown.
 *
 * Conversa com PESSOA NO COMANDO (assumida por alguém da equipe, contato em
 * `force_human`, IA silenciada): não é inscrita, salvo fluxo com
 * `handoff_policy='allow'`. A política de handoff do fluxo já PAUSA ou CANCELA
 * a inscrição quando a pessoa assume no meio do caminho — mas ela reage ao
 * EVENTO do handoff, e uma inscrição criada DEPOIS dele não o vê: o passo de
 * texto saía por cima da pessoa, e o de IA terminava sem enviar e era
 * cancelado, num laço com a varredura seguinte (o cooldown o espaça, não o
 * encerra).
 *
 * ─── Dívida da equipe não é silêncio do cliente (2026-10-15) ──────────────
 *
 * O limiar mede UMA coisa: há quanto tempo o CLIENTE não escreve. Mensagem
 * nossa não zera esse relógio, e nada aqui perguntava se a última palavra da
 * conversa era dele ou nossa — então o contato que escreveu e NÃO FOI
 * ATENDIDO é, pela régua, o silencioso mais perfeito que existe.
 *
 * Medido na instalação do relato (15/10/2026), antes de qualquer publicação:
 * 147 conversas abertas SEM DONO, com média de 5 dias desde a última mensagem
 * do cliente e nenhum atendente disponível. Um fluxo de "primeiro contato sem
 * resposta" com limiar de 180 min alcançaria as 147 e perguntaria "ainda tem
 * interesse?" a quem estava esperando resposta há cinco dias. O gatilho não
 * estava errado sozinho: ele mede silêncio do cliente, e quem o armou leu
 * "ninguém respondeu" — as duas leituras são razoáveis e divergem exatamente
 * onde a fila está atrasada.
 *
 * `exige_resposta_da_equipe` fecha isso: só entra quem já tem resposta nossa
 * DEPOIS da última mensagem dele, medido por conversa (`last_outbound_at >` o
 * inbound vencedor), na MESMA consulta que já decide o silêncio — nenhuma ida
 * a mais ao banco. Fica **desligado por default**: ligá-lo para todos calaria
 * fluxos de silêncio já publicados em outras instalações, que é dado alheio.
 * Quem quer a proteção liga no painel do gatilho.
 *
 * ─── Resposta a mensagem automática não é lead frio (issue #3720) ──────────
 *
 * O outro lado da mesma moeda: aqui o silêncio é real (o cliente respondeu e
 * parou), mas o MOTIVO da última mensagem dele muda o que ela significa. Quem
 * responde "❤️" ao parabéns de aniversário não é um lead que esfriou — é
 * alguém reagindo à única coisa que NÓS dissemos, e o fluxo tratava a reação
 * como desinteresse: até 6 mensagens de venda em 7 dias para um cliente que só
 * agradeceu. `resposta-a-automacao.ts` responde "a última mensagem recebida é
 * resposta a uma automática nossa?" e o contato não é inscrito. Não é knob: a
 * premissa do fluxo ("o lead não voltou") é simplesmente falsa.
 *
 * agent_id: `decidirAgenteDoEnrollmentAutomatico` pina o agente publicado que
 * ARMA o pointer (menor uuid se >1). Grafo só de texto fixo nasce com
 * `agent_id` nulo. Grafo que pede IA sem agente é gate-out.
 *
 * `segments`: única primitiva de segmentação já modelada no schema é
 * `contacts.tags` (GIN index `idx_contacts_tags_gin` já existe) — interpretado
 * como overlap entre `trigger_config.params.segments` e `contacts.tags`.
 * `segments` vazio/ausente = todos os contatos silenciosos da org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import {
  decidirElegibilidade,
  montarEstadoDeElegibilidade,
  ttlDaAutorizacaoMs,
} from "@/lib/ai/elegibilidade/gate";
import { logger } from "@/lib/logger";

import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import {
  decidirAgenteDoEnrollmentAutomatico,
  noDeGatilhoDoGrafo,
  type FollowupGateDb,
  type NoDeGatilho,
} from "./agent-followup-gate";
import { emPausaDeReentrada, type BaseDaPausa, type FatosDaReentrada } from "./pausa-de-reentrada";
import { contatosQueORetornoSegura, folgaDepoisDoRetorno } from "./retorno-segura-o-fluxo";
import { contatosQueSoResponderamAAutomacao, type CandidatoDoSilencio } from "./resposta-a-automacao";

/**
 * Status que ocupam a vaga do índice único `idx_followup_enrollments_one_live`
 * — mesma lista usada em `gatilho-retorno.ts`, `gatilho-caso.ts` e
 * `ceder-turno-ao-retorno.ts` (não há constante exportada compartilhada; cada
 * consumidor já repete a própria cópia).
 */
const STATUS_VIVOS = ["active", "waiting_reply", "paused_handoff", "paused_manual"] as const;

export interface SilencePointer {
  id: string;
  organization_id: string;
  active_version_id: string;
  threshold_minutes: number;
  segments: string[];
  /** Pausa antes de recomeçar para quem já encerrou uma inscrição deste fluxo; ausente/0 = sem pausa. */
  reentry_pause_minutes?: number;
  /** Teto do silêncio: só entra quem está calado há MENOS que isto; ausente = sem teto. */
  max_silence_minutes?: number;
  /** De onde a pausa de reentrada conta; ausente = `ultima_mensagem`. */
  reentry_pause_basis?: BaseDaPausa;
  /** Só alcança quem a equipe já respondeu; ausente/`false` = o comportamento de sempre. */
  exige_resposta_da_equipe?: boolean;
  /** Quantas vezes no total o fluxo pode recomeçar para o mesmo contato; ausente = sem teto. */
  max_enrollments_por_contato?: number;
  /** `followup_flow_pointers.handoff_policy`; ausente = `pause` (o default da coluna). */
  handoff_policy?: "pause" | "cancel" | "allow";
}

/** DB surface o sweep precisa — narrow por consumidor (mesma doutrina de `AdminClient`/`ReactivityAdminClient`/`FollowupGateDb`). */
export interface SilenceSweepDb {
  /** Pointers ativos com trigger_config.kind='silence', de TODAS as orgs. */
  loadActiveSilencePointers(): Promise<SilencePointer[]>;
  /**
   * Contact ids da org sem inbound desde `cutoffIso` (inclusive); `segments` vazio = todos.
   * Com `desdeIso`, só quem falou pela última vez DEPOIS dele (o teto do silêncio).
   */
  loadSilentContactIds(orgId: string, cutoffIso: string, segments: string[], desdeIso?: string): Promise<string[]>;
  /**
   * Contatos que o retorno SEGURA — o agendado vivo e o recém-executado (issue
   * #2907): quem tem um "te escrevo no dia 30" a caminho, ou acabou de receber a
   * mensagem dele, não entra no fluxo de silêncio por cima. `folgaMs` é a do
   * fluxo que pergunta (`folgaDepoisDoRetorno`). Ver `retorno-segura-o-fluxo.ts`.
   */
  loadContatosComRetornoVivo(orgId: string, folgaMs: number): Promise<Set<string>>;
  /**
   * Dos `contactIds`, os que têm uma inscrição ENCERRADA (`completed`,
   * `cancelled`, `dead`) neste fluxo: quando terminou a mais recente e quando o
   * contato escreveu por último. Só é chamado com pausa configurada.
   */
  loadEncerramentosDoFluxo(orgId: string, pointerId: string, contactIds: string[]): Promise<Map<string, FatosDaReentrada>>;
  /**
   * Dos `contactIds`, os que têm uma pessoa no comando da conversa — assumida
   * por alguém da equipe, contato em `force_human` ou IA silenciada agora.
   */
  loadContatosComPessoaNoComando(orgId: string, contactIds: string[]): Promise<Set<string>>;
  /**
   * Dos `contactIds`, os que AINDA NÃO FORAM RESPONDIDOS: na conversa que guarda
   * o inbound mais recente, não há outbound depois dele.
   *
   * OPCIONAL pela mesma razão de `loadContactPersonal` em `reactivity.ts` — os
   * falsos de `tests/unit` e `tests/invariants` implementam só o que medem, e
   * exigir o método quebraria os treze. A ausência NÃO lê como "todos
   * respondidos": com o knob ligado e o método ausente, `runSilenceSweep` trata
   * TODOS como não respondidos e não inscreve ninguém (falha FECHADA). Mandar
   * contato proativo sem conseguir confirmar que a dívida é do cliente, e não
   * nossa, é o defeito que este knob existe para fechar.
   */
  loadContatosSemRespostaDaEquipe?(orgId: string, contactIds: string[]): Promise<Set<string>>;
  /**
   * Dos `contactIds`, os que só responderam a uma mensagem AUTOMÁTICA nossa —
   * aniversário, lembrete, pesquisa, aviso ou campanha (issue #3720). Ver
   * `resposta-a-automacao.ts` para a régua (a última mensagem que saiu antes da
   * resposta dele foi `sent_via='automation'`, e há menos de 48 h).
   *
   * OPCIONAL pela mesma razão dos dois anteriores — e aqui a ausência do método
   * lê como "ninguém", que é o comportamento de sempre. Diferente de
   * `exige_resposta_da_equipe` (que falha FECHADA), esta guarda corta ruído de
   * um fluxo que já existe, não abre um risco novo de spam: um adapter que não
   * sabe responder não pode calar o follow-up de toda a organização.
   */
  loadContatosQueSoResponderamAAutomacao?(orgId: string, contactIds: string[]): Promise<Set<string>>;
  /**
   * Quantas inscrições deste fluxo cada contato JÁ TEVE (vivas e encerradas) —
   * a conta do teto de repetições. Contato ausente do mapa é zero.
   *
   * Opcional pela mesma razão dos demais; e, como o outro, a ausência falha
   * FECHADA: com teto configurado e sem o método, ninguém é inscrito. Um teto
   * que o adaptador não sabe contar não pode ser lido como "pode mandar".
   */
  loadContagemDeInscricoes?(orgId: string, pointerId: string, contactIds: string[]): Promise<Map<string, number>>;
  /** Nó `trigger` do grafo pinado + se o fluxo pede agente; `null` se version/nó não existir. */
  loadTriggerNode(orgId: string, versionId: string): Promise<NoDeGatilho | null>;
  /**
   * Dentre `contactIds`, quais têm um enrollment TERMINAL (completed,
   * cancelled ou dead) deste pointer CONCLUÍDO depois de `cutoffIso` — ainda
   * em cooldown, não podem ser reinscritos agora. Enrollment VIVO
   * (active/waiting_reply/paused_handoff/paused_manual) fica de fora de
   * propósito: esse caso já é barrado pelo índice único
   * `idx_followup_enrollments_one_live` via `insertEnrollment` → 23505 →
   * `skipped_existing`; incluí-lo aqui trocaria o que os dois contadores
   * medem sem mudar nenhum comportamento real.
   */
  loadContactIdsEmCooldown(
    orgId: string,
    pointerId: string,
    contactIds: string[],
    cutoffIso: string,
  ): Promise<Set<string>>;
  /**
   * Dos `contactIds`, os que JÁ têm um enrollment VIVO (qualquer fluxo da org —
   * o índice único `idx_followup_enrollments_one_live` é por organização e
   * contato). Lido ANTES do insert para não tentar à toa: a tentativa que bate
   * no índice ainda passa pela fronteira de atendimento, pela proteção da agenda
   * e por um INSERT que o banco recusa — e cada recusa é uma tupla morta, uma
   * linha de erro no log do Postgres e um 409 no gateway. Medido numa instalação
   * real (02/10/2026): 86 contatos parados na espera longa de um remarketing,
   * tentados a cada minuto em dois fluxos → ~124 mil recusas por dia, 100.854
   * erros no log de 24 h, num banco que já estava sem fôlego de CPU. O 23505
   * continua tratado no insert: ele cobre a corrida, não o caso comum.
   */
  loadContatosComInscricaoViva(orgId: string, contactIds: string[]): Promise<Set<string>>;
  /** Insere o enrollment nascendo no nó trigger; `inserted:false` = 23505 (já vivo nesse pointer) → skip. */
  insertEnrollment(input: {
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    current_node_id: string;
    next_eval_at: string;
    agent_id: string | null;
  }): Promise<{ inserted: boolean }>;
}

export interface SilenceSweepSummary {
  pointers_scanned: number;
  pointers_gated_out: number;
  enrolled: number;
  skipped_existing: number;
  /** Elegível por silêncio, mas com tentativa deste pointer iniciada há menos de `threshold_minutes` — ver o cooldown no cabeçalho do arquivo. */
  skipped_cooldown: number;
  /** Silenciosos que ficaram de fora porque o retorno ainda os segura (agendado ou recém-executado — #2907). */
  skipped_pending_return: number;
  /** Silenciosos que já passaram pelo fluxo e ainda estão na pausa de reentrada. */
  skipped_reentry_pause: number;
  /** Silenciosos cuja conversa tem uma pessoa no comando (fluxo sem `handoff_policy='allow'`). */
  skipped_human_owned: number;
  /** Silenciosos que a equipe ainda não respondeu (só conta com `exige_resposta_da_equipe`). */
  skipped_sem_resposta_da_equipe: number;
  /** Silenciosos cuja última mensagem recebida é RESPOSTA a uma automática nossa (#3720). */
  skipped_resposta_a_automacao: number;
  /** Silenciosos que já bateram o teto de repetições deste fluxo. */
  skipped_teto_de_repeticoes: number;
  /**
   * Pointers que FALHARAM nesta varredura (logados e pulados). Um pointer ruim
   * — de uma empresa só — não pode calar a varredura de todas as outras: antes,
   * a primeira exceção abortava o laço e nenhum pointer depois dele era varrido.
   */
  pointers_failed: number;
}

export interface SilenceSweepDeps {
  db: SilenceSweepDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

export async function runSilenceSweep(deps: SilenceSweepDeps): Promise<SilenceSweepSummary> {
  const { db, gateDb, clock } = deps;
  const summary: SilenceSweepSummary = {
    pointers_scanned: 0,
    pointers_gated_out: 0,
    enrolled: 0,
    skipped_existing: 0,
    skipped_cooldown: 0,
    skipped_pending_return: 0,
    skipped_reentry_pause: 0,
    skipped_human_owned: 0,
    skipped_sem_resposta_da_equipe: 0,
    skipped_resposta_a_automacao: 0,
    skipped_teto_de_repeticoes: 0,
    pointers_failed: 0,
  };

  const pointers = await db.loadActiveSilencePointers();
  summary.pointers_scanned = pointers.length;

  // Memoiza a decisão do agente por pointer nesta varredura. A query do gate
  // é 1 por org; o grafo diz se a ausência de agente é gate-out ou `agent_id`
  // nulo (texto fixo).
  const agentCache = new Map<string, Promise<{ agentId: string | null; barrado: boolean }>>();
  const decidirAgente = (
    orgId: string,
    pointerId: string,
    pedeAgente: boolean,
  ): Promise<{ agentId: string | null; barrado: boolean }> => {
    const key = `${orgId}:${pointerId}:${pedeAgente ? "1" : "0"}`;
    let hit = agentCache.get(key);
    if (!hit) {
      hit = decidirAgenteDoEnrollmentAutomatico(gateDb, orgId, pointerId, pedeAgente);
      agentCache.set(key, hit);
    }
    return hit;
  };

  for (const pointer of pointers) {
    try {
      const trigger = await db.loadTriggerNode(pointer.organization_id, pointer.active_version_id);
      if (!trigger) continue;

      const { agentId, barrado } = await decidirAgente(
        pointer.organization_id,
        pointer.id,
        trigger.pedeAgente,
      );
      if (barrado) {
        summary.pointers_gated_out++;
        continue;
      }

      const cutoffIso = new Date(clock().getTime() - pointer.threshold_minutes * 60_000).toISOString();
      const desdeIso =
        pointer.max_silence_minutes && pointer.max_silence_minutes > pointer.threshold_minutes
          ? new Date(clock().getTime() - pointer.max_silence_minutes * 60_000).toISOString()
          : undefined;
      const contactIds = await db.loadSilentContactIds(pointer.organization_id, cutoffIso, pointer.segments, desdeIso);
      if (contactIds.length === 0) continue;

      const emCooldown = await db.loadContactIdsEmCooldown(
        pointer.organization_id,
        pointer.id,
        contactIds,
        cutoffIso,
      );
      const nextEvalAt = clock().toISOString();
      const comRetorno = await db.loadContatosComRetornoVivo(
        pointer.organization_id,
        folgaDepoisDoRetorno(pointer.threshold_minutes),
      );
      const pausaMinutos = pointer.reentry_pause_minutes ?? 0;
      const encerramentos =
        pausaMinutos > 0
          ? await db.loadEncerramentosDoFluxo(pointer.organization_id, pointer.id, contactIds)
          : new Map<string, FatosDaReentrada>();
      const comPessoa =
        pointer.handoff_policy !== "allow"
          ? await db.loadContatosComPessoaNoComando(pointer.organization_id, contactIds)
          : new Set<string>();
      // Falha FECHADA de propósito: sem o método no adapter (falso de teste), o
      // `??` trata todo mundo como não respondido e ninguém é inscrito. Ver o
      // contrato de `loadContatosSemRespostaDaEquipe`.
      const semRespostaDaEquipe = pointer.exige_resposta_da_equipe
        ? (await db.loadContatosSemRespostaDaEquipe?.(pointer.organization_id, contactIds)) ??
          new Set<string>(contactIds)
        : new Set<string>();
      // #3720: "a resposta dele foi reação à minha automática" — o fluxo de
      // silêncio não é a resposta certa para quem só agradeceu o parabéns.
      // Ausência do método = comportamento de sempre (ver o contrato).
      const soResponderamAAutomacao =
        (await db.loadContatosQueSoResponderamAAutomacao?.(pointer.organization_id, contactIds)) ??
        new Set<string>();
      // Teto de repetições: a pausa só ESPAÇA, e quem nunca responde segue
      // elegível para sempre. Falha FECHADA como a guarda de resposta — mapa
      // vazio aqui leria como "ninguém repetiu", que é o oposto do seguro.
      const teto = pointer.max_enrollments_por_contato ?? 0;
      const repeticoes =
        teto > 0
          ? ((await db.loadContagemDeInscricoes?.(pointer.organization_id, pointer.id, contactIds)) ??
            new Map(contactIds.map((id) => [id, teto])))
          : new Map<string, number>();
      const comInscricaoViva = await db.loadContatosComInscricaoViva(pointer.organization_id, contactIds);

      for (const contactId of contactIds) {
        if (comRetorno.has(contactId)) {
          summary.skipped_pending_return++;
          continue;
        }
        if (comPessoa.has(contactId)) {
          summary.skipped_human_owned++;
          continue;
        }
        // Antes do cooldown: não é throttle de tempo, é "este contato nunca
        // devia ter sido considerado". A dívida é NOSSA, não dele.
        if (semRespostaDaEquipe.has(contactId)) {
          summary.skipped_sem_resposta_da_equipe++;
          continue;
        }
        // #3720, e antes do cooldown/teto pela mesma razão do anterior: não é
        // throttle de tempo, é "este contato nunca devia ter sido considerado".
        // A mensagem dele existe porque a NOSSA existiu primeiro.
        if (soResponderamAAutomacao.has(contactId)) {
          summary.skipped_resposta_a_automacao++;
          continue;
        }
        if (teto > 0 && (repeticoes.get(contactId) ?? 0) >= teto) {
          summary.skipped_teto_de_repeticoes++;
          continue;
        }
        if (emCooldown.has(contactId)) {
          summary.skipped_cooldown++;
          continue;
        }
        if (emPausaDeReentrada(encerramentos.get(contactId), pausaMinutos, clock(), pointer.reentry_pause_basis)) {
          summary.skipped_reentry_pause++;
          continue;
        }
        // O mesmo contador do 23505: quem já está vivo é `skipped_existing`,
        // só que agora sem a tentativa que o banco recusaria.
        if (comInscricaoViva.has(contactId)) {
          summary.skipped_existing++;
          continue;
        }
        const { inserted } = await db.insertEnrollment({
          organization_id: pointer.organization_id,
          pointer_id: pointer.id,
          version_id: pointer.active_version_id,
          contact_id: contactId,
          current_node_id: trigger.id,
          next_eval_at: nextEvalAt,
          agent_id: agentId,
        });
        if (inserted) summary.enrolled++;
        else summary.skipped_existing++;
      }
    } catch (err) {
      summary.pointers_failed++;
      logger.warn("[silence-sweep] pointer falhou — pulado; os demais seguem", {
        organization_id: pointer.organization_id,
        pointer_id: pointer.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
    }
  }

  return summary;
}

type ContactEmbed =
  | {
      tags: string[] | null;
      is_blocked: boolean | null;
      ai_authorized_at: string | null;
      phone_number: string | null;
      force_human: boolean | null;
      /** A marca permanente "sempre atendimento humano" (issue 2379). */
      ai_opt_out: boolean | null;
    }
  | null;

/** Estados em que a inscrição ACABOU — os que contam para a pausa de reentrada. */
const STATUS_ENCERRADOS = ["completed", "cancelled", "dead"] as const;
/** Lote do `in(contact_id, …)`: a lista vai na URL do PostgREST. */
const LOTE_DE_CONTATOS = 100;
/** Teto de linhas por resposta do PostgREST (`max-rows`); páginas maiores voltam cortadas em silêncio. */
const PAGINA_DE_INSCRICOES = 1000;

/** Production adapter: `SilenceSweepDb` sobre o client service-role real. */
export function createSupabaseSilenceSweepDb(admin: SupabaseClient): SilenceSweepDb {
  const origins = new Map<string, ServiceBoundary>();
  // Fatos da conversa MAIS RECENTE de cada silencioso, lidos na mesma consulta
  // de `loadSilentContactIds` — as duas leituras abaixo não voltam ao banco por eles.
  const ultimaMensagem = new Map<string, number>();
  const pessoaNoComando = new Set<string>();
  const semRespostaDaEquipe = new Set<string>();
  return {
    async loadActiveSilencePointers() {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config, surface, handoff_policy")
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: SilencePointer[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
        surface?: string | null;
        handoff_policy?: string | null;
      }>) {
        // Roteiro de atendimento (0394) é do turno, nunca do relógio: o banco
        // já o prende em gatilho manual, e este corte é a segunda porta.
        if (!row.active_version_id || row.surface === "atendimento") continue;
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "silence") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          threshold_minutes: parsed.data.params.threshold_minutes,
          segments: parsed.data.params.segments ?? [],
          reentry_pause_minutes: parsed.data.params.reentry_pause_minutes ?? 0,
          ...(parsed.data.params.max_silence_minutes ? { max_silence_minutes: parsed.data.params.max_silence_minutes } : {}),
          ...(parsed.data.params.reentry_pause_basis ? { reentry_pause_basis: parsed.data.params.reentry_pause_basis } : {}),
          ...(parsed.data.params.exige_resposta_da_equipe ? { exige_resposta_da_equipe: true } : {}),
          ...(parsed.data.params.max_enrollments_por_contato
            ? { max_enrollments_por_contato: parsed.data.params.max_enrollments_por_contato }
            : {}),
          handoff_policy:
            row.handoff_policy === "allow" || row.handoff_policy === "cancel" ? row.handoff_policy : "pause",
        });
      }
      return pointers;
    },

    async loadSilentContactIds(orgId, cutoffIso, segments, desdeIso) {
      // last_inbound_at é POR CONVERSA; o enrollment é POR CONTATO — reduz
      // client-side pro MAIS RECENTE `last_inbound_at` entre as conversas do
      // contato (um contato com 2+ channel_sessions não pode ser marcado
      // silencioso por causa da conversa mais antiga se a mais nova respondeu).
      //
      // `.not("status", "in", ...)` exclui conversas CLOSED/ARCHIVED — um humano
      // que encerrou a conversa não deveria ver um follow-up automático chegar
      // depois. Sem isto, o sweep contava `last_inbound_at` de QUALQUER
      // conversa, inclusive uma que um humano já fechou de propósito — medido
      // ao desenhar o primeiro fluxo de silêncio real (num tenant de produção): o gatilho
      // só faz sentido enquanto "o fluxo da conversa ainda está ativo".
      const { data, error } = await admin
        .from("conversations")
        .select(
          "id, service_revision, current_demanda_id, demandas!conversations_current_demanda_id_fkey(revision,fechada_em), status, assignee_kind, bot_silenced_until, last_outbound_at, messages!messages_conversation_id_fkey(organization_id,contact_id,conversation_id,service_revision,demanda_id,demanda_revision,sent_at), contact_id, last_inbound_at, contacts:contact_id(tags, is_blocked, ai_authorized_at, phone_number, force_human, ai_opt_out), sessao:channel_session_id(metadata), organizations:organization_id(status, settings)",
        )
        .eq("organization_id", orgId).eq("demandas.organization_id", orgId)
        .eq("contacts.organization_id", orgId).eq("sessao.organization_id", orgId)
        .eq("messages.organization_id", orgId).eq("messages.direction", "inbound")
        .not("messages.service_revision", "is", null)
        .order("sent_at", { referencedTable: "messages", ascending: false })
        .limit(1, { referencedTable: "messages" })
        .not("last_inbound_at", "is", null)
        .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`);
      if (error) throw new Error(error.message);

      type Row = {
        id: string; service_revision: number; current_demanda_id: string | null; demandas: { revision: number; fechada_em: string | null } | null;
        status: string; messages: Array<ServiceBoundary & { sent_at: string }>;
        assignee_kind?: string | null; bot_silenced_until?: string | null;
        contact_id: string;
        last_inbound_at: string;
        last_outbound_at?: string | null;
        contacts: ContactEmbed;
        sessao: { metadata: Record<string, unknown> | null } | null;
        organizations: { status: string | null; settings?: unknown } | null;
      };
      const cutoff = new Date(cutoffIso).getTime();
      const desde = desdeIso ? new Date(desdeIso).getTime() : null;
      const agora = new Date();
      const ttlMs = ttlDaAutorizacaoMs(process.env);
      const latest = new Map<
        string,
        {
          boundary: ServiceBoundary;
          at: number;
          tags: string[];
          blocked: boolean;
          permitidoPeloGate: boolean;
          pessoaNoComando: boolean;
          respondido: boolean;
        }
      >();
      for (const row of (data ?? []) as unknown as Row[]) {
        const source = row.messages?.[0];
        const boundary = parseServiceBoundary(source);
        if (!source || !boundary) continue;
        try {
          assertCurrentServiceBoundary(boundary, { organization_id: orgId, contact_id: row.contact_id,
            conversation_id: row.id, service_revision: row.service_revision, demanda_id: row.current_demanda_id,
            demanda_revision: row.demandas?.revision ?? null, status: row.status, demanda_fechada_em: row.demandas?.fechada_em ?? null });
        } catch { continue; }
        const at = new Date(source.sent_at).getTime();
        const prev = latest.get(row.contact_id);
        if (!prev || at > prev.at) {
          const metadata = row.sessao?.metadata ?? {};
          const acesso = decidirElegibilidade(
            montarEstadoDeElegibilidade({
              orgStatus: row.organizations?.status ?? null,
              canalDesativado: metadata.disabled,
              aiGate: metadata.ai_gate,
              aiGateMode: metadata.ai_gate_mode,
              aiTestPhoneNumbers: metadata.ai_test_phone_numbers,
              contactPhoneNumber: row.contacts?.phone_number ?? null,
              forceHuman: false,
              // A marca PERMANENTE (issue 2379) entra na MESMA decisão: este sweep
              // retoma follow-up de contato em silêncio, e retomar um contato que
              // pediu para ficar com humano é reabrir o atendimento da IA por relógio.
              aiOptOut: row.contacts?.ai_opt_out ?? false,
              assigneeKind: null,
              botSilencedUntil: null,
              aiAuthorizedAt: row.contacts?.ai_authorized_at ?? null,
              contactTags: row.contacts?.tags ?? null,
              orgSettings: row.organizations?.settings,
              agora,
              ttlMs,
            }),
          );
          latest.set(row.contact_id, {
            boundary, at,
            tags: row.contacts?.tags ?? [],
            blocked: row.contacts?.is_blocked ?? false,
            permitidoPeloGate: acesso.permite,
            // Os três vetos que valem sempre no atendimento (`decidirElegibilidade`),
            // lidos à parte: quem decide se barram o fluxo é a política de handoff dele.
            // POR CONVERSA, e é a conversa do inbound vencedor: responder em
            // OUTRA conversa do mesmo contato não quita a última mensagem dele.
            // `Date.parse` de valor inválido é NaN, e `NaN > at` é falso — data
            // estragada lê como "não respondido", nunca como respondido.
            respondido:
              row.last_outbound_at != null && Date.parse(row.last_outbound_at) > at,
            pessoaNoComando:
              row.assignee_kind === "user" ||
              row.contacts?.force_human === true ||
              row.contacts?.ai_opt_out === true ||
              (row.bot_silenced_until != null && Date.parse(row.bot_silenced_until) > agora.getTime()),
          });
        }
      }

      const silentIds: string[] = [];
      for (const [contactId, v] of latest) {
        if (v.blocked) continue;
        // A mesma regra do atendimento de entrada vale antes de criar o
        // enrollment: no pré-go-live só testadores avançam; no allowlist comum
        // continua valendo a autorização temporária da origem.
        if (!v.permitidoPeloGate) continue;
        if (v.at > cutoff) continue; // conversou depois do corte — não é silêncio
        if (desde !== null && v.at < desde) continue; // silêncio antigo demais para este fluxo
        if (segments.length > 0 && !segments.some((s) => v.tags.includes(s))) continue;
        silentIds.push(contactId);
        origins.set(`${orgId}:${contactId}`, v.boundary);
        ultimaMensagem.set(`${orgId}:${contactId}`, v.at);
        if (v.respondido) semRespostaDaEquipe.delete(`${orgId}:${contactId}`);
        else semRespostaDaEquipe.add(`${orgId}:${contactId}`);
        if (v.pessoaNoComando) pessoaNoComando.add(`${orgId}:${contactId}`);
        else pessoaNoComando.delete(`${orgId}:${contactId}`);
      }
      return silentIds;
    },

    async loadEncerramentosDoFluxo(orgId, pointerId, contactIds) {
      const encerradaEm = new Map<string, number>();
      for (let i = 0; i < contactIds.length; i += LOTE_DE_CONTATOS) {
        const { data, error } = await admin
          .from("followup_enrollments")
          .select("contact_id, completed_at, updated_at")
          .eq("organization_id", orgId)
          .eq("pointer_id", pointerId)
          .in("status", [...STATUS_ENCERRADOS])
          .in("contact_id", contactIds.slice(i, i + LOTE_DE_CONTATOS));
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as Array<{ contact_id: string; completed_at: string | null; updated_at: string | null }>) {
          // Nem todo caminho de encerramento grava `completed_at`; o mais tardio dos dois é o fim.
          const fim = Math.max(Date.parse(row.completed_at ?? "") || 0, Date.parse(row.updated_at ?? "") || 0);
          if (fim > (encerradaEm.get(row.contact_id) ?? 0)) encerradaEm.set(row.contact_id, fim);
        }
      }
      const fatos = new Map<string, FatosDaReentrada>();
      for (const [contactId, fim] of encerradaEm) {
        fatos.set(contactId, { encerradaEm: fim, ultimaMensagemEm: ultimaMensagem.get(`${orgId}:${contactId}`) ?? null });
      }
      return fatos;
    },

    async loadContatosComPessoaNoComando(orgId, contactIds) {
      return new Set(contactIds.filter((id) => pessoaNoComando.has(`${orgId}:${id}`)));
    },

    async loadContatosSemRespostaDaEquipe(orgId, contactIds) {
      return new Set(contactIds.filter((id) => semRespostaDaEquipe.has(`${orgId}:${id}`)));
    },

    async loadContatosQueSoResponderamAAutomacao(orgId, contactIds) {
      // Os dois fatos que a consulta precisa já estão aqui, colhidos na MESMA
      // leitura que decidiu o silêncio (`loadSilentContactIds`): a conversa do
      // inbound vencedor (`origins`) e o instante dele (`ultimaMensagem`).
      const candidatos: CandidatoDoSilencio[] = [];
      for (const contactId of contactIds) {
        const boundary = origins.get(`${orgId}:${contactId}`);
        const inboundAt = ultimaMensagem.get(`${orgId}:${contactId}`);
        if (!boundary || inboundAt === undefined) continue;
        candidatos.push({
          contactId,
          conversationId: boundary.conversation_id,
          inboundAt: new Date(inboundAt).toISOString(),
        });
      }
      return contatosQueSoResponderamAAutomacao(admin, orgId, candidatos);
    },

    async loadContagemDeInscricoes(orgId, pointerId, contactIds) {
      // Conta TODAS as inscrições, de qualquer status: o teto é "quantas vezes
      // este fluxo já falou com esta pessoa", e uma tentativa cancelada no meio
      // também gastou a vez. O índice
      // `(organization_id, pointer_id, contact_id, updated_at)` serve a consulta.
      //
      // PAGINADO: o PostgREST corta a resposta em 1000 linhas sem erro. Sem
      // páginas, 100 contatos com 11+ inscrições cada (quem está em laço há
      // meses) eram contados pela metade e o teto falhava ABERTO justo para eles.
      const contagem = new Map<string, number>();
      for (let i = 0; i < contactIds.length; i += LOTE_DE_CONTATOS) {
        for (let de = 0; ; de += PAGINA_DE_INSCRICOES) {
          const { data, error } = await admin
            .from("followup_enrollments")
            .select("contact_id")
            .eq("organization_id", orgId)
            .eq("pointer_id", pointerId)
            .in("contact_id", contactIds.slice(i, i + LOTE_DE_CONTATOS))
            .order("id")
            .range(de, de + PAGINA_DE_INSCRICOES - 1);
          if (error) throw new Error(error.message);
          const linhas = (data ?? []) as Array<{ contact_id: string }>;
          for (const row of linhas) {
            contagem.set(row.contact_id, (contagem.get(row.contact_id) ?? 0) + 1);
          }
          if (linhas.length < PAGINA_DE_INSCRICOES) break;
        }
      }
      return contagem;
    },

    async loadContatosComInscricaoViva(orgId, contactIds) {
      const vivos = new Set<string>();
      for (let i = 0; i < contactIds.length; i += LOTE_DE_CONTATOS) {
        const { data, error } = await admin
          .from("followup_enrollments")
          .select("contact_id")
          .eq("organization_id", orgId)
          .in("status", [...STATUS_VIVOS])
          .in("contact_id", contactIds.slice(i, i + LOTE_DE_CONTATOS));
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as Array<{ contact_id: string }>) vivos.add(row.contact_id);
      }
      return vivos;
    },

    loadContatosComRetornoVivo(orgId, folgaMs) {
      return contatosQueORetornoSegura(admin, orgId, folgaMs);
    },

    async loadTriggerNode(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return noDeGatilhoDoGrafo(flowGraphSchema.parse(data.graph));
    },

    async loadContactIdsEmCooldown(orgId, pointerId, contactIds, cutoffIso) {
      if (contactIds.length === 0) return new Set();
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("contact_id")
        .eq("organization_id", orgId)
        .eq("pointer_id", pointerId)
        .in("contact_id", contactIds)
        .not("status", "in", `(${STATUS_VIVOS.join(",")})`)
        .gte("updated_at", cutoffIso);
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((row: { contact_id: string }) => row.contact_id));
    },

    async insertEnrollment(input) {
      // 23505 aqui agora é o índice ORG-WIDE (organization_id, contact_id) —
      // um contato já vivo em QUALQUER fluxo da org barra este insert (Task
      // 8.6: 1 follow-up vivo por lead). Vira skip silencioso, nunca erro.
      const boundary = origins.get(`${input.organization_id}:${input.contact_id}`);
      if (!boundary) return { inserted: false };
      try { await assertServiceBoundarySupabase(admin, boundary); } catch (error) {
        if (error instanceof StaleServiceBoundaryError) return { inserted: false }; throw error;
      }
      const protection=(await protecaoAgendaSupabase(admin,input.organization_id,[input.contact_id])).get(input.contact_id);
      if(protection?.motivo==="leitura_indisponivel") throw new Error("agenda_read_failed");
      if(protection?.adiar) return {inserted:false};
      const { error } = await admin.from("followup_enrollments").insert({ ...input, conversation_id: boundary.conversation_id, service_boundary: boundary });
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },
  };
}

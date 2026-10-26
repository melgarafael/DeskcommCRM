/**
 * O handler `scheduled_message` do worker: a hora chegou, manda o pacote.
 *
 * O cron persistente já resolveu o que era difícil (trava do claim, one-shot que
 * desliga depois de disparar, backoff do disparo). O que este arquivo faz é o
 * outro lado: pegar o pacote, conferir as travas que o envio já respeita, mandar
 * as partes na ordem e deixar o ESTADO certo quando alguma coisa impede.
 *
 * ─── As três invariantes que este handler existe para cumprir ──────────────
 *
 *  1. **Nunca duplicar.** A reserva é um UPDATE condicional
 *     (`scheduled → sending`); 0 linhas significa que já saiu ou foi cancelado,
 *     e o handler sai sem fazer nada. Cada parte carrega `internal_message_id`,
 *     que vira `messages.id` no envio — repetir a parte relê a mensagem e não
 *     reenvia.
 *  2. **Parar no meio, com aviso.** A primeira parte que falha vira `failed`, as
 *     seguintes viram `skipped` e o pacote fecha em `partial` (alguma saiu) ou
 *     `failed` (nenhuma). Aviso na Central, para o operador não descobrir sozinho
 *     que só metade chegou.
 *  3. **Nada de estado sem dono.** Sessão fora de `WORKING` ou janela fechada
 *     NÃO viram `queued`/`failed`: o pacote volta para `scheduled` com hora nova,
 *     porque a promessa ainda vale. Só quando as tentativas esgotam ele falha — e
 *     aí com aviso.
 *
 * O acesso ao banco entra por `PacoteDb`, e o envio de UMA parte por
 * `enviarParte`. São duas costuras de propósito: a prova de comportamento roda
 * com dublês explícitos, sem Postgres e sem canal.
 */
import type pg from "pg";

import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  INTERVALO_ENTRE_PARTES_MS,
  MAXIMO_DE_TENTATIVAS,
  desfechoDasPartes,
  esperaDaTentativa,
  motivoLegivel,
  vereditoDoDisparo,
  type FatosDoDisparo,
  type StatusDaParte,
  type StatusDoPacote,
} from "./regras";

export interface ParteDoDisparo {
  id: string;
  position: number;
  body: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  status: StatusDaParte;
  internal_message_id: string;
  message_id: string | null;
}

export interface PacoteDoDisparo {
  id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string;
  created_by: string | null;
  cancel_if_contact_replies: boolean;
  attempts: number;
  parts: ParteDoDisparo[];
}

export interface ResultadoDoEnvioDaParte {
  ok: boolean;
  /** `messages.id` gravado pelo handler de envio. */
  messageId?: string | null;
  /** Motivo curto quando `ok = false` (código do erro do canal, não PII). */
  motivo?: string;
}

export type EnviarParte = (args: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  channelSessionId: string;
  /** Autor humano do agendamento, quando existe — decide `sent_via`. */
  autor: string | null;
  parte: ParteDoDisparo;
}) => Promise<ResultadoDoEnvioDaParte>;

/**
 * O banco, na forma que o handler precisa. Implementado em `./pg.ts` (worker) e
 * dublado nos testes.
 */
export interface PacoteDb {
  /** `scheduled → sending`. `false` = já foi, já saiu ou foi cancelado. */
  reserva(organizationId: string, pacoteId: string): Promise<boolean>;
  carrega(organizationId: string, pacoteId: string): Promise<PacoteDoDisparo | null>;
  fatos(organizationId: string, pacote: PacoteDoDisparo): Promise<FatosDoDisparo>;
  marcaParteEnviada(args: {
    organizationId: string;
    parteId: string;
    messageId: string | null;
    quando: Date;
  }): Promise<void>;
  marcaParteFalha(args: {
    organizationId: string;
    parteId: string;
    motivo: string;
  }): Promise<void>;
  marcaPartePulada(args: { organizationId: string; parteId: string }): Promise<void>;
  fechaPacote(args: {
    organizationId: string;
    pacoteId: string;
    status: Extract<StatusDoPacote, "sent" | "partial" | "failed">;
    motivo: string | null;
  }): Promise<void>;
  cancelaPacote(args: {
    organizationId: string;
    pacoteId: string;
    motivo: string;
    quando: Date;
  }): Promise<void>;
  /**
   * Devolve o pacote para `scheduled` com hora nova, e rearma o cron dele. É o
   * desfecho que mantém a promessa viva quando o número não está pronto.
   */
  devolveParaAgenda(args: {
    organizationId: string;
    pacoteId: string;
    quando: Date;
    motivo: string;
    tentativas: number;
  }): Promise<void>;
  desligaCronDoPacote(organizationId: string, pacoteId: string): Promise<void>;
  avisaNaCentral(args: {
    organizationId: string;
    pacoteId: string;
    titulo: string;
    corpo: string;
  }): Promise<void>;
}

export interface DepsDoDisparo {
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void };
  enviarParte: EnviarParte;
  /** Clock injetável. */
  agora?: () => Date;
  /** Espera entre partes — injetável para o teste não dormir 3 s. */
  dormir?: (ms: number) => Promise<void>;
  /** Janela do número: ISO da próxima abertura, ou `null` se está aberta. */
  janelaReabreEm?: (args: {
    organizationId: string;
    channelSessionId: string;
    agora: Date;
  }) => Promise<string | null>;
  /** Substitui o adaptador de banco (testes). */
  db?: PacoteDb;
}

function idDoPayload(payload: Record<string, unknown>): string | null {
  const valor = payload.scheduled_message_id;
  return typeof valor === "string" && valor !== "" ? valor : null;
}

const dormirDeVerdade = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Handler do worker. Assinatura igual à dos outros (`job`, `pool`), porque
 * `main.ts` registra por `kind` num `Map<JobKind, JobHandler>`.
 */
export function createScheduledMessageHandler(
  deps: DepsDoDisparo,
  dbDoPool: (pool: pg.Pool) => PacoteDb,
) {
  return async (job: JobRow, pool: pg.Pool): Promise<void> => {
    if (job.kind !== "scheduled_message") {
      throw new Error(`handler scheduled_message recebeu kind=${job.kind}`);
    }
    const pacoteId = idDoPayload(job.payload);
    if (pacoteId === null) {
      throw new Error("job scheduled_message sem payload.scheduled_message_id");
    }

    const db = deps.db ?? dbDoPool(pool);
    const agora = deps.agora?.() ?? new Date();
    const log = deps.log;

    // ── 1. Reserva ─────────────────────────────────────────────────────────
    const reservado = await db.reserva(job.organization_id, pacoteId);
    if (!reservado) {
      // Já saiu, já está saindo nesta mesma hora, ou foi cancelado: nos três
      // casos o trabalho está feito — sair em silêncio é o certo.
      log.info("mensagem agendada: pacote já reservado/encerrado, nada a fazer", {
        pacote_id: pacoteId,
      });
      return;
    }

    const pacote = await db.carrega(job.organization_id, pacoteId);
    if (pacote === null) {
      log.warn("mensagem agendada: pacote reservado mas não encontrado", { pacote_id: pacoteId });
      return;
    }

    const avisa = async (titulo: string, corpo: string): Promise<void> => {
      try {
        await db.avisaNaCentral({
          organizationId: job.organization_id,
          pacoteId,
          titulo,
          corpo,
        });
      } catch (err) {
        // Aviso é best-effort: o estado do pacote já conta a história, e
        // derrubar o job aqui faria o cron re-disparar um envio já feito.
        log.warn("mensagem agendada: aviso na Central falhou", {
          pacote_id: pacoteId,
          erro: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const falha = async (motivo: string, texto: string): Promise<void> => {
      await db.fechaPacote({
        organizationId: job.organization_id,
        pacoteId,
        status: "failed",
        motivo,
      });
      await db.desligaCronDoPacote(job.organization_id, pacoteId);
      await avisa("Mensagem agendada não foi enviada", texto);
    };

    // ── 2. Travas ─────────────────────────────────────────────────────────
    const fatos = await db.fatos(job.organization_id, pacote);

    if (fatos.janelaReabreEm === null) {
      // A janela do número é a mesma régua que a automação usa
      // (`lib/automation/janela-do-canal.ts`), injetada aqui para o teste
      // poder fechá-la sem banco.
      const reabre = deps.janelaReabreEm
        ? await deps.janelaReabreEm({
            organizationId: job.organization_id,
            channelSessionId: pacote.channel_session_id,
            agora,
          })
        : await adiarAteAJanelaAbrir(
            createAdminClient(),
            job.organization_id,
            pacote.channel_session_id,
            agora,
          );
      fatos.janelaReabreEm = reabre === null ? null : new Date(reabre);
    }

    const veredito = vereditoDoDisparo(
      fatos,
      { cancelarSeResponder: pacote.cancel_if_contact_replies },
      agora,
    );

    if (veredito.acao === "cancelar") {
      await db.cancelaPacote({
        organizationId: job.organization_id,
        pacoteId,
        motivo: veredito.motivo,
        quando: agora,
      });
      await db.desligaCronDoPacote(job.organization_id, pacoteId);
      log.info("mensagem agendada: cancelada antes do envio", {
        pacote_id: pacoteId,
        motivo: veredito.motivo,
      });
      return;
    }

    if (veredito.acao === "falhar") {
      await falha(veredito.motivo, motivoLegivel(veredito.motivo));
      return;
    }

    if (veredito.acao === "reagendar") {
      const tentativas = pacote.attempts + 1;
      if (tentativas > MAXIMO_DE_TENTATIVAS) {
        await falha(
          "tentativas_esgotadas",
          `${motivoLegivel(veredito.motivo)} Tentativas esgotadas (${MAXIMO_DE_TENTATIVAS}).`,
        );
        return;
      }
      const quando = veredito.motivo === "fora_da_janela" ? veredito.para : new Date(agora.getTime() + esperaDaTentativa(tentativas));
      await db.devolveParaAgenda({
        organizationId: job.organization_id,
        pacoteId,
        quando,
        motivo: veredito.motivo,
        tentativas,
      });
      log.info("mensagem agendada: reagendada", {
        pacote_id: pacoteId,
        motivo: veredito.motivo,
        tentativa: tentativas,
        quando: quando.toISOString(),
      });
      return;
    }

    // ── 3. Envio das partes, na ordem ─────────────────────────────────────
    const sleep = deps.dormir ?? dormirDeVerdade;
    const pendentes = pacote.parts
      .filter((parte) => parte.status === "pending")
      .sort((a, b) => a.position - b.position);

    let ultimaFalha: { motivo: string; posicao: number } | null = null;

    for (const [indice, parte] of pendentes.entries()) {
      if (indice > 0) {
        // Intervalo entre balões do MESMO pacote: curto, mas existe — o cliente
        // lê na ordem em que chegam, e o canal não recebe rajada.
        await sleep(INTERVALO_ENTRE_PARTES_MS);
      }

      let resultado: ResultadoDoEnvioDaParte;
      try {
        resultado = await deps.enviarParte({
          organizationId: job.organization_id,
          conversationId: pacote.conversation_id,
          contactId: pacote.contact_id,
          channelSessionId: pacote.channel_session_id,
          autor: pacote.created_by,
          parte,
        });
      } catch (err) {
        resultado = {
          ok: false,
          motivo: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        };
      }

      if (!resultado.ok) {
        ultimaFalha = {
          motivo: resultado.motivo ?? "canal_nao_confirmou",
          posicao: parte.position,
        };
        await db.marcaParteFalha({
          organizationId: job.organization_id,
          parteId: parte.id,
          motivo: ultimaFalha.motivo,
        });
        break;
      }

      await db.marcaParteEnviada({
        organizationId: job.organization_id,
        parteId: parte.id,
        messageId: resultado.messageId ?? null,
        quando: agora,
      });
    }

    // ── 4. Parou no meio, para o resto ────────────────────────────────────
    const partesAtualizadas: ParteDoDisparo[] = pacote.parts.map((parte) => {
      if (ultimaFalha === null) return parte;
      if (parte.status !== "pending") return parte;
      if (parte.position === ultimaFalha.posicao) return { ...parte, status: "failed" };
      if (parte.position > ultimaFalha.posicao) return { ...parte, status: "skipped" };
      return parte;
    });

    if (ultimaFalha !== null) {
      const puladas = partesAtualizadas.filter(
        (parte, indice) =>
          parte.status === "skipped" && pacote.parts[indice]?.status === "pending",
      );
      for (const parte of puladas) {
        await db.marcaPartePulada({ organizationId: job.organization_id, parteId: parte.id });
      }
      const desfecho = desfechoDasPartes(partesAtualizadas);
      const status = desfecho === "sent" ? "partial" : desfecho;
      await db.fechaPacote({
        organizationId: job.organization_id,
        pacoteId,
        status,
        motivo: ultimaFalha.motivo,
      });
      await db.desligaCronDoPacote(job.organization_id, pacoteId);
      await avisa(
        status === "partial"
          ? "Mensagem agendada saiu pela metade"
          : "Mensagem agendada não foi enviada",
        status === "partial"
          ? `A parte ${ultimaFalha.posicao + 1} não saiu (${ultimaFalha.motivo}) e as seguintes não foram enviadas. Use "Reenviar o que faltou".`
          : `A parte ${ultimaFalha.posicao + 1} não saiu (${ultimaFalha.motivo}).`,
      );
      log.warn("mensagem agendada: envio interrompido", {
        pacote_id: pacoteId,
        parte: ultimaFalha.posicao,
        motivo: ultimaFalha.motivo,
        status,
      });
      return;
    }

    // ── 5. Fim ────────────────────────────────────────────────────────────
    const desfecho = desfechoDasPartes(partesAtualizadas.map((parte) => ({ status: parte.status })));
    if (desfecho === "sent") {
      await db.fechaPacote({
        organizationId: job.organization_id,
        pacoteId,
        status: "sent",
        motivo: null,
      });
      await db.desligaCronDoPacote(job.organization_id, pacoteId);
      log.info("mensagem agendada: enviada", { pacote_id: pacoteId, partes: partesAtualizadas.length });
      return;
    }

    // Sem falha registrada e sem todas enviadas só acontece quando os dublês (ou
    // uma parte que já estava `skipped`) devolvem um pacote sem pendentes.
    await db.fechaPacote({
      organizationId: job.organization_id,
      pacoteId,
      status: desfecho,
      motivo: "nada_pendente",
    });
    await db.desligaCronDoPacote(job.organization_id, pacoteId);
  };
}

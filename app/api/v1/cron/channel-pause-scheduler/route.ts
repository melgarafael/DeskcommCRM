/**
 * channel-pause-scheduler — a janela de manutenção pausa sozinha e RETOMA sozinha.
 *
 * ─── O defeito (issue #2388) ────────────────────────────────────────────────
 *
 * A pausa de conexão existe só como ação manual imediata: um clique em
 * `metadata.disabled` pela Central (RPC da 0545) e ninguém volta para desfazer.
 * Para uma janela de manutenção isso é "alguém acorda às 3h para clicar" — ou o
 * número fica pausado até segunda ordem, e a entrega é gravada e some da inbox
 * em silêncio.
 *
 * ─── Por que esta rota, e não um campo na outra ──────────────────────────────
 *
 * A janela é UM registro (`channel_schedules`), não um estado embutido na
 * conexão: pausa-se um canal ou a organização inteira, a janela tem autor,
 * horário, estado e a lista do que ela mesma pausou. A escrita é a MESMA da
 * pausa manual — `fn_definir_pausa_de_canal`, a peça da qual
 * `fn_definir_canal_desativado` delega — então não existe estado paralelo nem
 * segunda forma de desligar: uma só chave (`disabled`) escreve nos dois caminhos.
 *
 * ─── A régua de quem volta (critério 3) ──────────────────────────────────────
 *
 * No fim da janela, quem volta é SÓ o que ESTA agenda pausou:
 * `canalElegivelParaRetomada` exige `disabled_by = 'schedule'` e
 * `disabled_schedule_id = id da agenda`. Quem o operador pausou com a janela
 * aberta (ou antes dela) fica pausado — a mão do humano não é sobrescrita pelo
 * relógio. Ausência de origem (chave anterior) também não elegibiliza: o
 * desconhecido não é retomado às cegas.
 *
 * Janelas sobrepostas no mesmo canal: a que abre com o canal já pausado não
 * toma posse dele, então o fim da primeira NÃO o religa enquanto outra janela
 * aberta o cobrir — passa a posse a ela (`janelaQueHerdaAPausa`), e é o fim
 * da última que retoma.
 *
 * ─── O aviso da Central acompanha (#2389) ───────────────────────────────────
 *
 * Pausar e retomar daqui chama `sincronizarAvisoDePausa`, como a pausa manual:
 * o aviso "canal pausado" abre quando a janela pausa e fecha quando ela
 * retoma. Na passagem de posse entre janelas nada muda no canal, e o aviso
 * fica como está.
 *
 * ─── Mensagem nenhuma se perde durante a pausa (critério 1) ──────────────────
 *
 * Pausar aqui É o `disabled` de hoje: o webhook de entrada do canal continua gravando
 * mensagem de entrada na inbox e ela volta à fila na retomada (a lei do #2318 —
 * "nada do que foi recebido se perde por causa da pausa" — é a mesma). Nesta
 * rota não existe nenhuma chamada de rede, muito menos parar/retomar sessão de
 * transporte: ela toca banco e mais nada.
 *
 * ─── Relógio injetado, idempotência e concorrência (critério 2) ──────────────
 *
 * `aplicarAgendas(db, agora)` recebe o instante de quem chama (a rota passa
 * `new Date()`; o teste passa instantes fixos — nunca `sleep`). Cada transição
 * de estado é um `update` filtrado pelo status esperado (claim): duas batidas
 * simultâneas (cron + `curl` à mão, duas instâncias) não aplicam duas vezes —
 * só uma "ganha" a linha.
 *
 * ─── Janela que passou inteira (critério 4) ──────────────────────────────────
 *
 * Se o cron caiu a janela toda, o próximo acorde NÃO pausa para o passado:
 * `acaoDaAgenda` devolve `expirada`, a rota só encerra a linha (recuperando o
 * que tenha ficado pausado numa falha parcial) e o relatório diz quantas foram.
 *
 * ─── Organização parada (cerca `cron-respeita-org-operante`) ─────────────────
 *
 * Suspensa não gasta nem fala: `idsDeOrgsParadas` é filtro real e não
 * "não deu erro" — o passe é filtrar, contar e seguir.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  acaoDaAgenda,
  canalElegivelParaPausa,
  canalElegivelParaRetomada,
  janelaQueHerdaAPausa,
  type AgendaDePausa,
} from "@/lib/channels/agenda-de-pausa";
import { sincronizarAvisoDePausa } from "@/lib/channels/central-de-pausa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";

export const dynamic = "force-dynamic";

/** Só as situações vivas por batida: uma instalação real tem poucas janelas por dia. */
const LIMITE_AGENDAS = 200;
/**
 * Teto de canais alcançados por batida no escopo "toda a organização". Passar
 * disso é declarado, não esquecido: a agenda deixa de ser aplicada por completo
 * e a batida seguinte tenta o resto (quem já foi pausado não é pausado de novo).
 */
const LIMITE_CANAIS = 1000;

export type ResumoDaRodada = {
  avaliadas: number;
  pausadas: number;
  retomadas: number;
  /** Canais que seguem pausados porque outra janela aberta herdou a pausa. */
  transferidas: number;
  /** Janelas que passaram a `running` (a pausa foi aplicada por inteiro). */
  iniciadas: number;
  encerradas: number;
  expiradas: number;
  semMudanca: number;
  falhas: number;
};

type AgendaDaTabela = AgendaDePausa & {
  id: string;
  organization_id: string;
  channel_session_id: string | null;
  paused_channel_ids: string[] | null;
  created_by: string | null;
};

type CanalAlvo = { id: string; metadata: unknown };

/**
 * Quem a Central nomeia como autor da pausa/retomada programada. O aviso
 * "canal pausado" (#2389) nasce e morre pela MESMA chave `disabled` que este
 * cron escreve — se ele não sincronizasse, a pausa da madrugada ficaria
 * invisível para quem não agendou, e a retomada deixaria o aviso aberto.
 */
const AUTOR_DA_JANELA = "a janela de manutenção agendada";

async function canaisDaAgenda(db: SupabaseClient, agenda: AgendaDaTabela): Promise<CanalAlvo[]> {
  let consulta = db
    .from("channel_sessions")
    .select("id, metadata")
    .eq("organization_id", agenda.organization_id)
    .is("archived_at", null);
  if (agenda.channel_session_id) consulta = consulta.eq("id", agenda.channel_session_id);
  const { data, error } = await consulta.limit(LIMITE_CANAIS);
  if (error) throw new Error(`leitura das conexões: ${error.message}`);
  return (data ?? []) as CanalAlvo[];
}

/**
 * Claim: só escreve quem ainda enxerga o status esperado. `false` = outra
 * batida chegou primeiro (não é erro, é corrida perdida com honestidade).
 * Erro de banco LANÇA — quem chama decide (a rota responde 500 e o cron tenta
 * na batida seguinte; nada aqui finge sucesso em silêncio).
 */
async function marcar(
  db: SupabaseClient,
  agenda: AgendaDaTabela,
  patch: Record<string, unknown>,
  statusEsperado: string,
  agora: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("channel_schedules")
    .update({ ...patch, updated_at: agora.toISOString() })
    .eq("id", agenda.id)
    .eq("status", statusEsperado)
    .select("id");
  if (error) throw new Error(`escrita da agenda ${agenda.id}: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}

/** Uma linha da trilha: uma por canal que ESTA janela pausou ou retomou. */
type Rastro = Parameters<typeof audit>[0];

async function pausarAgenda(
  db: SupabaseClient,
  agenda: AgendaDaTabela,
  agora: Date,
  requestId: string,
): Promise<{ pausadas: number; falhas: number; ids: string[] }> {
  const canais = await canaisDaAgenda(db, agenda);
  const ids: string[] = [];
  const trilha: Rastro[] = [];
  let pausadas = 0;
  let falhas = 0;

  for (const canal of canais) {
    // Só quem está LIGADO: quem já está pausado (à mão ou por outra janela)
    // não muda de dono — é por isso que a agenda não toma posse de uma pausa
    // manual anterior (critério 3).
    if (!canalElegivelParaPausa(canal.metadata)) continue;
    const { data, error } = await db.rpc("fn_definir_pausa_de_canal", {
      p_org: agenda.organization_id,
      p_canal: canal.id,
      p_desativado: true,
      p_origem: "schedule",
      p_agenda: agenda.id,
    });
    if (error || data !== 1) {
      falhas++;
      logger.error("[channel-pause-scheduler] pausa recusada", {
        detail: error?.message ?? "canal não existe ou foi arquivado na corrida",
        canal: canal.id,
        requestId,
      });
      continue;
    }
    pausadas++;
    ids.push(canal.id);
    // Best-effort e nunca lança: a pausa já foi gravada pela RPC.
    await sincronizarAvisoDePausa(
      db,
      { id: canal.id, organization_id: agenda.organization_id },
      { autor: AUTOR_DA_JANELA, agora },
    );
    // Quem/ quando/ por qual janela: o autor da agenda (quem clicou em Agendar)
    // vem junto em `agendado_por`, e a ação é a MESMA da pausa manual.
    trilha.push({
      action: "channel.disabled",
      organizationId: agenda.organization_id,
      resourceType: "channel_session",
      resourceId: canal.id,
      metadata: {
        disabled: true,
        origem: "schedule",
        agenda_id: agenda.id,
        agendado_por: agenda.created_by,
      },
      bypassedRls: true,
      requestId,
    });
  }

  // Batida que não pausou nada não ocupa linha na trilha — cerca
  // `cron-audita-so-quando-ha-efeito`: um cron de minuto em minuto que audita
  // sempre grava ~43.200 linhas/mês numa instalação parada.
  if (trilha.length > 0) {
    for (const rastro of trilha) void audit(rastro);
  }

  return { pausadas, falhas, ids };
}

async function retomarAgenda(
  db: SupabaseClient,
  agenda: AgendaDaTabela,
  vivas: readonly AgendaDaTabela[],
  agora: Date,
  requestId: string,
): Promise<{ retomadas: number; transferidas: number; falhas: number }> {
  const canais = await canaisDaAgenda(db, agenda);
  const trilha: Rastro[] = [];
  let retomadas = 0;
  let transferidas = 0;
  let falhas = 0;

  for (const canal of canais) {
    // A régua: pausado ESTA janela, e ainda pausado. Manual fica.
    if (!canalElegivelParaRetomada(canal.metadata, agenda.id)) continue;
    // Outra janela aberta cobre o canal: ele segue pausado e a posse passa a
    // ela — é o fim DELA que retoma. Mesma escrita, só muda a agenda de origem.
    const herdeira = janelaQueHerdaAPausa(agenda, canal.id, vivas, agora);
    const { data, error } = await db.rpc("fn_definir_pausa_de_canal", {
      p_org: agenda.organization_id,
      p_canal: canal.id,
      p_desativado: herdeira !== undefined,
      p_origem: "schedule",
      p_agenda: herdeira?.id ?? agenda.id,
    });
    if (error || data !== 1) {
      falhas++;
      logger.error("[channel-pause-scheduler] retomada recusada", {
        detail: error?.message ?? "canal não existe ou foi arquivado na corrida",
        canal: canal.id,
        requestId,
      });
      continue;
    }
    if (herdeira) {
      transferidas++;
      continue;
    }
    retomadas++;
    await sincronizarAvisoDePausa(
      db,
      { id: canal.id, organization_id: agenda.organization_id },
      { autor: AUTOR_DA_JANELA, agora },
    );
    trilha.push({
      action: "channel.enabled",
      organizationId: agenda.organization_id,
      resourceType: "channel_session",
      resourceId: canal.id,
      metadata: {
        disabled: false,
        origem: "schedule",
        agenda_id: agenda.id,
        agendado_por: agenda.created_by,
      },
      bypassedRls: true,
      requestId,
    });
  }

  // Mesma régua da pausa: só o que deu efeito deixa rastro.
  if (trilha.length > 0) {
    for (const rastro of trilha) void audit(rastro);
  }

  return { retomadas, transferidas, falhas };
}

/**
 * Uma batida inteira. `agora` é INJETADO: o cron passa `new Date()`, o teste
 * passa instantes fixos — a fronteira do fim de janela é provada sem dormir.
 * Qualquer erro de leitura/escrita LANÇA (a rota vira 500 e o cron tenta de
 * novo); nada é engolido com `catch` silencioso.
 */
export async function aplicarAgendas(
  db: SupabaseClient,
  agora: Date,
  requestId: string = randomUUID(),
): Promise<ResumoDaRodada> {
  const resumo: ResumoDaRodada = {
    avaliadas: 0,
    pausadas: 0,
    retomadas: 0,
    transferidas: 0,
    iniciadas: 0,
    encerradas: 0,
    expiradas: 0,
    semMudanca: 0,
    falhas: 0,
  };

  const paradas = new Set(await idsDeOrgsParadas(db));

  const { data, error } = await db
    .from("channel_schedules")
    .select(
      "id, organization_id, channel_session_id, starts_at, ends_at, status, paused_channel_ids, created_by",
    )
    .in("status", ["scheduled", "running"])
    // Já começou (ou já está rodando): o que ainda espera o início não é lido.
    .lte("starts_at", agora.toISOString())
    .limit(LIMITE_AGENDAS);
  if (error) throw new Error(`leitura da agenda: ${error.message}`);

  const vivas = (data ?? []) as AgendaDaTabela[];
  for (const agenda of vivas) {
    // Suspensa não gasta nem fala: a janela dela é ignorada nesta batida.
    if (paradas.has(agenda.organization_id)) {
      resumo.semMudanca++;
      continue;
    }

    resumo.avaliadas++;
    const acao = acaoDaAgenda(agenda, agora);

    if (acao === "aguardando" || acao === "nada") {
      resumo.semMudanca++;
      continue;
    }

    if (acao === "pausar") {
      const { pausadas, falhas, ids } = await pausarAgenda(db, agenda, agora, requestId);
      resumo.pausadas += pausadas;
      resumo.falhas += falhas;
      // Falhou em algum canal: a linha NÃO vira `running`, a batida seguinte
      // tenta o resto (o que já foi pausado não é pausado de novo — elegibilidade).
      if (falhas > 0) continue;
      const reivindicou = await marcar(db, agenda, { status: "running", paused_channel_ids: ids }, "scheduled", agora);
      if (reivindicou) resumo.iniciadas++;
      else resumo.semMudanca++;
      continue;
    }

    if (acao === "expirada") {
      // Janela perdida: não pausa para o passado. Só encerra — e antes, recolhe
      // o que tenha ficado pausado numa falha parcial da própria agenda.
      const { retomadas, transferidas, falhas } = await retomarAgenda(db, agenda, vivas, agora, requestId);
      resumo.retomadas += retomadas;
      resumo.transferidas += transferidas;
      resumo.falhas += falhas;
      if (falhas > 0) continue;
      const reivindicou = await marcar(db, agenda, { status: "done", paused_channel_ids: [] }, "scheduled", agora);
      if (reivindicou) resumo.expiradas++;
      else resumo.semMudanca++;
      continue;
    }

    // acao === "retomar": fim da janela.
    const { retomadas, transferidas, falhas } = await retomarAgenda(db, agenda, vivas, agora, requestId);
    resumo.retomadas += retomadas;
    resumo.transferidas += transferidas;
    resumo.falhas += falhas;
    // Sobrou falha: continua `running` e a batida seguinte retoma o resto.
    if (falhas > 0) continue;
    const reivindicou = await marcar(db, agenda, { status: "done", paused_channel_ids: [] }, "running", agora);
    if (reivindicou) resumo.encerradas++;
    else resumo.semMudanca++;
  }

  return resumo;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const resumo = await aplicarAgendas(createAdminClient(), new Date(), requestId);
    if (resumo.falhas > 0) {
      // Falha de cron é erro à vista, não silêncio: sai no log com o número.
      logger.error("[channel-pause-scheduler] batida com falhas de escrita", {
        detail: `${resumo.falhas} escrita(s) recusada(s); tenta de novo na próxima batida`,
        ...resumo,
        requestId,
      });
    }
    return ok(resumo, { requestId });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.error("[channel-pause-scheduler] batida falhou", { detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

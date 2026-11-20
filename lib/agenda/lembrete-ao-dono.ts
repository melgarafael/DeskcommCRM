/**
 * O LEMBRETE AO DONO — o WhatsApp de quem atende é lembrado ANTES de cada
 * horário, nos mesmos degraus do lembrete do cliente, com o link da reunião.
 *
 * ## Por que existe
 *
 * O aviso de agendamento (`./aviso-de-agendamento.ts`) conta ao dono que um
 * horário foi MARCADO, e o resumo das 7h conta o dia. Nenhum dos dois o avisa
 * 1 hora antes de uma reunião marcada pela IA três dias atrás — e o link do
 * Meet dela estava só no Google Agenda. Quem vende por videochamada perde a
 * reunião assim.
 *
 * ## O que é REAPROVEITADO, e por quê
 *
 * O destino, a conexão e o caminho de envio são os do aviso de agendamento:
 * a mesma configuração (`config_aviso_de_agendamento`, mais `lembrar_antes`),
 * a mesma tabela de entregas (`tipo = 'lembrete'`), o mesmo `entrega_` — canal,
 * transporte, espaçamento do número, teto diário, destino que voltou a ser da
 * organização. Uma segunda versão do anti-ban divergiria no primeiro conserto.
 *
 * Os degraus são os do TIPO de atendimento (`reminder_minutes_before` +
 * `reminder_extra_offsets_minutes`), e só de tipo com lembrete ligado: é UMA
 * configuração para "24 h e 1 h antes", que vale para o cliente e para o dono.
 *
 * ## As garantias
 *
 * - **Sem aviso em dobro.** A entrega é reivindicada ANTES da rede pela chave
 *   única (organização, compromisso, destino, degrau, início). Duas rodadas
 *   concorrentes: uma envia, a outra lê `ja_resolvido`. Vários degraus vencidos
 *   juntos saem como UM (`degrauDoDonoAgora`).
 * - **Remarcação.** O início faz parte da chave: a data nova ganha os próprios
 *   lembretes. O lembrete pendente da data antiga é cancelado. Empurrar a
 *   reunião alguns minutos não gera um segundo aviso logo depois do primeiro
 *   (anti-rajada, a régua do #2249).
 * - **Cancelamento.** Só compromisso `confirmed` é lembrado; o que ficou
 *   pendente de um compromisso cancelado é cancelado na rodada.
 * - **Link pendente.** O lembrete espera o Meet ficar pronto até 15 min antes
 *   do início (`esperaPeloLink`); depois sai sem link, dizendo onde ele está.
 * - **Fuso.** A hora do texto e a madrugada são as do fuso da organização. Na
 *   madrugada (22h–7h) o lembrete NÃO é reivindicado: se ainda estiver na hora
 *   às 7h, sai; se a reunião já passou, o resumo das 7h cobre o dia.
 *
 * NENHUM DESFECHO É `error` (a mesma regra do aviso de agendamento): o cron
 * conta desfechos, e exceção é defeito de programa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { TETO_ABSOLUTO_DE_TENTATIVAS, JANELA_DE_REIVINDICACAO_MS } from "@/lib/escalacao/aviso-ao-suporte";
import { logger } from "@/lib/logger";

import {
  condena,
  destinosDe,
  ehMadrugada,
  entrega_,
  juntaDesfechos,
  type AvisoDeAgendamentoDeps,
  type DesfechoDoAvisoDeAgendamento,
  type DestinoDoAviso,
  type EntregaDeAgendamento,
} from "./aviso-de-agendamento";
import {
  degrauDoDonoAgora,
  esperaPeloLink,
  linkDaReuniao,
  type LembreteJaReivindicado,
} from "./degraus-do-lembrete";
import { montarLembreteAoDono } from "./texto-do-aviso-de-agendamento";
import type { AlvoDaEntregaDeAgendamento } from "./vocabulario-do-aviso-de-agendamento";

/** Maior antecedência aceita pelo tipo (43200 min = 30 dias) — o horizonte da varredura. */
const HORIZONTE_MS = 43_200 * 60_000;
/** Teto de compromissos por organização numa rodada; ordem por início, os próximos primeiro. */
const TETO_POR_RODADA = 100;

/** O compromisso a lembrar, com os degraus do tipo dele. */
export interface CompromissoDoLembrete {
  id: string;
  starts_at: string;
  created_at: string | null;
  starts_at_marked_at: string | null;
  contact_id: string | null;
  event_type_id: string | null;
  title: string | null;
  location_kind: string | null;
  meeting_state: string | null;
  meeting_url: string | null;
  degraus: number[];
}

export interface LembreteAoDonoDb {
  /** `confirmed`, futuros até o horizonte, de tipo com lembrete ligado. */
  compromissosALembrar(orgId: string, agora: Date, ate: Date): Promise<CompromissoDoLembrete[]>;
  /** Os lembretes já reivindicados deste compromisso para ESTE destino, de qualquer data. */
  lembretesDoCompromisso(orgId: string, appointmentId: string, alvo: AlvoDaEntregaDeAgendamento): Promise<LembreteJaReivindicado[]>;
  /** INSERT com a chave única; `criada:false` = já existia (outra rodada ou retomada). */
  reivindicaLembrete(entrada: {
    organizationId: string;
    appointmentId: string;
    alvo: AlvoDaEntregaDeAgendamento;
    destino: string;
    channelSessionId: string;
    degrau: number;
    inicio: string;
  }): Promise<{ criada: boolean; entrega: EntregaDeAgendamento | null }>;
  /**
   * Cancela os lembretes PENDENTES que perderam o objeto: compromisso que não
   * está mais `confirmed`, ou remarcado (início diferente do lembrado).
   * Devolve quantos.
   */
  cancelaLembretesOrfaos(orgId: string): Promise<number>;
}

const skipped = (detail: string): DesfechoDoAvisoDeAgendamento => ({ status: "skipped", detail });

/**
 * Aplica os lembretes ao dono de UMA organização. Chamado pelo cron
 * `app/api/v1/cron/agenda-resumo-do-dia`, a cada 10 minutos.
 */
export async function aplicaLembretesAoDono(
  deps: Omit<AvisoDeAgendamentoDeps, "origemDoDreno">,
  db: LembreteAoDonoDb,
  orgId: string,
): Promise<{ enviados: number; desfechos: Record<string, number> }> {
  const desfechos: Record<string, number> = {};
  const contar = (chave: string) => {
    desfechos[chave] = (desfechos[chave] ?? 0) + 1;
  };
  let enviados = 0;

  const cfg = await deps.db.carregaConfig(orgId);
  const destinos = cfg ? destinosDe(cfg) : [];
  if (!cfg || !cfg.ligado || cfg.lembrar_antes !== true || !cfg.channel_session_id || destinos.length === 0) {
    contar("sem_configuracao");
    return { enviados, desfechos };
  }
  const channelSessionId = cfg.channel_session_id;

  // O laço fecha ANTES de qualquer envio: o que ficou pendente de um horário
  // cancelado ou remarcado não pode sair nesta rodada nem em outra.
  const orfaos = await db.cancelaLembretesOrfaos(orgId);
  if (orfaos > 0) desfechos.cancelados_por_mudanca = orfaos;

  const agora = deps.clock();
  const fuso = await deps.db.fusoDaOrganizacao(orgId);
  if (ehMadrugada(partesNoFuso(agora, fuso).hora)) {
    contar("madrugada");
    return { enviados, desfechos };
  }

  const compromissos = await db.compromissosALembrar(orgId, agora, new Date(agora.getTime() + HORIZONTE_MS));
  for (const c of compromissos.slice(0, TETO_POR_RODADA)) {
    const comeca = new Date(c.starts_at);
    const marcadoEm = c.starts_at_marked_at ? new Date(c.starts_at_marked_at) : c.created_at ? new Date(c.created_at) : null;
    const link = linkDaReuniao(c);

    const porDestino: Array<{ alvo: AlvoDaEntregaDeAgendamento; desfecho: DesfechoDoAvisoDeAgendamento }> = [];
    for (const d of destinos) {
      try {
        const desfecho = await lembraUmDestino(deps, db, {
          ...d,
          orgId,
          channelSessionId,
          fuso,
          agora,
          compromisso: c,
          comeca,
          marcadoEm,
          link,
        });
        porDestino.push({ alvo: d.alvo, desfecho });
      } catch (err) {
        // Um destino que falha não leva os outros nem os próximos compromissos.
        logger.warn("[lembrete-ao-dono] destino falhou", {
          organizationId: orgId,
          alvo: d.alvo,
          causa: err instanceof Error ? err.name : "erro",
        });
        porDestino.push({ alvo: d.alvo, desfecho: skipped("erro_no_destino") });
      }
    }
    if (porDestino.length === 0) continue;
    const junto = juntaDesfechos(porDestino);
    if (junto.status === "ok") enviados += 1;
    contar(`${junto.status}:${(junto.detail ?? "").split(/[:| ]/)[0]}`);
  }
  return { enviados, desfechos };
}

async function lembraUmDestino(
  deps: Omit<AvisoDeAgendamentoDeps, "origemDoDreno">,
  db: LembreteAoDonoDb,
  ctx: DestinoDoAviso & {
    orgId: string;
    channelSessionId: string;
    fuso: string;
    agora: Date;
    compromisso: CompromissoDoLembrete;
    comeca: Date;
    marcadoEm: Date | null;
    link: ReturnType<typeof linkDaReuniao>;
  },
): Promise<DesfechoDoAvisoDeAgendamento> {
  const { orgId, channelSessionId, fuso, agora, compromisso: c, comeca, marcadoEm, link, alvo, destino } = ctx;

  const ja = await db.lembretesDoCompromisso(orgId, c.id, alvo);
  const degrau = degrauDoDonoAgora({ agora, comeca, degraus: c.degraus, marcadoEm, jaReivindicados: ja });
  if (degrau === null) return skipped("ainda_nao");
  // Já resolvido para esta data e este degrau: nem toca o banco de novo.
  const resolvido = ja.find(
    (r) => r.degrau === degrau && Date.parse(r.inicio) === comeca.getTime() && r.status !== "pendente",
  );
  if (resolvido) return skipped(`ja_resolvido:${resolvido.status}`);
  // Esperar o link NÃO reivindica: a rodada seguinte encontra o degrau livre.
  if (esperaPeloLink(link, comeca, agora)) return skipped("link_da_reuniao_pendente");

  const { criada, entrega } = await db.reivindicaLembrete({
    organizationId: orgId,
    appointmentId: c.id,
    alvo,
    destino,
    channelSessionId,
    degrau,
    inicio: comeca.toISOString(),
  });
  if (!entrega) return skipped("reivindicacao_sem_linha");
  if (!criada) {
    if (entrega.status !== "pendente") return skipped(`ja_resolvido:${entrega.status}`);
    if (entrega.tentativas >= TETO_ABSOLUTO_DE_TENTATIVAS) return await condena(deps, orgId, entrega, "indeterminado", agora);
    const desdeOToque = agora.getTime() - Date.parse(entrega.updated_at);
    if (desdeOToque >= 0 && desdeOToque < JANELA_DE_REIVINDICACAO_MS) return skipped("outra rodada está enviando este lembrete");
  }

  // O titular pediu para ser esquecido: nem o primeiro nome sai.
  if (c.contact_id && (await deps.db.contatoAnonimizado(orgId, c.contact_id))) {
    await deps.db.atualizaEntrega(orgId, entrega.id, { status: "cancelado", erro_codigo: "titular_anonimizado" });
    return skipped("titular_anonimizado");
  }

  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const [cliente, servico] = await Promise.all([
    c.contact_id ? deps.db.nomeDoContato(orgId, c.contact_id) : Promise.resolve(null),
    c.event_type_id ? deps.db.nomeDoServico(orgId, c.event_type_id) : Promise.resolve(null),
  ]);
  const body = montarLembreteAoDono({
    marca: marca.nome,
    idioma: marca.idioma,
    cliente,
    servico: servico ?? c.title,
    inicio: comeca,
    fuso,
    degrauMin: degrau,
    link: link.url,
    linkPendente: link.estado === "pendente",
  });
  return await entrega_(deps, { orgId, channelSessionId, destino, entrega, agora, body });
}

// ---------------------------------------------------------------------------
// Adapter de produção. TODA consulta filtra `organization_id` À MÃO: o client
// é o de service role, e a organização vem da varredura do cron.
// ---------------------------------------------------------------------------

const COLUNAS_DA_ENTREGA =
  "id, organization_id, appointment_id, evento, alvo, destino, status, tentativas, created_at, updated_at";

interface TipoDoLembrete {
  reminder_enabled: boolean;
  reminder_minutes_before: number | null;
  reminder_extra_offsets_minutes: number[] | null;
}

export function createSupabaseLembreteAoDonoDb(admin: SupabaseClient): LembreteAoDonoDb {
  return {
    async compromissosALembrar(orgId, agora, ate) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select(
          "id, starts_at, created_at, starts_at_marked_at, contact_id, event_type_id, title, location_kind, meeting_state, meeting_url, " +
            "calendar_event_types!inner(reminder_enabled, reminder_minutes_before, reminder_extra_offsets_minutes)",
        )
        .eq("organization_id", orgId)
        .eq("status", "confirmed")
        .eq("calendar_event_types.reminder_enabled", true)
        .gt("starts_at", agora.toISOString())
        .lte("starts_at", ate.toISOString())
        .order("starts_at", { ascending: true })
        .limit(TETO_POR_RODADA);
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((l) => {
        const bruto = l.calendar_event_types as TipoDoLembrete | TipoDoLembrete[] | null;
        const tipo = Array.isArray(bruto) ? (bruto[0] ?? null) : bruto;
        const degraus = [tipo?.reminder_minutes_before ?? null, ...(tipo?.reminder_extra_offsets_minutes ?? [])].filter(
          (d): d is number => typeof d === "number",
        );
        return {
          id: l.id as string,
          starts_at: l.starts_at as string,
          created_at: (l.created_at as string | null) ?? null,
          starts_at_marked_at: (l.starts_at_marked_at as string | null) ?? null,
          contact_id: (l.contact_id as string | null) ?? null,
          event_type_id: (l.event_type_id as string | null) ?? null,
          title: (l.title as string | null) ?? null,
          location_kind: (l.location_kind as string | null) ?? null,
          meeting_state: (l.meeting_state as string | null) ?? null,
          meeting_url: (l.meeting_url as string | null) ?? null,
          degraus,
        };
      });
    },

    async lembretesDoCompromisso(orgId, appointmentId, alvo) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .select("degrau_minutos, inicio_lembrado, status, enviado_em")
        .eq("organization_id", orgId)
        .eq("tipo", "lembrete")
        .eq("appointment_id", appointmentId)
        .eq("alvo", alvo);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{
        degrau_minutos: number;
        inicio_lembrado: string;
        status: string;
        enviado_em: string | null;
      }>).map((r) => ({ degrau: r.degrau_minutos, inicio: r.inicio_lembrado, status: r.status, enviadoEm: r.enviado_em }));
    },

    async reivindicaLembrete({ organizationId, appointmentId, alvo, destino, channelSessionId, degrau, inicio }) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .insert({
          organization_id: organizationId,
          tipo: "lembrete",
          appointment_id: appointmentId,
          alvo,
          destino,
          channel_session_id: channelSessionId,
          degrau_minutos: degrau,
          inicio_lembrado: inicio,
          status: "pendente",
        })
        .select(COLUNAS_DA_ENTREGA)
        .maybeSingle();
      if (!error) return { criada: true, entrega: (data as EntregaDeAgendamento | null) ?? null };
      // 23505 = a chave única do lembrete. Caminho NORMAL sob concorrência.
      if (error.code !== "23505") throw new Error(error.message);
      const relida = await admin
        .from("entregas_de_aviso_de_agendamento")
        .select(COLUNAS_DA_ENTREGA)
        .eq("organization_id", organizationId)
        .eq("tipo", "lembrete")
        .eq("appointment_id", appointmentId)
        .eq("alvo", alvo)
        .eq("degrau_minutos", degrau)
        .eq("inicio_lembrado", inicio)
        .maybeSingle();
      if (relida.error) throw new Error(relida.error.message);
      return { criada: false, entrega: (relida.data as EntregaDeAgendamento | null) ?? null };
    },

    async cancelaLembretesOrfaos(orgId) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .select("id, inicio_lembrado, calendar_appointments!inner(status, starts_at)")
        .eq("organization_id", orgId)
        .eq("tipo", "lembrete")
        .eq("status", "pendente")
        .limit(200);
      if (error) throw new Error(error.message);
      const orfaos = ((data ?? []) as unknown as Array<{
        id: string;
        inicio_lembrado: string;
        calendar_appointments: { status: string; starts_at: string } | Array<{ status: string; starts_at: string }>;
      }>)
        .filter((e) => {
          const a = Array.isArray(e.calendar_appointments) ? e.calendar_appointments[0] : e.calendar_appointments;
          return !a || a.status !== "confirmed" || Date.parse(a.starts_at) !== Date.parse(e.inicio_lembrado);
        })
        .map((e) => e.id);
      if (orfaos.length === 0) return 0;
      const upd = await admin
        .from("entregas_de_aviso_de_agendamento")
        .update({ status: "cancelado", erro_codigo: null })
        .eq("organization_id", orgId)
        .eq("status", "pendente")
        .in("id", orfaos)
        .select("id");
      if (upd.error) throw new Error(upd.error.message);
      return (upd.data ?? []).length;
    },
  };
}

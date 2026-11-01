/**
 * O WHATSAPP DO DONO É AVISADO QUANDO UM HORÁRIO É MARCADO, REMARCADO OU
 * CANCELADO — e recebe às 7h o resumo do dia.
 *
 * ## Por que existe
 *
 * Marcação em dobro. Quem agenda fora do CRM (no caderno, no celular, no
 * Google) não vê o que a IA e a equipe marcaram por dentro — e o contrário. O
 * aviso leva cada mudança da agenda ao lugar que o dono olha o dia inteiro.
 *
 * ## O que é REAPROVEITADO do aviso de caso, e por quê
 *
 * O caminho de envio é o MESMO de `lib/escalacao/aviso-ao-suporte.ts`: as
 * mesmas portas (`TransporteDoAviso`, `PacingDoAviso`, `CanalDoAviso`), os
 * mesmos tetos e adiamentos, o mesmo vocabulário de erro e a mesma ordem de
 * conferências antes de tocar a rede. Uma segunda versão dessas regras
 * divergiria no primeiro conserto — e o anti-ban é a regra que não pode
 * divergir, porque um número banido leva junto o atendimento da organização.
 *
 * O que muda é o que este aviso precisa e o de caso não:
 *
 * - **A madrugada.** Das 22h às 7h no fuso da organização não sai aviso
 *   individual: a entrega nasce `para_o_resumo` e o agendamento aparece no
 *   resumo das 7h. O aviso de caso ignora a janela (a equipe pediu para ser
 *   acordada por cliente travado); agendamento novo não é urgência de 3h da
 *   manhã.
 * - **Uma entrega por EVENTO**, não por agendamento. Remarcar duas vezes são
 *   duas notícias; o mesmo evento entregue de novo pelo dreno é uma só. A
 *   `unique (organization_id, event_id)` dá isso.
 * - **Número e grupo.** O aviso sai para o número e, se houver, para um grupo
 *   do WhatsApp da mesma conexão — cada destino com a sua linha de entrega
 *   (`alvo`), a sua `unique` e o seu desfecho. Grupo que falha adia ou cai só
 *   ele; o número não espera por ele.
 * - **O cancelamento fecha o laço.** `appointment.cancelled` cancela o aviso
 *   ainda represado do mesmo agendamento — e, se nenhum aviso dele chegou a
 *   sair, não avisa o cancelamento de algo que o dono nunca soube.
 *
 * ## NENHUM DESFECHO É `error`. Nunca.
 *
 * Mesma razão do aviso de caso: a instalação típica não liga este aviso, e um
 * `error` em "sem configuração" mataria o evento de todo agendamento de toda
 * organização na quinta tentativa. Só o envio de verdade devolve `ok`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { diaLocalISO, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import {
  ADIAMENTO_DO_CANAL_MS,
  ADIAMENTO_DO_DRENO_EM_REQUEST_MS,
  IDADE_MAXIMA_DO_EVENTO_MS,
  JANELA_DE_REIVINDICACAO_MS,
  TETO_ABSOLUTO_DE_TENTATIVAS,
  TETO_DE_TENTATIVAS_DE_ENVIO,
  TETO_DE_TENTATIVAS_DO_CANAL,
  VALIDADE_DA_ENTREGA_MS,
  mascara,
  type AvisoDb,
  type CanalDoAviso,
  type PacingDoAviso,
  type TransporteDoAviso,
} from "@/lib/escalacao/aviso-ao-suporte";
import type { ErroDaEntregaDeAviso } from "@/lib/escalacao/vocabulario-do-aviso";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

import {
  montarAvisoDeAgendamento,
  montarResumoDoDia,
  origemDoAutor,
  type LinhaDoResumo,
  type MudancaDaNoite,
} from "./texto-do-aviso-de-agendamento";
import {
  EVENTOS_DO_AVISO_DE_AGENDAMENTO,
  type AlvoDaEntregaDeAgendamento,
  type EventoDoAvisoDeAgendamento,
  type StatusDaEntregaDeAgendamento,
} from "./vocabulario-do-aviso-de-agendamento";

/** A hora local em que o resumo sai, e em que a madrugada termina. */
export const HORA_DO_RESUMO = 7;
/** A hora local em que a madrugada começa. */
export const INICIO_DA_MADRUGADA = 22;
/**
 * Até que hora local o resumo ainda pode sair.
 *
 * O cron roda a cada 10 minutos e o resumo sai na primeira rodada depois das
 * 7h. A folga até as 10h existe para o espaçamento do número e para uma
 * instalação que ficou fora do ar às 7h: um resumo às 8h ainda serve; um às
 * 15h já não é resumo do dia, é ruído.
 */
export const HORA_LIMITE_DO_RESUMO = 10;

/** Entre 22h e 7h no relógio da organização. */
export function ehMadrugada(horaLocal: number): boolean {
  return horaLocal >= INICIO_DA_MADRUGADA || horaLocal < HORA_DO_RESUMO;
}

/** Os estados em que o agendamento ainda vai acontecer. */
const SITUACOES_VIVAS = new Set(["pending", "confirmed"]);

/** A configuração EM VIGOR — já resolvida a opção "usar o número do aviso de caso". */
export interface ConfigDoAvisoDeAgendamento {
  organization_id: string;
  channel_session_id: string | null;
  telefone_destino: string | null;
  /** O `chatId` (`…@g.us`) de um grupo da mesma conexão — destino EXTRA. */
  grupo_destino: string | null;
  ligado: boolean;
}

/** Para onde vai cada entrega: o número e o grupo, cada um quando existe. */
interface DestinoDoAviso {
  alvo: AlvoDaEntregaDeAgendamento;
  destino: string;
}

function destinosDe(cfg: ConfigDoAvisoDeAgendamento): DestinoDoAviso[] {
  const destinos: DestinoDoAviso[] = [];
  if (cfg.telefone_destino) destinos.push({ alvo: "numero", destino: cfg.telefone_destino });
  if (cfg.grupo_destino) destinos.push({ alvo: "grupo", destino: cfg.grupo_destino });
  return destinos;
}

export interface AgendamentoDoAviso {
  id: string;
  status: string;
  starts_at: string;
  contact_id: string | null;
  owner_user_id: string | null;
  event_type_id: string | null;
  title: string | null;
  created_by_kind: string | null;
}

export interface EntregaDeAgendamento {
  id: string;
  organization_id: string;
  appointment_id: string | null;
  evento: string | null;
  /** O número ou o grupo: sem isto, a falha de um e a do outro se leem iguais. */
  alvo: AlvoDaEntregaDeAgendamento;
  destino: string;
  status: StatusDaEntregaDeAgendamento | string;
  tentativas: number;
  created_at: string;
  updated_at: string;
}

export interface PatchDaEntregaDeAgendamento {
  status?: StatusDaEntregaDeAgendamento;
  tentativas?: number;
  erro_codigo?: ErroDaEntregaDeAviso | null;
  external_id?: string | null;
  corpo_hash?: string | null;
  enviado_em?: string | null;
}

export interface AvisoDeAgendamentoDb
  extends Pick<
    AvisoDb,
    "carregaCanal" | "destinoEhDaPropriaOrganizacao" | "contatoAnonimizado" | "nomeDoContato" | "marcaDaOrganizacao"
  > {
  carregaConfig(orgId: string): Promise<ConfigDoAvisoDeAgendamento | null>;
  fusoDaOrganizacao(orgId: string): Promise<string>;
  carregaAgendamento(orgId: string, appointmentId: string): Promise<AgendamentoDoAviso | null>;
  nomeDoServico(orgId: string, eventTypeId: string): Promise<string | null>;
  nomeDoProfissional(orgId: string, userId: string): Promise<string | null>;
  /** INSERT com a `unique`; `criada:false` = outro processo chegou primeiro. */
  reivindicaAviso(entrada: {
    organizationId: string;
    eventId: string;
    appointmentId: string;
    evento: EventoDoAvisoDeAgendamento;
    alvo: AlvoDaEntregaDeAgendamento;
    destino: string;
    channelSessionId: string;
    status: "pendente" | "para_o_resumo";
  }): Promise<{ criada: boolean; entrega: EntregaDeAgendamento | null }>;
  reivindicaResumo(entrada: {
    organizationId: string;
    dia: string;
    alvo: AlvoDaEntregaDeAgendamento;
    destino: string;
    channelSessionId: string;
  }): Promise<{ criada: boolean; entrega: EntregaDeAgendamento | null }>;
  atualizaEntrega(orgId: string, entregaId: string, patch: PatchDaEntregaDeAgendamento): Promise<void>;
  /** `pendente` e `para_o_resumo` do agendamento viram `cancelado`; devolve quantas. */
  cancelaPendentesDoAgendamento(orgId: string, appointmentId: string, excetoEventId: string): Promise<number>;
  /** Algum aviso deste agendamento já saiu (ou entrou no resumo) para ESTE destino. */
  houveAvisoEnviado(orgId: string, appointmentId: string, alvo: AlvoDaEntregaDeAgendamento): Promise<boolean>;
  /** A agenda do dia, `pending`/`confirmed`, entre os dois instantes. */
  agendaEntre(orgId: string, inicio: Date, fim: Date): Promise<AgendamentoDoAviso[]>;
  /** As entregas `para_o_resumo` DESTE destino ainda não contadas, com o agendamento de cada uma. */
  represadasParaOResumo(
    orgId: string,
    alvo: AlvoDaEntregaDeAgendamento,
  ): Promise<Array<{ entrega: EntregaDeAgendamento; agendamento: AgendamentoDoAviso | null }>>;
  /** Marca as represadas como `no_resumo` depois que o resumo saiu. */
  marcaNoResumo(orgId: string, entregaIds: string[]): Promise<void>;
}

export interface AvisoDeAgendamentoDeps {
  db: AvisoDeAgendamentoDb;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
  origemDoDreno: () => "worker" | "request";
  /** Fire-and-forget: auditar nunca pode segurar o aviso. */
  audita: (entrada: {
    action: "agenda.aviso_whatsapp_enviado" | "agenda.aviso_whatsapp_falhou";
    organizationId: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export interface DesfechoDoAvisoDeAgendamento {
  /** NUNCA `error` — ver o cabeçalho. */
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

const skipped = (detail: string): DesfechoDoAvisoDeAgendamento => ({ status: "skipped", detail });
const retry = (quando: Date, detail: string): DesfechoDoAvisoDeAgendamento => ({
  status: "retry",
  detail,
  retry_at: quando.toISOString(),
});

/**
 * Um desfecho por destino vira um só para o dreno. Um destino que pede outra
 * rodada a pede para todos — e o que já saiu volta como `ja_resolvido`, sem
 * sair de novo, pela `unique` de cada entrega.
 */
function juntaDesfechos(
  porDestino: Array<{ alvo: AlvoDaEntregaDeAgendamento; desfecho: DesfechoDoAvisoDeAgendamento }>,
): DesfechoDoAvisoDeAgendamento {
  const [unico] = porDestino;
  if (porDestino.length === 1 && unico) return unico.desfecho;
  const detail = porDestino.map((d) => `${d.alvo}:${d.desfecho.detail}`).join(" | ");
  const quandos = porDestino.flatMap((d) => (d.desfecho.retry_at ? [Date.parse(d.desfecho.retry_at)] : []));
  if (quandos.length > 0) return retry(new Date(Math.min(...quandos)), detail);
  if (porDestino.some((d) => d.desfecho.status === "ok")) return { status: "ok", detail };
  return skipped(detail);
}

/**
 * O grupo é destino EXTRA: um defeito no caminho dele (grupo que sumiu, leitura
 * que lançou) adia só ele, e nunca vira `error` que levaria o número junto.
 */
async function porDestino(
  destinos: DestinoDoAviso[],
  agora: Date,
  avisa: (d: DestinoDoAviso) => Promise<DesfechoDoAvisoDeAgendamento>,
): Promise<DesfechoDoAvisoDeAgendamento> {
  const desfechos: Array<{ alvo: AlvoDaEntregaDeAgendamento; desfecho: DesfechoDoAvisoDeAgendamento }> = [];
  for (const d of destinos) {
    if (d.alvo === "numero") {
      desfechos.push({ alvo: d.alvo, desfecho: await avisa(d) });
      continue;
    }
    try {
      desfechos.push({ alvo: d.alvo, desfecho: await avisa(d) });
    } catch (err) {
      logger.warn("[aviso-de-agendamento] envio ao grupo falhou", { causa: err instanceof Error ? err.name : "erro" });
      desfechos.push({ alvo: d.alvo, desfecho: retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "grupo falhou") });
    }
  }
  return juntaDesfechos(desfechos);
}
const textoOuNulo = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

function ehEventoDoAviso(tipo: string): tipo is EventoDoAvisoDeAgendamento {
  return (EVENTOS_DO_AVISO_DE_AGENDAMENTO as readonly string[]).includes(tipo);
}

/** Mesma régua do aviso de caso: sem `created_at`, o evento não é velho. */
function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  if (Number.isNaN(emitido)) return false;
  return agora.getTime() - emitido > IDADE_MAXIMA_DO_EVENTO_MS;
}

/**
 * Aplica UMA linha de `appointment.created`, `.rescheduled` ou `.cancelled`.
 *
 * A ordem é a do aviso de caso: o mais barato primeiro, e a rede só depois de
 * tudo o que pode dispensá-la. Quem nunca ligou o aviso termina no passo 2.
 */
export async function aplicaAvisoDeAgendamento(
  deps: AvisoDeAgendamentoDeps,
  row: EventRow,
): Promise<DesfechoDoAvisoDeAgendamento> {
  if (!ehEventoDoAviso(row.event_type)) return skipped("evento_ignorado");
  const evento = row.event_type;
  const agora = deps.clock();
  const orgId = row.organization_id;
  const appointmentId = textoOuNulo(row.payload.appointment_id) ?? textoOuNulo(row.entity_id);
  if (!appointmentId) return skipped("payload_incompleto");

  // ── O laço fecha: cancelar segura o que ainda não saiu ───────────────────
  //
  // Antes de tudo, inclusive da configuração: um aviso que ficou represado
  // pelo espaçamento ou pela madrugada não pode sair DEPOIS de o horário ter
  // sido cancelado, mesmo que alguém tenha desligado o aviso no meio.
  let canceladas = 0;
  if (evento === "appointment.cancelled") {
    canceladas = await deps.db.cancelaPendentesDoAgendamento(orgId, appointmentId, row.id);
  }

  // ── 0. Dreno DENTRO da requisição: adia sem tocar a rede ─────────────────
  if (deps.origemDoDreno() === "request") {
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS), "adiado: dreno dentro do webhook");
  }

  // ── 1. Configuração — o caminho de toda instalação que nunca ligou ───────
  const cfg = await deps.db.carregaConfig(orgId);
  const destinos = cfg ? destinosDe(cfg) : [];
  if (!cfg || !cfg.ligado || !cfg.channel_session_id || destinos.length === 0) {
    return skipped(canceladas > 0 ? `cancelado=${canceladas}:sem_configuracao` : "sem_configuracao");
  }
  const channelSessionId = cfg.channel_session_id;

  // ── 2. Teto de idade do EVENTO ───────────────────────────────────────────
  if (passouDoTeto(row, agora)) return skipped("evento_velho");

  // ── 3. O agendamento ainda merece este aviso? ────────────────────────────
  const agendamento = await deps.db.carregaAgendamento(orgId, appointmentId);
  if (!agendamento) return skipped("agendamento_inexistente");
  if (evento !== "appointment.cancelled" && !SITUACOES_VIVAS.has(agendamento.status)) {
    // Marcou e cancelou antes do dreno chegar: o cancelamento é a notícia.
    return skipped(`agendamento_${agendamento.status}`);
  }

  // ── 4. Madrugada: vai no resumo das 7h ───────────────────────────────────
  const fuso = await deps.db.fusoDaOrganizacao(orgId);
  const madrugada = ehMadrugada(partesNoFuso(agora, fuso).hora);

  const ctx = { row, evento, orgId, appointmentId, agendamento, channelSessionId, fuso, madrugada, agora, canceladas };
  return await porDestino(destinos, agora, (d) => avisaUmDestino(deps, { ...ctx, ...d }));
}

/** Os passos 5 → 14 para UM destino — o número e o grupo têm entregas próprias. */
async function avisaUmDestino(
  deps: AvisoDeAgendamentoDeps,
  ctx: DestinoDoAviso & {
    row: EventRow;
    evento: EventoDoAvisoDeAgendamento;
    orgId: string;
    appointmentId: string;
    agendamento: AgendamentoDoAviso;
    channelSessionId: string;
    fuso: string;
    madrugada: boolean;
    agora: Date;
    canceladas: number;
  },
): Promise<DesfechoDoAvisoDeAgendamento> {
  const { row, evento, orgId, appointmentId, agendamento, channelSessionId, fuso, madrugada, agora, alvo, destino, canceladas } =
    ctx;

  // Este destino nunca soube do horário (o aviso dele ainda estava na fila e o
  // cancelamento o segurou): avisar que ele foi cancelado é ruído. A pergunta é
  // POR DESTINO — o número pode ter recebido o "marcado" e o grupo não.
  if (evento === "appointment.cancelled" && canceladas > 0 && !(await deps.db.houveAvisoEnviado(orgId, appointmentId, alvo))) {
    return { status: "ok", detail: `cancelado=${canceladas}:nada_a_avisar` };
  }

  // ── 5. REIVINDICA antes de tocar a rede ──────────────────────────────────
  const { criada, entrega } = await deps.db.reivindicaAviso({
    organizationId: orgId,
    eventId: row.id,
    appointmentId,
    evento,
    alvo,
    destino,
    channelSessionId,
    status: madrugada ? "para_o_resumo" : "pendente",
  });
  if (!entrega) return skipped("reivindicacao_sem_linha");
  if (criada && madrugada) return skipped("madrugada:vai_no_resumo");

  if (!criada) {
    if (entrega.status !== "pendente") return skipped(`ja_resolvido:${entrega.status}`);
    if (entrega.tentativas >= TETO_ABSOLUTO_DE_TENTATIVAS) {
      return await condena(deps, orgId, entrega, "indeterminado", agora);
    }
    const desdeOToque = agora.getTime() - Date.parse(entrega.updated_at);
    if (desdeOToque >= 0 && desdeOToque < JANELA_DE_REIVINDICACAO_MS) {
      return retry(new Date(agora.getTime() + JANELA_DE_REIVINDICACAO_MS), "outra rodada está enviando este aviso");
    }
  }

  // ── 6. Validade da entrega ───────────────────────────────────────────────
  const idadeDaEntrega = agora.getTime() - Date.parse(entrega.created_at);
  if (Number.isFinite(idadeDaEntrega) && idadeDaEntrega > VALIDADE_DA_ENTREGA_MS) {
    return await condena(deps, orgId, entrega, "expirou", agora, "cancelado");
  }

  // ── 7. O titular pediu para ser esquecido ────────────────────────────────
  if (agendamento.contact_id && (await deps.db.contatoAnonimizado(orgId, agendamento.contact_id))) {
    await deps.db.atualizaEntrega(orgId, entrega.id, { status: "cancelado", erro_codigo: "titular_anonimizado" });
    return skipped("titular_anonimizado");
  }

  // ── 8 → 14. O caminho de envio do aviso de caso ──────────────────────────
  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const [cliente, servico, profissional] = await Promise.all([
    agendamento.contact_id ? deps.db.nomeDoContato(orgId, agendamento.contact_id) : Promise.resolve(null),
    agendamento.event_type_id ? deps.db.nomeDoServico(orgId, agendamento.event_type_id) : Promise.resolve(null),
    agendamento.owner_user_id ? deps.db.nomeDoProfissional(orgId, agendamento.owner_user_id) : Promise.resolve(null),
  ]);
  const body = montarAvisoDeAgendamento({
    marca: marca.nome,
    idioma: marca.idioma,
    evento,
    cliente,
    servico: servico ?? agendamento.title,
    inicio: new Date(agendamento.starts_at),
    fuso,
    profissional,
    // A AUTORIA DA MUDANÇA, quando o emissor a mandou; senão quem marcou.
    origem: origemDoAutor(row.payload.autor ?? agendamento.created_by_kind),
  });

  return await entrega_(deps, { orgId, channelSessionId, destino, entrega, agora, body });
}

/**
 * O RESUMO DAS 7H de UMA organização. Chamado pelo cron
 * `app/api/v1/cron/agenda-resumo-do-dia`, a cada 10 minutos.
 *
 * Só age entre 7h e 10h no relógio da organização, e a entrega do dia é
 * única: a segunda rodada encontra o resumo enviado e sai sem tocar a rede.
 */
export async function aplicaResumoDoDia(
  deps: Omit<AvisoDeAgendamentoDeps, "origemDoDreno">,
  orgId: string,
): Promise<DesfechoDoAvisoDeAgendamento> {
  const agora = deps.clock();
  const cfg = await deps.db.carregaConfig(orgId);
  const destinos = cfg ? destinosDe(cfg) : [];
  if (!cfg || !cfg.ligado || !cfg.channel_session_id || destinos.length === 0) return skipped("sem_configuracao");
  const channelSessionId = cfg.channel_session_id;

  const fuso = await deps.db.fusoDaOrganizacao(orgId);
  const parede = partesNoFuso(agora, fuso);
  if (parede.hora < HORA_DO_RESUMO || parede.hora >= HORA_LIMITE_DO_RESUMO) return skipped("fora_da_hora");

  return await porDestino(destinos, agora, (d) =>
    resumoParaUmDestino(deps, { ...d, orgId, channelSessionId, fuso, parede, agora }),
  );
}

/** O resumo de UM destino: cada um tem a sua entrega do dia e as suas represadas. */
async function resumoParaUmDestino(
  deps: Omit<AvisoDeAgendamentoDeps, "origemDoDreno">,
  ctx: DestinoDoAviso & {
    orgId: string;
    channelSessionId: string;
    fuso: string;
    parede: ReturnType<typeof partesNoFuso>;
    agora: Date;
  },
): Promise<DesfechoDoAvisoDeAgendamento> {
  const { orgId, channelSessionId, fuso, parede, agora, alvo, destino } = ctx;
  const dia = diaLocalISO(agora, fuso);
  const { criada, entrega } = await deps.db.reivindicaResumo({
    organizationId: orgId,
    dia,
    alvo,
    destino,
    channelSessionId,
  });
  if (!entrega) return skipped("reivindicacao_sem_linha");
  if (!criada) {
    if (entrega.status !== "pendente") return skipped(`ja_resolvido:${entrega.status}`);
    if (entrega.tentativas >= TETO_ABSOLUTO_DE_TENTATIVAS) {
      return await condena(deps, orgId, entrega, "indeterminado", agora);
    }
    const desdeOToque = agora.getTime() - Date.parse(entrega.updated_at);
    if (desdeOToque >= 0 && desdeOToque < JANELA_DE_REIVINDICACAO_MS) return skipped("outra rodada está enviando o resumo");
  }

  // O dia local inteiro, de 00:00 a 00:00 do dia seguinte, em instantes —
  // por `instanteDe`, que sabe o que fazer no dia em que o relógio muda.
  const inicioDoDia = instanteDe({ ano: parede.ano, mes: parede.mes, dia: parede.dia }, fuso);
  const amanha = partesNoFuso(new Date(inicioDoDia.getTime() + 36 * 60 * 60 * 1000), fuso);
  const fimDoDia = instanteDe({ ano: amanha.ano, mes: amanha.mes, dia: amanha.dia }, fuso);
  const [agendaBruta, represadas, marca] = await Promise.all([
    deps.db.agendaEntre(orgId, inicioDoDia, fimDoDia),
    deps.db.represadasParaOResumo(orgId, alvo),
    deps.db.marcaDaOrganizacao(orgId),
  ]);

  const nomes = criaCacheDeNomes(deps.db, orgId);
  const agenda: LinhaDoResumo[] = await Promise.all(
    agendaBruta.map(async (a) => ({
      inicio: new Date(a.starts_at),
      cliente: await nomes.cliente(a.contact_id),
      servico: (await nomes.servico(a.event_type_id)) ?? a.title,
      profissional: await nomes.profissional(a.owner_user_id),
    })),
  );
  const daNoite: MudancaDaNoite[] = [];
  for (const { entrega: r, agendamento } of represadas) {
    if (!agendamento || !r.evento) continue;
    daNoite.push({
      evento: r.evento as MudancaDaNoite["evento"],
      inicio: new Date(agendamento.starts_at),
      cliente: await nomes.cliente(agendamento.contact_id),
    });
  }

  const body = montarResumoDoDia({ marca: marca.nome, idioma: marca.idioma, fuso, dia: agora, agenda, daNoite });
  const desfecho = await entrega_(deps, {
    orgId,
    channelSessionId,
    destino,
    entrega,
    agora,
    body,
  });
  if (desfecho.status === "ok" && represadas.length > 0) {
    try {
      await deps.db.marcaNoResumo(
        orgId,
        represadas.map((r) => r.entrega.id),
      );
    } catch (err) {
      // Falha ABERTA: o resumo já está no celular de alguém. O pior desfecho
      // é a mesma mudança aparecer de novo no resumo de amanhã.
      logger.warn("[aviso-de-agendamento] represadas não marcadas como no resumo", {
        organizationId: orgId,
        causa: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return desfecho;
}

/** Os nomes de quem aparece no resumo, um por id: um profissional com dez horários é lido uma vez. */
function criaCacheDeNomes(db: AvisoDeAgendamentoDb, orgId: string) {
  const memo = new Map<string, Promise<string | null>>();
  const lembra = (chave: string, ler: () => Promise<string | null>) => {
    const ja = memo.get(chave);
    if (ja) return ja;
    const p = ler().catch(() => null);
    memo.set(chave, p);
    return p;
  };
  return {
    cliente: (id: string | null) => (id ? lembra(`c:${id}`, () => db.nomeDoContato(orgId, id)) : Promise.resolve(null)),
    servico: (id: string | null) => (id ? lembra(`s:${id}`, () => db.nomeDoServico(orgId, id)) : Promise.resolve(null)),
    profissional: (id: string | null) =>
      id ? lembra(`p:${id}`, () => db.nomeDoProfissional(orgId, id)) : Promise.resolve(null),
  };
}

/**
 * Os passos 8 → 15 do aviso de caso, na MESMA ordem: canal, transporte,
 * espaçamento e teto, destino que voltou a ser da organização, endereço,
 * envio, e o que vem depois do envio.
 *
 * O que fica de fora é o endereço público: esta mensagem não leva link, então
 * uma instalação sem domínio ainda consegue avisar o dono.
 */
async function entrega_(
  deps: Omit<AvisoDeAgendamentoDeps, "origemDoDreno">,
  ctx: {
    orgId: string;
    channelSessionId: string;
    destino: string;
    entrega: EntregaDeAgendamento;
    agora: Date;
    body: string;
  },
): Promise<DesfechoDoAvisoDeAgendamento> {
  const { orgId, channelSessionId, destino, entrega, agora, body } = ctx;
  const tentativas = entrega.tentativas + 1;

  const canal: CanalDoAviso | null = await deps.db.carregaCanal(orgId, channelSessionId);
  if (!canal || canal.archived_at) return await condena(deps, orgId, entrega, "canal_arquivado", agora);
  if (canal.desativado) return await condena(deps, orgId, entrega, "canal_desativado", agora);
  if (!canal.aceitaMensagemLivre) return await condena(deps, orgId, entrega, "canal_nao_aceita_aviso_livre", agora);
  if (canal.status !== "WORKING") {
    if (tentativas >= TETO_DE_TENTATIVAS_DO_CANAL) return await condena(deps, orgId, entrega, "canal_desconectado", agora);
    await deps.db.atualizaEntrega(orgId, entrega.id, { tentativas, erro_codigo: "canal_desconectado" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), `canal ${canal.status}`);
  }

  if (!(await deps.transporte.configurado(orgId, canal))) {
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) return await condena(deps, orgId, entrega, "transporte_ausente", agora);
    await deps.db.atualizaEntrega(orgId, entrega.id, { tentativas, erro_codigo: "transporte_ausente" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }

  // Espaçamento e teto diário do `pacing_ledger`. A janela de horário do
  // anti-ban não entra: quem recebe é o dono, e a madrugada já foi decidida
  // pela regra deste aviso.
  const pacing = await deps.pacing.decide(orgId, channelSessionId, agora);
  if (!pacing.liberado) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      erro_codigo: pacing.motivo === "teto_diario" ? "teto_diario_do_numero" : null,
    });
    return retry(pacing.liberaEm, `pacing:${pacing.motivo}`);
  }

  // O destino pode ter voltado a ser número de uma conexão ATIVA da própria
  // organização depois de salvo (conexão reativada) — a mesma pergunta do
  // aviso de caso, feita de novo no envio.
  if (await deps.db.destinoEhDaPropriaOrganizacao(orgId, destino)) {
    return await condena(deps, orgId, entrega, "destino_da_propria_organizacao", agora);
  }

  const to = await deps.transporte.resolveDestino(orgId, canal, destino);
  if (!to) return await condena(deps, orgId, entrega, "destino_invalido", agora);

  let externalId: string | null = null;
  try {
    externalId = (await deps.transporte.envia(orgId, canal, to, body)).externalId;
  } catch (err) {
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) return await condena(deps, orgId, entrega, "falha_no_envio", agora);
    // A causa crua do transporte NÃO é guardada: ela pode ecoar o número ou o
    // texto, e esta tabela não entra na cascata de LGPD. O log leva só o código.
    logger.warn("[aviso-de-agendamento] envio recusado", {
      organizationId: orgId,
      causa: err instanceof Error ? err.name : "erro",
    });
    await deps.db.atualizaEntrega(orgId, entrega.id, { tentativas, erro_codigo: "falha_no_envio" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "envio recusado");
  }

  // ── Saiu. Daqui para baixo TUDO falha ABERTO ─────────────────────────────
  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status: "enviado",
    tentativas,
    erro_codigo: null,
    external_id: externalId,
    // O TEXTO NUNCA É GUARDADO — só o resumo criptográfico dele.
    corpo_hash: createHash("sha256").update(body).digest("hex"),
    enviado_em: agora.toISOString(),
  });
  try {
    await deps.pacing.registraEnvio(orgId, channelSessionId, agora);
  } catch (err) {
    logger.warn("[aviso-de-agendamento] envio não contabilizado no pacing", {
      organizationId: orgId,
      channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
  deps.audita({
    action: "agenda.aviso_whatsapp_enviado",
    organizationId: orgId,
    resourceId: entrega.appointment_id ?? entrega.id,
    metadata: { entrega_id: entrega.id, evento: entrega.evento, alvo: entrega.alvo, canal: channelSessionId, tentativas },
  });
  return { status: "ok", detail: `enviado canal=${channelSessionId} tentativas=${tentativas}` };
}

/** A falha DEFINITIVA: grava o desfecho e audita. `skipped`, nunca `error`. */
async function condena(
  deps: Pick<AvisoDeAgendamentoDeps, "db" | "audita">,
  orgId: string,
  entrega: EntregaDeAgendamento,
  codigo: ErroDaEntregaDeAviso,
  agora: Date,
  status: "falhou" | "cancelado" = "falhou",
): Promise<DesfechoDoAvisoDeAgendamento> {
  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status,
    tentativas: entrega.tentativas + 1,
    erro_codigo: codigo,
  });
  deps.audita({
    action: "agenda.aviso_whatsapp_falhou",
    organizationId: orgId,
    resourceId: entrega.appointment_id ?? entrega.id,
    // NUNCA o número inteiro, NUNCA o corpo: `api_audit_log` é append-only.
    metadata: {
      entrega_id: entrega.id,
      evento: entrega.evento,
      alvo: entrega.alvo,
      erro_codigo: codigo,
      destino_mascarado: mascara(entrega.destino),
      quando: agora.toISOString(),
    },
  });
  return skipped(`${status}:${codigo}`);
}

// ---------------------------------------------------------------------------
// Adapter de produção — `AvisoDeAgendamentoDb` sobre o client de service role.
// ---------------------------------------------------------------------------

const COLUNAS_DA_ENTREGA =
  "id, organization_id, appointment_id, evento, alvo, destino, status, tentativas, created_at, updated_at";
const COLUNAS_DO_AGENDAMENTO =
  "id, status, starts_at, contact_id, owner_user_id, event_type_id, title, created_by_kind";

/**
 * ⚠️ TODA consulta filtra `organization_id` À MÃO. O client é o de service
 * role, que BYPASSA a RLS: a organização vem da linha do `event_log` ou da
 * varredura do cron (fonte confiável), nunca de um corpo externo.
 *
 * As leituras de canal, destino, contato e marca são as do aviso de caso —
 * recebidas prontas em `doCaso`, não reescritas.
 */
export function createSupabaseAvisoDeAgendamentoDb(
  admin: SupabaseClient,
  doCaso: Pick<
    AvisoDb,
    "carregaCanal" | "destinoEhDaPropriaOrganizacao" | "contatoAnonimizado" | "nomeDoContato" | "marcaDaOrganizacao"
  >,
): AvisoDeAgendamentoDb {
  async function inserirEntrega(
    linha: Record<string, unknown>,
    relerPor: Record<string, string>,
  ): Promise<{ criada: boolean; entrega: EntregaDeAgendamento | null }> {
    const { data, error } = await admin
      .from("entregas_de_aviso_de_agendamento")
      .insert(linha)
      .select(COLUNAS_DA_ENTREGA)
      .maybeSingle();
    if (!error) return { criada: true, entrega: (data as EntregaDeAgendamento | null) ?? null };
    // 23505 = uma das duas `unique`. Caminho NORMAL sob concorrência.
    if (error.code !== "23505") throw new Error(error.message);
    let q = admin.from("entregas_de_aviso_de_agendamento").select(COLUNAS_DA_ENTREGA);
    for (const [coluna, valor] of Object.entries(relerPor)) q = q.eq(coluna, valor);
    const relida = await q.maybeSingle();
    if (relida.error) throw new Error(relida.error.message);
    return { criada: false, entrega: (relida.data as EntregaDeAgendamento | null) ?? null };
  }

  return {
    ...doCaso,

    async carregaConfig(orgId) {
      const { data, error } = await admin
        .from("config_aviso_de_agendamento")
        .select("organization_id, usa_numero_do_aviso_de_caso, channel_session_id, telefone_destino, grupo_destino, ligado")
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const linha = data as {
        organization_id: string;
        usa_numero_do_aviso_de_caso: boolean;
        channel_session_id: string | null;
        telefone_destino: string | null;
        grupo_destino: string | null;
        ligado: boolean;
      } | null;
      if (!linha) return null;
      if (!linha.usa_numero_do_aviso_de_caso) {
        return {
          organization_id: orgId,
          channel_session_id: linha.channel_session_id,
          telefone_destino: linha.telefone_destino,
          grupo_destino: linha.grupo_destino,
          ligado: linha.ligado,
        };
      }
      // "Usar o mesmo número do aviso de caso": a conexão e o número são LIDOS
      // de lá a cada envio, não copiados. Trocar o número do plantão troca
      // também para onde vão os avisos de agenda — que é o que a opção promete.
      const caso = await admin
        .from("config_aviso_de_caso")
        .select("channel_session_id, telefone_destino")
        .eq("organization_id", orgId)
        .maybeSingle();
      if (caso.error) throw new Error(caso.error.message);
      const deCaso = caso.data as { channel_session_id: string | null; telefone_destino: string | null } | null;
      return {
        organization_id: orgId,
        channel_session_id: deCaso?.channel_session_id ?? null,
        telefone_destino: deCaso?.telefone_destino ?? null,
        grupo_destino: linha.grupo_destino,
        ligado: linha.ligado,
      };
    },

    async fusoDaOrganizacao(orgId) {
      const { data } = await admin.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
      return (data as { timezone?: string | null } | null)?.timezone || "America/Sao_Paulo";
    },

    async carregaAgendamento(orgId, appointmentId) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select(COLUNAS_DO_AGENDAMENTO)
        .eq("organization_id", orgId)
        .eq("id", appointmentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as AgendamentoDoAviso | null) ?? null;
    },

    async nomeDoServico(orgId, eventTypeId) {
      const { data } = await admin
        .from("calendar_event_types")
        .select("name")
        .eq("organization_id", orgId)
        .eq("id", eventTypeId)
        .maybeSingle();
      return (data as { name?: string | null } | null)?.name ?? null;
    },

    async nomeDoProfissional(orgId, userId) {
      // Só membro DESTA organização tem o nome lido: o `owner_user_id` vem do
      // compromisso, e a conferência impede ler o perfil de quem não é daqui.
      const { data: membro } = await admin
        .from("user_organizations")
        .select("user_id")
        .eq("organization_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!membro) return null;
      const { data } = await admin.auth.admin.getUserById(userId);
      const nome = data?.user?.user_metadata?.full_name;
      return typeof nome === "string" && nome.trim() ? nome : null;
    },

    reivindicaAviso({ organizationId, eventId, appointmentId, evento, alvo, destino, channelSessionId, status }) {
      return inserirEntrega(
        {
          organization_id: organizationId,
          tipo: "aviso",
          event_id: eventId,
          appointment_id: appointmentId,
          evento,
          alvo,
          destino,
          channel_session_id: channelSessionId,
          status,
        },
        { organization_id: organizationId, event_id: eventId, alvo },
      );
    },

    reivindicaResumo({ organizationId, dia, alvo, destino, channelSessionId }) {
      return inserirEntrega(
        {
          organization_id: organizationId,
          tipo: "resumo",
          dia,
          alvo,
          destino,
          channel_session_id: channelSessionId,
          status: "pendente",
        },
        { organization_id: organizationId, tipo: "resumo", dia, alvo },
      );
    },

    async atualizaEntrega(orgId, entregaId, patch) {
      const { error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .update(patch)
        .eq("organization_id", orgId)
        .eq("id", entregaId);
      if (error) throw new Error(error.message);
    },

    async cancelaPendentesDoAgendamento(orgId, appointmentId, excetoEventId) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .update({ status: "cancelado", erro_codigo: null })
        .eq("organization_id", orgId)
        .eq("appointment_id", appointmentId)
        .in("status", ["pendente", "para_o_resumo"])
        .neq("event_id", excetoEventId)
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },

    async houveAvisoEnviado(orgId, appointmentId, alvo) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .select("id")
        .eq("organization_id", orgId)
        .eq("appointment_id", appointmentId)
        .eq("alvo", alvo)
        .in("status", ["enviado", "no_resumo"])
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async agendaEntre(orgId, inicio, fim) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select(COLUNAS_DO_AGENDAMENTO)
        .eq("organization_id", orgId)
        .in("status", ["pending", "confirmed"])
        .gte("starts_at", inicio.toISOString())
        .lt("starts_at", fim.toISOString())
        .order("starts_at", { ascending: true })
        // Um teto que nenhuma agenda de PME alcança, e que impede uma
        // mensagem de WhatsApp gigante se algo der muito errado.
        .limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as AgendamentoDoAviso[];
    },

    async represadasParaOResumo(orgId, alvo) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .select(COLUNAS_DA_ENTREGA)
        .eq("organization_id", orgId)
        .eq("tipo", "aviso")
        .eq("alvo", alvo)
        .eq("status", "para_o_resumo")
        .order("created_at", { ascending: true })
        .limit(30);
      if (error) throw new Error(error.message);
      const entregas = (data ?? []) as EntregaDeAgendamento[];
      const ids = [...new Set(entregas.map((e) => e.appointment_id).filter((v): v is string => Boolean(v)))];
      const porId = new Map<string, AgendamentoDoAviso>();
      if (ids.length > 0) {
        const ags = await admin
          .from("calendar_appointments")
          .select(COLUNAS_DO_AGENDAMENTO)
          .eq("organization_id", orgId)
          .in("id", ids);
        if (ags.error) throw new Error(ags.error.message);
        for (const a of (ags.data ?? []) as AgendamentoDoAviso[]) porId.set(a.id, a);
      }
      return entregas.map((entrega) => ({
        entrega,
        agendamento: entrega.appointment_id ? (porId.get(entrega.appointment_id) ?? null) : null,
      }));
    },

    async marcaNoResumo(orgId, entregaIds) {
      if (entregaIds.length === 0) return;
      const { error } = await admin
        .from("entregas_de_aviso_de_agendamento")
        .update({ status: "no_resumo" })
        .eq("organization_id", orgId)
        .eq("status", "para_o_resumo")
        .in("id", entregaIds);
      if (error) throw new Error(error.message);
    },
  };
}

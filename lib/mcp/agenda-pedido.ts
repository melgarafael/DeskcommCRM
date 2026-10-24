import { horariosLivresDaOrg } from "@/lib/agenda/consulta";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { rotuloLocal } from "@/lib/tempo/agora";
import { fusoValido } from "@/lib/tempo/fusos";
import type { PropostaDeAgenda } from "@/lib/agenda/pedido";
import { guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import type { McpContext } from "./types";

type Operacao = {
  acao: "criar" | "remarcar";
  startsAt: string;
  appointmentId?: string;
  eventTypeId?: string;
  eventTypeSlug?: string;
  contactId?: string;
  ownerUserId?: string;
  participants?: readonly string[];
  expectedServiceRevision?: number;
};
const recusa = (motivo: string) => ({ motivo,
  mensagem: "NADA foi reservado ou remarcado por esta tentativa. Confira o pedido atual e o início UTC da opção escolhida, no fuso da agenda. Não troque apenas Z pela hora local. Se a escolha estiver ambígua, esclareça dia, hora e pessoa; se estiver explícita, use a opção correspondente sem pedir aprovação humana por rotina." });

/** A API sem conversa conserva ISO UTC. No turno, a autorização precede qualquer escrita/Google. */
export async function conferirPedidoDaAgenda(ctx: McpContext, op: Operacao) {
  if (!ctx.contatoDoTurno) return null;
  if (!ctx.conferirPedidoAgenda) return recusa("agenda_pedido_nao_conferido");
  let contactId = op.contactId;
  let eventTypeId = op.eventTypeId;
  let ownerUserId = op.ownerUserId;
  let participants = op.participants;
  let appointmentRevision: number | undefined;
  let reservaAtual: PropostaDeAgenda["reserva_atual"];
  if (op.acao === "remarcar") {
    const { data, error } = await ctx.supabase.from("calendar_appointments")
      .select("contact_id,event_type_id,owner_user_id,participant_name,status,revision,starts_at,ends_at,time_zone")
      .eq("organization_id", ctx.organizationId).eq("id", op.appointmentId!).maybeSingle();
    if (error || !data || !["pending", "confirmed"].includes(data.status)) return recusa("agenda_pedido_nao_conferido");
    contactId = data.contact_id;
    eventTypeId = data.event_type_id;
    ownerUserId = data.owner_user_id ?? undefined;
    participants = data.participant_name ? [data.participant_name] : undefined;
    appointmentRevision = Number(data.revision);
    const origem = new Date(data.starts_at), fim = new Date(data.ends_at);
    if (!Number.isSafeInteger(appointmentRevision) || appointmentRevision < 1 ||
        !Number.isFinite(origem.getTime()) || !Number.isFinite(fim.getTime()) || fim <= origem ||
        !fusoValido(data.time_zone)) return recusa("agenda_pedido_origem_nao_conferida");
    const quandoOrigem = rotuloLocal(origem, data.time_zone);
    reservaAtual = { inicio:origem.toISOString(), fim:fim.toISOString(), fuso:data.time_zone,
      dia:diaLocalISO(origem,data.time_zone), horario:quandoOrigem.slice(quandoOrigem.lastIndexOf(" às ") + 4),
      quando:quandoOrigem, estado:data.status, revisao:appointmentRevision };
  }
  if (contactId !== ctx.contatoDoTurno || !eventTypeId) return recusa("agenda_pedido_fora_do_contato");
  const inicio = new Date(op.startsAt);
  const agora = new Date();
  if (!Number.isFinite(inicio.getTime()) || inicio <= agora) return recusa("agenda_pedido_horario_passado");
  const { data: tipo, error } = await ctx.supabase.from("calendar_event_types")
    .select("name,slug").eq("organization_id", ctx.organizationId).eq("id", eventTypeId).maybeSingle();
  if (error || !tipo) return recusa("agenda_pedido_nao_conferido");
  // A mesma coleta que oferta/valida a agenda decide o fuso. Não confiar no fuso do modelo/processo.
  // Disponibilidade e capacidade continuam sendo revalidadas atomicamente pelo escritor nativo.
  const consulta = await horariosLivresDaOrg(ctx.supabase, ctx.organizationId, {
    eventTypeId, ownerUserId: ownerUserId ?? null,
    de: inicio, ate: new Date(inicio.getTime() + 86_400_000), agora,
    ...(op.appointmentId ? { ignorarAgendamentoId: op.appointmentId } : {}),
  });
  if (!consulta.ok) return recusa("agenda_pedido_fuso_nao_conferido");
  if (op.expectedServiceRevision !== undefined && consulta.servico && op.expectedServiceRevision !== consulta.servico.revision)
    return recusa("agenda_servico_alterado");
  const quando = rotuloLocal(inicio, consulta.fusoDaRegra);
  const compativel = await ctx.conferirPedidoAgenda({ acao: op.acao,
    servico: `${tipo.name} (${tipo.slug})`, inicio: inicio.toISOString(), fuso: consulta.fusoDaRegra,
    dia: diaLocalISO(inicio, consulta.fusoDaRegra), horario: quando.slice(quando.lastIndexOf(" às ") + 4), quando,
    beneficiarios: participants ?? ["contato_atendido"],
    ...(consulta.servico && typeof consulta.servico.requires_confirmation === "boolean" ? { politica_do_servico: {
      confirmacao_equipe_exigida: consulta.servico.requires_confirmation, revisao_regra: consulta.servico.revision,
    } } : {}),
    ...(reservaAtual ? { reserva_atual:reservaAtual } : {}),
  });
  if (compativel !== true) return recusa("agenda_pedido_divergente_ou_incerto");
  await guardServiceEffect();
  return { expectedServiceRevision: consulta.servico?.revision, appointmentRevision, reservaAnterior: reservaAtual };
}

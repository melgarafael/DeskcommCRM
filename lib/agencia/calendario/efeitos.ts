/**
 * O que acontece FORA da linha da reunião quando ela é marcada, mudada ou
 * cancelada (docs/agencia/SPEC-calendario.md, K2, K4): o evento no Google, a
 * mensagem ao cliente no WhatsApp da agência e os avisos da equipe.
 *
 * Nenhum desses efeitos desfaz a reunião quando falha: o Google vira
 * `google_erro` na linha (a tela mostra), o WhatsApp tem a própria fila com
 * "Últimos envios", e o aviso tem o sininho.
 */
import { marcaDaSaida } from "@/lib/branding/saida";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import type { TipoDeAviso } from "../avisos/tipos";
import { formatarDataHora } from "../tarefas/regras";
import { enfileirarWhatsappDaAgencia } from "../whatsapp/enfileirar";
import type { ReuniaoDaAgenda } from "./consultas";
import { agendaDisponivel, cancelarEvento, gravarEvento } from "./google";
import { textoAoCliente } from "./regras";
import type { TipoDeReuniao } from "./vocabulario";

/** Os e-mails que o Google convida: os da equipe na reunião e os dos convidados do cliente. */
async function emailsDaReuniao(r: ReuniaoDaAgenda): Promise<string[]> {
  const emails = r.convidados.map((c) => c.email).filter(Boolean);
  if (r.membros.length) {
    const { data } = await createAdminClient().from("agencia_membros").select("email").in("id", r.membros);
    emails.push(...((data ?? []) as Array<{ email: string | null }>).flatMap((m) => (m.email ? [m.email] : [])));
  }
  return emails;
}

/**
 * Cria ou atualiza o evento do Google e grava o resultado na linha. Sem Agenda
 * liberada, registra por quê (K10) e segue.
 */
export async function sincronizarComOGoogle(r: ReuniaoDaAgenda, eventIdAtual: string | null): Promise<ReuniaoDaAgenda> {
  const db = createAdminClient();
  if (!(await agendaDisponivel())) {
    await db.from("agencia_reunioes").update({ google_erro: "sem_agenda" }).eq("id", r.id);
    return { ...r, googleErro: "sem_agenda" };
  }
  const g = await gravarEvento({
    id: r.id,
    eventId: eventIdAtual,
    titulo: r.titulo,
    inicio: r.inicio,
    fim: r.fim,
    formato: r.formato,
    local: r.local,
    emails: await emailsDaReuniao(r),
    temMeet: r.formato === "online" && !!r.meetUrl,
  });
  if (!g.ok) {
    await db.from("agencia_reunioes").update({ google_erro: g.erro }).eq("id", r.id);
    return { ...r, googleErro: g.erro };
  }
  const meetUrl = r.formato === "online" ? (g.valor.meetUrl ?? r.meetUrl) : null;
  await db
    .from("agencia_reunioes")
    .update({ google_event_id: g.valor.eventId, google_link: g.valor.link, meet_url: meetUrl, google_erro: null })
    .eq("id", r.id);
  return { ...r, googleLink: g.valor.link, meetUrl, googleErro: null };
}

export async function tirarDoGoogle(reuniaoId: string, eventId: string | null): Promise<void> {
  if (!eventId) return;
  const c = await cancelarEvento(eventId);
  await createAdminClient()
    .from("agencia_reunioes")
    .update(c.ok ? { google_event_id: null, google_erro: null } : { google_erro: c.erro })
    .eq("id", reuniaoId);
}

/** A mensagem ao cliente (K4), para cada convidado com WhatsApp. Devolve quantas foram para a fila. */
export async function avisarOCliente(
  r: ReuniaoDaAgenda,
  situacao: "marcada" | "remarcada" | "cancelada",
  seguinte: { tipo: TipoDeReuniao; inicio: string } | null = null,
): Promise<number> {
  if (!r.avisarCliente || !r.clienteId) return 0;
  const agencia = (await marcaDaSaida(null)).nome;
  let enfileiradas = 0;
  for (const c of r.convidados.filter((x) => x.whatsapp)) {
    try {
      const fila = await enfileirarWhatsappDaAgencia({
        motivo: "reuniao",
        referenciaId: r.id,
        telefone: c.whatsapp,
        corpo: textoAoCliente({
          nome: c.nome,
          agencia,
          situacao,
          tipo: r.tipo,
          inicio: r.inicio,
          formato: r.formato,
          meetUrl: r.meetUrl,
          local: r.local,
          seguinte,
        }),
      });
      if (fila.enfileirado) enfileiradas++;
    } catch (e) {
      logger.warn("agência: mensagem da reunião ao cliente não foi para a fila", {
        reuniao: r.id,
        detalhe: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return enfileiradas;
}

/** Avisa a equipe da reunião, menos quem fez a mudança. */
export async function avisarAEquipe(
  r: ReuniaoDaAgenda,
  tipo: Extract<TipoDeAviso, "reuniao_marcada" | "reuniao_alterada">,
  membros: readonly string[],
  quemFez: string | null,
  prefixo = "",
): Promise<void> {
  const alvos = membros.filter((m) => m !== quemFez);
  if (alvos.length === 0) return;
  await criarAviso({
    alvo: { tipo: "membros", ids: alvos },
    tipo,
    titulo: `${prefixo}${r.titulo}`,
    corpo: formatarDataHora(r.inicio),
    link: `/agencia/calendario?abrir=${r.id}`,
    referenciaId: r.id,
  });
}

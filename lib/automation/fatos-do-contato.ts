import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { lerContatosComInscricaoViva } from "@/lib/followup/inscricao-viva";

/**
 * OS FATOS DO CONTATO que as condições da regra perguntam (#3814).
 *
 * ─── Por que um módulo de leitura, e não um campo do evento ────────────────
 *
 * As condições do motor (`lib/automation/conditions.ts`) até aqui liam só o
 * payload do evento e campos de contato/negócio — tudo já no contexto. "O
 * contato tem follow-up vivo?" e "tem horário marcado?" não estão no evento:
 * são ESTADO de outras tabelas, e por isso precisam de leitura no banco.
 *
 * A leitura é feita UMA vez por avaliação (o motor a chama antes do laço de
 * regras e passa o resultado para o avaliador, que é síncrono), e uma vez por
 * FONTE: nada de uma consulta por regra, por condição ou por contato. Com
 * `contactIds` de um contato só, o lote de `inscricao-viva` é uma consulta
 * única.
 *
 * ─── A fonte de verdade do "follow-up vivo" ────────────────────────────────
 *
 * É a MESMA de `live_enrollment_exists`: o índice único
 * `idx_followup_enrollments_one_live`, lido pelo módulo
 * `lib/followup/inscricao-viva.ts` — o mesmo que a varredura de silêncio usa
 * antes de tentar inscrever. Inventar aqui uma segunda consulta (por exemplo,
 * só `status = 'active'`) faria a condição dizer "não" para quem está em
 * `paused_handoff` e a ação falhar em seguida: a regra viraria loteria.
 *
 * ─── Falha de leitura NÃO decide ───────────────────────────────────────────
 *
 * Se a consulta falhar, o fato fica `null` ("não medido") e a condição
 * correspondente avalia FALSO nos dois sentidos — nem "sim" nem "não". É a
 * diferença entre "medi e não tem" (`false`) e "não consegui medir" (`null`):
 * um `false` inventado faria a regra mandar a ação tentar de novo e bater no
 * 23505 que a condição existe para evitar.
 */

/** Os status que a agenda considera "horário marcado": o compromisso existe e vale. */
export const STATUS_MARCADOS = ["pending", "confirmed"] as const;

/**
 * Teto de horários lidos por contato. Um contato com mais compromissos futuros
 * que isto não é o caso desta condição ("tem horário?"), e a leitura precisa
 * ter tamanho conhecido — a alternativa é trazer a agenda inteira do contato.
 */
export const LIMITE_DE_HORARIOS = 50;

/** Um compromisso futuro do contato. `tipo` é o NOME do tipo de atendimento. */
export type HorarioMarcado = { starts_at: string; tipo: string | null };

export type FatosDoContato = {
  /** O instante da leitura (ISO). A janela "nos próximos N dias" conta daqui. */
  agora: string;
  /** `null` = não medido. `false` = medido e não tem follow-up vivo. */
  inscricao_viva: boolean | null;
  /** `null` = não medido. Lista vazia = medido e sem horário futuro. */
  horarios: HorarioMarcado[] | null;
};

type LinhaDeAgenda = {
  starts_at: string;
  calendar_event_types?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

/** O nome do tipo vem embutido na consulta (`calendar_event_types(name)`). */
function nomeDoTipo(linha: LinhaDeAgenda): string | null {
  const embutido = Array.isArray(linha.calendar_event_types)
    ? linha.calendar_event_types[0]
    : linha.calendar_event_types;
  const nome = embutido?.name;
  return typeof nome === "string" && nome.trim() !== "" ? nome : null;
}

/**
 * Lê os dois fatos do contato. Duas consultas no máximo (uma por fonte), feitas
 * em paralelo, e ZERO quando o chamador só chama o que precisa — o motor
 * pergunta antes se alguma regra casada usa estas condições
 * (`usaFatosDoContato`).
 *
 * `agora` é injetável para o teste; em produção é o relógio do processo, o
 * mesmo que a janela de dias usa.
 */
export async function carregarFatosDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  opcoes: { agora?: Date } = {},
): Promise<FatosDoContato> {
  const agora = (opcoes.agora ?? new Date()).toISOString();

  const [inscricao, horarios] = await Promise.all([
    lerContatosComInscricaoViva(admin, organizationId, [contactId]).then(
      (vivos) => vivos.has(contactId),
      (erro: unknown) => {
        logger.warn("[automation.fatos] não foi possível ler a inscrição viva do contato", {
          organization_id: organizationId,
          contact_id: contactId,
          error: erro instanceof Error ? erro.message : String(erro),
        });
        return null;
      },
    ),
    lerHorariosFuturos(admin, organizationId, contactId, agora).catch((erro: unknown) => {
      logger.warn("[automation.fatos] não foi possível ler a agenda do contato", {
        organization_id: organizationId,
        contact_id: contactId,
        error: erro instanceof Error ? erro.message : String(erro),
      });
      return null;
    }),
  ]);

  return { agora, inscricao_viva: inscricao, horarios };
}

/**
 * Os próximos compromissos do contato, do mais perto para o mais longe.
 *
 * `starts_at >= agora` já limita a leitura ao futuro, e `limit` a mantém com
 * tamanho conhecido; o filtro de janela (N dias) e de tipo é feito em memória
 * pelo avaliador, porque os dois são da REGRA, não da consulta.
 *
 * Cancelado, concluído e falta NÃO são "horário marcado": quem cancelou não tem
 * compromisso, e tratar a linha como viva faria a regra de reserva nunca
 * disparar para o contato que desmarcou.
 */
async function lerHorariosFuturos(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  agora: string,
): Promise<HorarioMarcado[]> {
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("starts_at, calendar_event_types(name)")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", [...STATUS_MARCADOS])
    .gte("starts_at", agora)
    .order("starts_at", { ascending: true })
    .limit(LIMITE_DE_HORARIOS);
  if (error) throw new Error(error.message);
  return ((data ?? []) as LinhaDeAgenda[])
    .filter((linha) => typeof linha.starts_at === "string")
    .map((linha) => ({ starts_at: linha.starts_at, tipo: nomeDoTipo(linha) }));
}

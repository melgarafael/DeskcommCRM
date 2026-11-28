/**
 * OS COMPROMISSOS JÁ MARCADOS DESTE CONTATO, NO RITUAL DE ABERTURA (issue #512).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * O contexto do turno entregava checkpoint, resumo, funil, memória e mensagens —
 * e nenhuma agenda:
 *
 *     $ grep -ciE "appointment|agendamento|calendar" get-lead-context.ts   -> 0
 *     CONTROLE POSITIVO, arquivo irmão:
 *     $ grep -ciE "appointment|agendamento|calendar" mcp/tools/agendamento.ts -> 45
 *
 * O agente marcava uma reunião e, minutos depois, não sabia que ela existia:
 * dizia ao cliente que o horário estava ocupado por outra pessoa quando o
 * ocupante era a reunião DELE, e negava o agendamento que ele mesmo tinha feito.
 *
 * ─── A armadilha que este arquivo evita de propósito ────────────────────────
 *
 * No motor, `leadId` É o `contact_id` (é a causa da issue #509). Uma consulta
 * que confiasse no NOME da variável em vez do significado plantaria a #509
 * dentro do conserto da #512. Por isso o parâmetro aqui se chama `contactId`, e
 * quem chama tem de olhar para o valor antes de passar.
 *
 * ─── Orçamento, e por que ele não é zelo ────────────────────────────────────
 *
 * O bloco vai no SUFIXO do prompt, depois do prefixo cacheável — então é pago em
 * TODA conversa, inclusive nas que nunca falam de horário. Sem teto, uma
 * instalação com muitos compromissos por contato vira regressão de custo em
 * cada turno. O teto corta a lista e DIZ que cortou.
 */
import type { Queryable } from "../queue/queue";
import { isoLocalComOffset, rotuloLocal } from "@/lib/tempo/agora";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";
import { rotuloDoLocal } from "@/lib/agenda/locais";

export interface CompromissoDoContato {
  id: string;
  title: string | null;
  starts_at: string | Date;
  ends_at: string | Date | null;
  time_zone?: string;
  status: string;
  meeting_state?: string;
  meeting_url?: string | null;
  location_kind?: string | null;
  location_details?: string | null;
}

/** Quantos compromissos futuros cabem no bloco antes de ele passar a truncar. */
export const MAXIMO_DE_COMPROMISSOS_NO_BLOCO = 5;

/**
 * Os compromissos ATIVOS e FUTUROS deste contato.
 *
 * `cancelled` fica de fora: um compromisso cancelado no bloco faria o agente
 * afirmar ao cliente uma reunião que não existe mais — trocaria o defeito de
 * "não vê o que marcou" por "promete o que foi desmarcado", que é pior.
 */
export async function compromissosDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<CompromissoDoContato[]> {
  const { rows } = await db.query<CompromissoDoContato>(
    `select id, title, starts_at, ends_at, time_zone, status, meeting_state, meeting_url,
            location_kind, location_details
       from calendar_appointments
      where organization_id = $1
        and contact_id = $2
        and status <> 'cancelled'
        and ends_at >= $3
      order by starts_at
      limit $4`,
    [organizationId, contactId, agora.toISOString(), MAXIMO_DE_COMPROMISSOS_NO_BLOCO + 1],
  );
  return rows;
}

/**
 * O bloco em texto. Vazio quando não há nada — um bloco dizendo "nenhum" custaria
 * tokens em toda conversa para informar ausência que o modelo não precisa saber.
 */
function formatarLinhaBase(c: CompromissoDoContato): string {
  const titulo = (c.title ?? "").trim() || "compromisso";
  const fuso = c.time_zone && fusoValido(c.time_zone) ? c.time_zone : FUSO_PADRAO;
  const inicio = new Date(c.starts_at);
  const fim = c.ends_at ? ` até ${isoLocalComOffset(new Date(c.ends_at), fuso)}` : "";
  // O revisor confere o local: sem ele aqui, o agente teria de adivinhar o que será cobrado.
  const local = rotuloDoLocal(c.location_kind, c.location_details);
  // O driver pg devolve Date; interpolá-la mostrava a hora do PROCESSO (UTC).
  // A hora de parede e o ISO com offset representam o mesmo instante, no fuso
  // da reserva. Nunca aplicar um deslocamento fixo de três horas.
  return `- ${rotuloLocal(inicio, fuso)} (${fuso}; início: ${isoLocalComOffset(inicio, fuso)})${fim} — ${titulo} (${c.status})${local ? ` — ${local}` : ""}`;
}

export function renderCompromissos(linhas: readonly CompromissoDoContato[]): string {
  if (linhas.length === 0) return "";

  const cabem = linhas.slice(0, MAXIMO_DE_COMPROMISSOS_NO_BLOCO);
  const truncou = linhas.length > MAXIMO_DE_COMPROMISSOS_NO_BLOCO;

  const itens = cabem.map(
    (c) =>
      `${formatarLinhaBase(c)}${c.meeting_state === "ready" && c.meeting_url ? ` — link da reunião: ${c.meeting_url}` : c.meeting_state === "pending" ? " — link ainda sendo criado" : c.meeting_state === "failed" ? " — link indisponível; a equipe precisa verificar" : ""}`,
  );

  // Truncar em silêncio faria o modelo afirmar que o cliente só tem estes — a
  // mesma classe de erro que a busca do catálogo cometia (#480).
  if (truncou) {
    itens.push(
      `- (há mais compromissos além destes ${MAXIMO_DE_COMPROMISSOS_NO_BLOCO}. ` +
        "NÃO diga que esta é a lista completa — consulte com crm_list_appointments se precisar.)",
    );
  }
  return itens.join("\n");
}

const JANELA_PASSADO_SEM_DESFECHO_MS = 30 * 24 * 60 * 60 * 1000;
const MAXIMO_PASSADOS_NO_BLOCO = 3;

/**
 * Compromissos recentes já vencidos que não foram cancelados nem receberam
 * desfecho (`completed` / `no_show`). Sem isto, quando muda a demanda ou passam
 * dias, a IA esquece que houve um horário marcado que não se concretizou.
 */
export async function compromissosPassadosSemDesfecho(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<CompromissoDoContato[]> {
  const limiteInferior = new Date(agora.getTime() - JANELA_PASSADO_SEM_DESFECHO_MS);
  const { rows } = await db.query<CompromissoDoContato>(
    `select id, title, starts_at, ends_at, time_zone, status, meeting_state, meeting_url,
            location_kind, location_details
       from calendar_appointments
      where organization_id = $1
        and contact_id = $2
        and status in ('pending', 'confirmed')
        and ends_at < $3
        and ends_at >= $4
        and outcome_recorded_at is null
      order by starts_at desc
      limit $5`,
    [organizationId, contactId, agora.toISOString(), limiteInferior.toISOString(), MAXIMO_PASSADOS_NO_BLOCO],
  );
  return rows;
}

export function renderCompromissosPassados(linhas: readonly CompromissoDoContato[]): string {
  if (linhas.length === 0) return "";
  const itens = linhas.map(
    (c) =>
      `${formatarLinhaBase(c)} — [DATA JÁ PASSOU E SEM DESFECHO REGISTRADO${c.location_kind === "google_meet" && !c.meeting_url ? "; link do Meet não foi gerado" : ""}]`,
  );
  return `Compromissos anteriores pendentes de realização/remarcação:\n${itens.join("\n")}`;
}

export async function buildCompromissosBlock(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<string> {
  const [futuros, passados] = await Promise.all([
    compromissosDoContato(db, organizationId, contactId, agora),
    compromissosPassadosSemDesfecho(db, organizationId, contactId, agora),
  ]);
  return [renderCompromissos(futuros), renderCompromissosPassados(passados)].filter(Boolean).join("\n");
}

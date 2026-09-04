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

export interface CompromissoDoContato {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
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
    `select id, title, starts_at, ends_at, status
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
export function renderCompromissos(linhas: readonly CompromissoDoContato[]): string {
  if (linhas.length === 0) return "";

  const cabem = linhas.slice(0, MAXIMO_DE_COMPROMISSOS_NO_BLOCO);
  const truncou = linhas.length > MAXIMO_DE_COMPROMISSOS_NO_BLOCO;

  const itens = cabem.map((c) => {
    const titulo = (c.title ?? "").trim() || "compromisso";
    const fim = c.ends_at ? ` até ${c.ends_at}` : "";
    return `- ${c.starts_at}${fim} — ${titulo} (${c.status})`;
  });

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

export async function buildCompromissosBlock(
  db: Queryable,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<string> {
  return renderCompromissos(await compromissosDoContato(db, organizationId, contactId, agora));
}

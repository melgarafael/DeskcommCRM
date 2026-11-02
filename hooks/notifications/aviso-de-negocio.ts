/**
 * A REGRA QUE DECIDE O AVISO DE NEGÓCIO (lead assumido / ganho / perdido).
 *
 * ⚠️ POR QUE ISTO NÃO COMPARA MAIS COM O `old` DO REALTIME (issue #3040).
 *
 * O `postgres_changes` entrega o `old` do UPDATE com APENAS a chave primária
 * enquanto a tabela não tem `REPLICA IDENTITY FULL` — e `crm_leads` não tem
 * nenhuma no baseline. Medido em produção (1.84.0): com o `#2958` cada resposta
 * do vendedor carimba `last_activity_at` no negócio aberto; o evento chega com
 * `new` completo e `old = { id }`, o `owner_user_id` anterior saía sempre
 * `null`, e o teste `owner !== ownerAntes` passava SEMPRE — o vendedor recebia
 * "Lead atribuído a você" a cada mensagem enviada, num negócio que já era dele.
 * `statusAntes` tinha o mesmo vício em `lead_won`/`lead_lost`.
 *
 * A saída escolhida é a do próprio autor da issue (alternativa b): comparar com
 * o ÚLTIMO ESTADO VISTO pelo cliente, guardado por negócio — sem coluna nova e
 * sem tocar em `REPLICA IDENTITY` (decisão do mantenedor, não desta correção).
 * O `old` só volta a valer como histórico quando ele de fato carrega os campos
 * (instalação com `REPLICA IDENTITY FULL`), e é isso que `estadoDoAntigo` mede.
 *
 * ─── E quando a sessão NUNCA viu o negócio? (issue #3224) ───────────────────
 *
 * A memória só aprende com o próprio canal, e o primeiro UPDATE que a aba
 * recebe de um negócio é, no caso mais comum, justamente a atribuição: negócio
 * parado, aba logo depois de recarregar, e — com a visibilidade padrão
 * `own_and_unassigned` — a reatribuição de A para B, em que B só passa a
 * enxergar o negócio quando já é dele. Sem histórico, `avisosDoNegocio` ficava
 * calado por decisão (silêncio > aviso por engano) e o aviso dentro do app não
 * saía.
 *
 * A saída é a que a própria #3224 propõe: em vez de inferir a mudança no
 * cliente, perguntar ao BANCO. O gatilho `fn_emit_event_on_lead_change` grava
 * `lead.assigned` / `lead.won` / `lead.lost` no `event_log` comparando OLD e
 * NEW de verdade, DENTRO da transação do UPDATE (nenhum outro emissor é
 * autorizado — `tests/invariants/evento-de-negocio-so-nasce-do-negocio`), e é
 * `avisosDoBanco` quem casa esse evento com o UPDATE de que ele nasceu — pelo
 * carimbo da transação, sem relógio de navegador no meio. Sem histórico E sem
 * evento do banco na transação certa, o silêncio continua sendo a resposta: o
 * defeito da #3040 não volta pela porta dos fundos.
 */

/** O que o cliente precisa lembrar de um negócio para saber se algo mudou. */
export interface EstadoVisto {
  owner_user_id: string | null;
  status: string | null;
}

export type AvisoDeNegocio = "lead_assigned" | "lead_won" | "lead_lost";

/**
 * Uma linha do `event_log` reduzida ao que a decisão usa — o que devolve
 * `GET /api/v1/leads/[id]/eventos`. Organização e negócio voltam intactos
 * porque aqui são filtrados de novo (defesa em profundidade do critério
 * "evento de outra organização nunca vira aviso").
 */
export interface EventoDeNegocio {
  organization_id: string;
  event_type: string;
  entity_id: string | null;
  created_at: string;
  /** `payload.to_user_id` — só `lead.assigned` traz; nulo = dono agente. */
  to_user_id: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * O `old` do evento como histórico — ou `null` quando ele não é um histórico.
 *
 * Sem `REPLICA IDENTITY FULL` o `old` traz só a chave primária: nenhum dos
 * campos que a decisão usa. Devolver `null` nesse caso é o que impede o defeito
 * de voltar pela porta dos fundos (um `{}` viraria "responsável ninguém").
 */
export function estadoDoAntigo(antigo: Record<string, unknown> | null): EstadoVisto | null {
  if (!antigo) return null;
  if (!("owner_user_id" in antigo) && !("status" in antigo)) return null;
  return { owner_user_id: texto(antigo.owner_user_id), status: texto(antigo.status) };
}

/** O estado que o evento atual passa a ser o histórico do negócio. */
export function estadoDoNovo(novo: Record<string, unknown>): EstadoVisto {
  return { owner_user_id: texto(novo.owner_user_id), status: texto(novo.status) };
}

/**
 * Quais avisos este UPDATE merece — a função que decide a notificação.
 *
 * `anterior` é o último estado visto deste negócio (`null` = desconhecido).
 * Notifica só quando o responsável é `userId` E o campo mudou DE VERDADE em
 * relação ao que o cliente já tinha visto.
 *
 * Sem histórico (`anterior === null`) a resposta é `[]` — e quem passa a
 * cobrir esse caso é o BANCO (`avisosDoBanco`, issue #3224), nunca uma
 * suposição daqui.
 */
export function avisosDoNegocio(
  anterior: EstadoVisto | null,
  novo: EstadoVisto,
  userId: string,
): AvisoDeNegocio[] {
  // Sem histórico não há como dizer que mudou: registra e fica quieto.
  if (!anterior) return [];
  if (!novo.owner_user_id || novo.owner_user_id !== userId) return [];

  const avisos: AvisoDeNegocio[] = [];
  if (novo.owner_user_id !== anterior.owner_user_id) avisos.push("lead_assigned");
  if (novo.status === "won" && anterior.status !== "won") avisos.push("lead_won");
  if (novo.status === "lost" && anterior.status !== "lost") avisos.push("lead_lost");
  return avisos;
}

/**
 * O instante da transação em microssegundos (string) — a CHAVE do casamento
 * entre o UPDATE do Realtime e o evento do `event_log`.
 *
 * `trg_crm_leads_updated_at` põe `updated_at = now()` no BEFORE UPDATE e o
 * `fn_emit_event_on_lead_change` grava o evento no AFTER, na MESMA transação:
 * `now()` é o carimbo da transação, então os dois registram o MESMO instante.
 * É o que permite dizer "este evento nasceu deste UPDATE" sem depender do
 * relógio do navegador. `null` = não deu para ler a data (linha sem
 * `updated_at`, por exemplo) — e aí não há transação a casar.
 */
export function carimboDaTransacao(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  // timestamptz chega como string nos dois transportes. Date.parse sozinho
  // descarta os três últimos dígitos do Postgres e confundiria transações.
  const partes = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(valor);
  if (!partes) return null;
  const fracao = (partes[3] ?? "").padEnd(6, "0");
  const fuso = partes[4]!.replace(/^([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(`${partes[1]}T${partes[2]}.${fracao.slice(0, 3)}${fuso}`);
  if (!Number.isFinite(ms)) return null;
  return (BigInt(ms) * 1000n + BigInt(fracao.slice(3))).toString();
}

/**
 * Quais avisos o BANCO atesta para este UPDATE — o caminho de quem a sessão
 * nunca viu o negócio (issue #3224).
 *
 * O evento só vale se nasceu no instante EXATO da transação do UPDATE,
 * da MESMA organização e do MESMO negócio. É
 * esse casamento que mantém a #3040 fora: a atribuição de ontem, que a aba
 * nunca viu, não vira aviso hoje — o que a aba vê agora é o carimbo da própria
 * mensagem do vendedor, e o evento antigo não casa com ele.
 *
 * O portão do destinatário é o MESMO da regra da memória: só o responsável
 * ATUAL (`novo.owner_user_id === userId`) é avisado, e `lead.assigned` ainda
 * confere o `to_user_id` — dono agente (`owner_kind = 'ai'`, `to_user_id`
 * nulo) não vira aviso de gente. Ganho e perdido pedem o status novo igual ao
 * do estado, como faz `avisosDoNegocio`.
 */
export function avisosDoBanco(entrada: {
  /** A organização ATIVA da sessão — evento de outra org nunca passa. */
  organizationId: string;
  leadId: string;
  /** `updated_at` do `new`, já normalizado por `carimboDaTransacao`. */
  carimboDoUpdate: string;
  eventos: EventoDeNegocio[];
  novo: EstadoVisto;
  userId: string;
}): AvisoDeNegocio[] {
  const { organizationId, leadId, carimboDoUpdate, eventos, novo, userId } = entrada;
  if (!novo.owner_user_id || novo.owner_user_id !== userId) return [];
  if (!/^-?\d+$/.test(carimboDoUpdate)) return [];

  const daTransacao = eventos.filter((evento) => {
    if (evento.organization_id !== organizationId) return false;
    if (evento.entity_id !== leadId) return false;
    const quando = carimboDaTransacao(evento.created_at);
    return quando !== null && quando === carimboDoUpdate;
  });

  const avisos: AvisoDeNegocio[] = [];
  if (daTransacao.some((evento) => evento.event_type === "lead.assigned" && evento.to_user_id === userId)) {
    avisos.push("lead_assigned");
  }
  if (novo.status === "won" && daTransacao.some((evento) => evento.event_type === "lead.won")) {
    avisos.push("lead_won");
  }
  if (novo.status === "lost" && daTransacao.some((evento) => evento.event_type === "lead.lost")) {
    avisos.push("lead_lost");
  }
  return avisos;
}

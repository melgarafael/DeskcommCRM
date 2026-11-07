import type { LeadStatus } from "@/lib/types/leads";

/** O mínimo para decidir qual negócio da pessoa está em jogo agora. */
export interface LeadCandidate {
  id: string;
  /**
   * Obrigatório para a função poder RECUSAR uma lista misturada — ver
   * `assertMesmaOrg`. Ela é pura e não consulta nada; sem este campo, não teria
   * como se defender de um chamador que esqueceu o filtro.
   */
  organization_id: string;
  pipeline_id: string;
  status: LeadStatus;
  /** ISO; null quando o lead nunca teve atividade. */
  last_activity_at: string | null;
  created_at: string;
  /**
   * Como o contato chega a este negócio (#3669). `principal` é
   * `crm_leads.contact_id`; `relacionado` é a lista "Pessoas relacionadas"
   * (`crm_lead_links`, `target_kind='contact'`, `link_kind='related'`, #3083).
   * Ausente vale `principal`: é o que todo chamador anterior a este campo
   * entrega, e por isso nenhum deles muda de comportamento.
   */
  via?: "principal" | "relacionado";
}

export type ActiveLeadResolution =
  | { routed: true; leadId: string }
  | {
      routed: false;
      /** Vai para `event_log` como motivo do `agent.activity_unrouted`. */
      reason: "no_open_lead" | "ambiguous_open_leads";
      candidateIds: string[];
    };

/**
 * Qual negócio da pessoa recebe a atividade que acabou de acontecer.
 *
 * O harness trata "lead" como o CONTATO (inbound-turn.ts: `leadId = contact_id`)
 * e `lead_state` é único por contato; o CRM trata lead como NEGÓCIO, e a mesma
 * pessoa pode ter N negócios abertos. Este é o ponteiro entre os dois mundos.
 *
 * Regra (§3.2): negócio ABERTO mais recentemente ativo, preferindo o pipeline
 * default. Quando o alvo é ambíguo ou inexistente, **não adivinha**: devolve
 * `routed: false` e o chamador registra `agent.activity_unrouted` no event_log.
 *
 * Mover o card errado do cliente errado é o único bug desta entrega visível
 * para o cliente final — não-roteado é barulho no log, roteado errado é dano.
 * Por isso "empatou" é ambíguo, e não "escolhe o primeiro".
 *
 * PESSOA RELACIONADA (#3669): o comprador ou o fixo da loja, ligado ao negócio
 * do cliente pela lista "Pessoas relacionadas", também acha o negócio — é assim
 * que a ligação do segundo número cai no card certo. Mas o negócio em que o
 * contato é PRINCIPAL sempre vence: o relacionado só entra na conta quando não
 * há nenhum aberto como principal. Assim, quem já tinha um negócio próprio
 * continua exatamente como antes, e ninguém que não usa a lista muda nada.
 */
export function resolveActiveLeadForContact(
  candidates: LeadCandidate[],
  opts: { defaultPipelineId?: string | null } = {},
): ActiveLeadResolution {
  assertMesmaOrg(candidates);
  const todosAbertos = semRepetir(candidates.filter((c) => c.status === "open"));
  const comoPrincipal = todosAbertos.filter((c) => c.via !== "relacionado");
  const abertos = comoPrincipal.length > 0 ? comoPrincipal : todosAbertos;

  if (abertos.length === 0) {
    return { routed: false, reason: "no_open_lead", candidateIds: [] };
  }

  // Um único negócio aberto não é ambíguo, esteja em que pipeline estiver:
  // é o negócio da pessoa. Exigir o pipeline default aqui deixaria de rotear o
  // caso mais comum de quem usa um pipeline só (que não é o default).
  if (abertos.length === 1) {
    return { routed: true, leadId: abertos[0]!.id };
  }

  const noDefault = opts.defaultPipelineId
    ? abertos.filter((c) => c.pipeline_id === opts.defaultPipelineId)
    : [];
  const pool = noDefault.length > 0 ? noDefault : abertos;

  if (pool.length === 1) {
    return { routed: true, leadId: pool[0]!.id };
  }

  const ordenados = [...pool].sort((a, b) => atividade(b) - atividade(a));
  const topo = atividade(ordenados[0]!);
  const empatados = ordenados.filter((c) => atividade(c) === topo);

  if (empatados.length > 1) {
    // Dois negócios da mesma pessoa tocados no mesmo instante: qualquer escolha
    // aqui é chute com 50% de chance de mover o card errado.
    return {
      routed: false,
      reason: "ambiguous_open_leads",
      candidateIds: empatados.map((c) => c.id),
    };
  }

  return { routed: true, leadId: ordenados[0]!.id };
}

/**
 * A lista JÁ tem de vir filtrada por `organization_id` — esta função é pura e
 * não consulta o banco, então não consegue verificar tenancy sozinha.
 *
 * Por que falhar alto em vez de confiar no chamador: o resultado daqui vira uma
 * ESCRITA em `crm_lead_activities` com FK para o lead. Uma lista misturada faria
 * a função rotear a atividade de um tenant para o negócio de OUTRO — e o
 * vazamento pareceria decisão correta, porque ela "decidiu certo" com a lista
 * que recebeu. Erro de tenancy que passa despercebido é o mais caro do repo
 * (`CLAUDE.md`: toda query tenant-aware filtra `organization_id` explicitamente).
 *
 * Lança em vez de devolver `routed: false`: candidato de outra org não é
 * ambiguidade de negócio, é bug de quem chamou — e bug de chamador tem de
 * estourar no desenvolvimento, não virar linha silenciosa no `event_log`.
 */
function assertMesmaOrg(candidates: LeadCandidate[]): void {
  if (candidates.length < 2) return;
  const orgs = new Set(candidates.map((c) => c.organization_id));
  if (orgs.size > 1) {
    throw new Error(
      `resolveActiveLeadForContact: candidatos de ${orgs.size} organizações diferentes ` +
        `(${[...orgs].join(", ")}). A lista tem de vir filtrada por organization_id.`,
    );
  }
}

/**
 * O mesmo negócio duas vezes (principal E relacionado) conta uma vez só, como
 * principal. A rota da lista recusa o principal como participante, mas o
 * principal do negócio pode mudar depois do vínculo; sem isto, a cópia
 * empataria consigo mesma e o roteamento viraria "ambíguo" por nada.
 */
function semRepetir(candidates: LeadCandidate[]): LeadCandidate[] {
  const porId = new Map<string, LeadCandidate>();
  for (const c of candidates) {
    const visto = porId.get(c.id);
    if (!visto || (visto.via === "relacionado" && c.via !== "relacionado")) porId.set(c.id, c);
  }
  return [...porId.values()];
}

/** Quando este negócio se mexeu pela última vez (cai para a criação). */
function atividade(lead: LeadCandidate): number {
  const iso = lead.last_activity_at ?? lead.created_at;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

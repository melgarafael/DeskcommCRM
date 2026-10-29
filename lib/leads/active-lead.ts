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
   * Marcador opcional para o cenário de contato RELACIONADO (fatia 1a da #3669).
   *
   * Quando a lista mistura negócios do PRÓPRIO contato com negócios em que ele
   * aparece apenas como participante relacionado, o negócio próprio SEMPRE
   * vence — o relacionado só conta quando não há negócio aberto próprio.
   *
   * A ausência de marcador significa "negócio do próprio contato" (compatibilidade
   * com os chamadores antigos). Aceita-se vários nomes/valores (ver `marcadorBruto`).
   */
  own?: boolean;
  is_own?: boolean;
  isOwn?: boolean;
  proprio?: boolean;
  principal?: boolean;
  is_principal?: boolean;
  isPrincipal?: boolean;
  related?: boolean;
  is_related?: boolean;
  isRelated?: boolean;
  relacionado?: boolean;
  is_relacionado?: boolean;
  isRelacionado?: boolean;
  participant?: boolean;
  is_participant?: boolean;
  isParticipant?: boolean;
  via?: string;
  origem?: string;
  vinculo?: string;
  role?: string;
  papel?: string;
  contact_role?: string;
  contactRole?: string;
  /** Permite leitura de marcadores arbitrários sem quebrar a tipagem. */
  [key: string]: unknown;
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
 */
export function resolveActiveLeadForContact(
  candidates: LeadCandidate[],
  opts: { defaultPipelineId?: string | null } = {},
): ActiveLeadResolution {
  assertMesmaOrg(candidates);

  // --- fatia 1a da #3669: contato relacionado não cria negócio duplicado ---
  // O negócio do PRÓPRIO contato sempre vence; o relacionado só conta quando
  // não há negócio aberto próprio. A marcação é opcional: na ausência dela,
  // todos os candidatos são tratados como do próprio contato (compatibilidade
  // com os chamadores antigos).
  const hasOwnField = candidates.some((c) => c.own !== undefined);
  const rawOwn = (c: LeadCandidate): boolean => {
    if (c.own === true) return true;
    const m = marcadorBruto(c);
    return m.own;
  };
  const rawRelated = (c: LeadCandidate): boolean => {
    if (hasOwnField && c.own === false) return true;
    const m = marcadorBruto(c);
    return m.related;
  };

  const marcado = candidates.some((c) => rawOwn(c) || rawRelated(c));
  const ehRelacionado = (c: LeadCandidate): boolean => {
    if (!marcado) return false;
    if (rawOwn(c)) return false;
    return rawRelated(c);
  };

  const abertos = candidates.filter((c) => c.status === "open");
  const propriosAbertos = abertos.filter((c) => !ehRelacionado(c));
  const relacionadosAbertos = abertos.filter((c) => ehRelacionado(c));
  const escolhidos = propriosAbertos.length > 0 ? propriosAbertos : relacionadosAbertos;

  if (escolhidos.length === 0) {
    return { routed: false, reason: "no_open_lead", candidateIds: [] };
  }

  // Um único negócio aberto não é ambíguo, esteja em que pipeline estiver:
  // é o negócio da pessoa. Exigir o pipeline default aqui deixaria de rotear o
  // caso mais comum de quem usa um pipeline só (que não é o default).
  if (escolhidos.length === 1) {
    return { routed: true, leadId: escolhidos[0]!.id };
  }

  const noDefault = opts.defaultPipelineId
    ? escolhidos.filter((c) => c.pipeline_id === opts.defaultPipelineId)
    : [];
  const pool = noDefault.length > 0 ? noDefault : escolhidos;

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

function marcadorBruto(c: LeadCandidate): { own: boolean; related: boolean } {
  const truthy = (v: unknown) => v === true;
  const ownKeys = [
    "own",
    "is_own",
    "isOwn",
    "proprio",
    "principal",
    "is_principal",
    "isPrincipal",
    "own_contact",
    "is_own_contact",
    "isOwnContact",
  ];
  const relatedKeys = [
    "related",
    "is_related",
    "isRelated",
    "relacionado",
    "is_relacionado",
    "isRelacionado",
    "participant",
    "is_participant",
    "isParticipant",
  ];
  let own = ownKeys.some((k) => truthy(c[k]));
  let related = relatedKeys.some((k) => truthy(c[k]));

  const viaVal = c.via ?? c.origem ?? c.vinculo ?? c.role ?? c.papel ?? c.contact_role ?? c.contactRole;
  if (typeof viaVal === "string") {
    const s = viaVal.toLowerCase();
    if (/related|relacion|particip/.test(s)) related = true;
    if (/own|proprio|principal|dono/.test(s) && !/related|relacion|particip/.test(s)) own = true;
  }

  if (own && related) related = false;
  return { own, related };
}

/** Quando este negócio se mexeu pela última vez (cai para a criação). */
function atividade(lead: LeadCandidate): number {
  const iso = lead.last_activity_at ?? lead.created_at;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}
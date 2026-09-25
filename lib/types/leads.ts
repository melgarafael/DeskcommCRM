import type { ScoreBand } from "@/lib/kanban/score-band";

/**
 * Canonical Lead shape returned by the `/api/v1/leads/*` endpoints.
 * Mirrors `crm_leads` columns (Spec 04 §schema). Status transitions go through
 * the DB trigger `fn_crm_lead_close_on_stage` — the API never sets `status`
 * directly (P-02).
 */
export type LeadStatus = "open" | "won" | "lost";

/**
 * 0070 — o dono do negócio é humano ou agente de IA (mesmo padrão de
 * `conversations.assignee_kind`, 0032). `null` = sem dono.
 */
export type OwnerKind = "user" | "ai" | null;

/**
 * Identidade do agente dono, resolvida no servidor e anexada ao lead pela rota
 * do board. **Não é coluna** de `crm_leads`.
 *
 * Por que viaja com o lead em vez de sair de uma lista de agentes: "quem PODE
 * receber um lead" (picker — só agente ativo) e "quem É o dono deste lead"
 * (exibição — qualquer agente, inclusive desativado ou arquivado) são perguntas
 * diferentes. Resolver a segunda pela primeira faz o dono ficar anônimo no dia
 * em que alguém desativa o agente.
 */
export interface LeadOwnerAgent {
  id: string;
  name: string;
  /** Versão publicada no momento da leitura — nunca congelada no lead. */
  version_number: number | null;
}

export interface Lead {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  title: string;
  description: string | null;
  status: LeadStatus;
  lost_reason: string | null;
  position_in_stage: number;
  value_cents: number | null;
  currency: string | null;
  owner_user_id: string | null;
  /** 0070: quem é dono do negócio — humano, agente de IA, ou ninguém. */
  owner_kind: OwnerKind;
  /** 0070: identidade do agente dono (ai_agents.id), nunca a versão. */
  owner_agent_id: string | null;
  /** Derivado (não é coluna): quem é o agente dono — ver LeadOwnerAgent. */
  owner_agent?: LeadOwnerAgent | null;
  /**
   * Derivado (não é coluna): a próxima ação que o agente propôs para o CONTATO,
   * já roteada para o negócio ativo dele. Ver lib/leads/next-action.ts — só
   * aparece quando o roteamento é inequívoco.
   */
  next_action?: { label: string; seq: number; proposed_at: string } | null;
  /**
   * Derivado (não é coluna): o score vem de `crm_lead_scores` por LEFT JOIN.
   *
   * Ausente é estado LEGÍTIMO (sinal insuficiente, cenário 17) — por isso LEFT
   * e não INNER: um INNER apagaria do board justamente os leads sem sinal, que
   * são os que mais precisam de atenção humana.
   */
  /**
   * Derivado (não é coluna): a conversa mais recente do CONTATO deste negócio,
   * com a última mensagem — o atalho do quadro para o inbox.
   *
   * Ausente é estado LEGÍTIMO e comum: lead criado à mão ou por webhook não tem
   * contato, e contato sem conversa existe. O card precisa saber a diferença
   * entre "não há conversa" e "ainda não carregou" — por isso `undefined` e não
   * um objeto vazio.
   */
  conversa?: {
    id: string;
    /** O que a lista do inbox mostra: última mensagem, já truncada na origem. */
    preview: string | null;
    last_message_at: string | null;
    unread: number;
  } | null;
  score?: {
    probability: number;
    reason: string;
    /** A faixa PERSISTIDA. A UI não a recalcula — ver lib/kanban/score-band.ts. */
    band: ScoreBand;
    factors: Array<{ pontos: number; frase: string; ancora?: { kind: string; id: string } }>;
    at: string | null;
  } | null;
  assigned_at: string | null;
  last_activity_at: string | null;
  expected_close_date: string | null;
  closed_at: string | null;
  source: string;
  source_metadata: Record<string, unknown>;
  external_id: string | null;
  custom_fields: Record<string, unknown>;
  tags: string[];
  /**
   * Derivado (não é coluna): os marcadores do CONTATO deste negócio.
   *
   * O produto tem DUAS caixas de marcador e elas não são a mesma: `tags`, acima,
   * é do negócio e se escreve em "Editar lead"; esta é da pessoa, e se escreve
   * no Inbox e na ficha — é a que a campanha lê. O quadro precisa das duas para
   * o filtro não mentir, e por não ser coluna ela é opcional: um negócio sem
   * contato (criado à mão ou por webhook) simplesmente não tem.
   */
  contact_tags?: string[];
  /**
   * Derivado (não é coluna): telefone, e-mail e links (Instagram, site, Google
   * Meu Negócio…) do CONTATO deste negócio — o que o card do funil mostra sem
   * abrir o dossiê. Ausente quando o negócio não tem contato, o contato foi
   * anonimizado (LGPD) ou o campo está vazio: o payload do quadro não engorda.
   * Os links vêm de `contacts.custom_fields` (`lib/leads/links-de-contato.ts`),
   * já validados — só http/https.
   */
  contact_phone?: string;
  contact_email?: string;
  contact_links?: Array<{ tipo: string; href: string }>;
  /**
   * Derivado (não é coluna): os marcadores das CONVERSAS do contato deste
   * negócio — a terceira caixa, "Tags da conversa" no painel do Inbox, onde a
   * IA também escreve. União de TODAS as conversas do contato, não só da mais
   * recente. Filtrar por ela é decisão do dono (doc 40, item 7, 19/09).
   */
  conversation_tags?: string[];
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
}

/**
 * Tool consolidada `get_lead_context` pós-fusão: o payload CURADO (contato +
 * últimas N mensagens) agora vem de LEITURA DIRETA das tabelas canônicas do CRM
 * (contacts/conversations/messages — mesmo banco), não mais de tools MCP.
 *
 * Garantias preservadas do design original:
 *   - org-scoped: TODA query filtra organization_id + contact_id de fonte
 *     confiável (closure do job — regra dura nº 1), nunca de payload;
 *   - erro vira MENSAGEM DE ENSINO pt-br pro modelo, nunca stack cru;
 *   - determinístico: mesmo input ⇒ mesmo payload byte-a-byte (truncamento é
 *     função pura do conteúdo);
 *   - is_blocked lido DIRETO da fonte (contacts) — não existe mais cache.
 */
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import { deriveLgpdFromContact, type LgpdInput } from '../../guardrails/lgpd/legal-basis';
import { isoLocalComOffset } from '@/lib/tempo/agora';
import { logger } from '@/lib/logger';
import { nomeDoContato } from '@/lib/contacts/rotulo-do-contato';
import { lerRemetenteDeGrupo } from '@/lib/messaging/remetente-de-grupo';
// A mesma régua de "primeiro nome" do balão (#4031): o rótulo do prompt e o da
// tela saem iguais para a mesma pessoa.
import { primeiroNomeDeQuemEnviou } from '@/lib/inbox/nome-no-balao';
import { frameMediaBody, INICIO_DA_MOLDURA_DE_MIDIA, MARCADOR_IMAGEM_NAO_VISTA } from './moldura-de-midia';

// A régua mora num módulo folha para a tela usar a mesma conta (ver o cabeçalho de lá).
import { countPayloadTokens } from '@/lib/ai/estimativa-de-tokens';
export { CHARS_PER_TOKEN, countPayloadTokens } from '@/lib/ai/estimativa-de-tokens';

/** Knobs do payload (env LEAD_CONTEXT_*; defaults documentados no .env.example). */
export interface LeadContextKnobs {
  /** Últimas N mensagens do histórico incluídas (default 20). */
  historyLimit: number;
  /** Teto do payload serializado, contado por countPayloadTokens (default 1000). */
  maxTokens: number;
  /**
   * O agente que vai ler vê imagens (`image_vision_enabled`, 9108)? `false` troca
   * toda foto do histórico por `MARCADOR_IMAGEM_NAO_VISTA` — mesmo quando a
   * descrição existe porque outro agente da empresa a pediu. Ausente = vê (quem
   * lê sem agente: follow-up, classificador).
   */
  verImagens?: boolean;
}

/** Uma mensagem do histórico, já curada. */
export interface LeadContextMessage {
  direction: 'inbound' | 'outbound';
  /** Corpo textual; mídia usa o derivado (transcrição/visão/pdf) ou marcador [tipo]. */
  body: string;
  /**
   * Quem escreveu esta mensagem (#2729 nos grupos, #4580 nas enviadas).
   *
   * Numa conversa 1:1 RECEBIDA o autor é óbvio: é o contato da ficha, e o campo
   * fica ausente. Num grupo há três pessoas na mesma conversa — a empresa, o
   * cliente e a dona — e sem este campo o modelo lê todas elas como a MESMA voz,
   * ou como "o cliente". O dado já existe gravado (`messages.metadata.group_sender`,
   * do ingest de grupo); ele só não chegava aqui.
   *
   * Nas mensagens ENVIADAS o autor também vinha ausente, e o efeito medido é o
   * da #4580: a resposta do agente de vendas, a do agente de suporte e a de uma
   * pessoa da equipe chegavam ao modelo do mesmo jeito ("nós"), e o agente lia o
   * que outro escreveu como se fosse dele. Aqui o rótulo segue o vocabulário da
   * tela (`MessageBubble.senderLabel`, a mesma régua para o operador): `IA · {nome}`
   * do agente que enviou, `Atendente · {primeiro nome}` de quem escreveu pela
   * Caixa de entrada, e os emissores que não são nem gente nem agente com o
   * rótulo que a coluna `messages.sent_via` garante (`Automação`, `Sistema`,
   * `Celular`). O `phone` fica nulo nas enviadas: quem mandou não é participante
   * de grupo, e telefone de atendente não é dado do prompt. `lid` fica de fora
   * de propósito — é identificador interno do WhatsApp, o modelo não decide nada
   * com ele, e o `phone` já é o que a tela mostra.
   */
  sender?: { name: string | null; phone: string | null };
  /**
   * ISO 8601 no FUSO DA ORGANIZAÇÃO, com o offset real daquele instante
   * (`2026-09-02T15:45:38-03:00`) — nunca UTC cru. Um agente instruído a ler o
   * horário de cada mensagem para decidir se a loja está aberta precisa da hora
   * de PAREDE do tenant, a mesma que o bloco `## Agora` do turno usa; entregar
   * aqui o `+00` do fuso da sessão do Postgres foi o defeito medido em produção
   * que `isoLocalComOffset` (lib/tempo/agora.ts) existe para consertar. Ainda
   * parseável por `Date.parse` (o offset preserva o instante exato).
   */
  sent_at: string;
  /** Metadados de mídia (Onda 3): presentes só em mensagens com mídia. */
  type?: string;
  media_storage_path?: string | null;
  media_mime?: string | null;
}

/**
 * A última decisão HUMANA sobre a próxima ação que o agente propôs.
 *
 * Sem isto, gravar a recusa não servia para nada: a Wave 4 mostrava a decisão ao
 * humano e a escondia de quem precisava dela — evento sem consumer, e o agente
 * reproporia o que já foi negado. A promessa do épico é que o que o humano
 * decide vira contexto que a IA usa para retomar.
 *
 * `action` viaja junto porque "aprovado" sem dizer O QUÊ não serve ao próximo
 * turno.
 */
export interface UltimaDecisaoHumana {
  action: string;
  decision: 'approved' | 'dismissed';
  at: string;
}

/**
 * N7 — o desfecho da última proposta com desfecho real, para o agente não
 * oferecer de novo o que já foi recusado (nem comemorar o que já foi aceito).
 *
 * OPCIONAL no tipo pelo MESMO motivo de `contact_id` (ver acima): exigir
 * obrigaria a editar fixtures em `tests/invariants/**`, que é congelado. A
 * produção (getLeadContext) sempre o preenche; quem lê trata ausente como
 * "sem proposta com desfecho".
 */
export interface UltimaProposta {
  status: string;
  total_cents: number;
  decision_reason: string | null;
  numero: number | null;
  ano: number | null;
}

/** Payload curado que o modelo recebe. */
export interface LeadContext {
  /** ⚠️ É o id do CONTATO, não de um lead do funil. Ver `contact_id` abaixo. */
  lead_id: string;
  /**
   * O mesmo valor de `lead_id`, com o nome verdadeiro (issue #509).
   *
   * OPCIONAL no tipo, e não por preguiça: exigir o campo obrigaria a editar
   * fixtures em todo `tests/invariants/**` que monta contexto à mão. Na época em
   * que nasceu, o diretório era congelado pelo hook de governança — hoje editar é
   * livre (`loop/hooks/guard-invariants.sh`), e o opcional continua valendo pelo
   * motivo que sobra: a produção sempre o preenche; quem constrói contexto à mão
   * num teste não precisa dele.
   */
  contact_id?: string;
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    tags: string[];
    /** contacts.is_blocked lido NESTE turno (fonte da verdade do gate 1). */
    is_blocked: boolean;
    /**
     * Spec 21: `contacts.is_personal` lido NESTE turno, ao lado do bloqueio.
     *
     * OPCIONAL no tipo pelo mesmo motivo de `contact_id`: exigir obrigaria a
     * editar fixtures em `tests/invariants/**`, que é congelado. A produção
     * sempre preenche; quem constrói contexto à mão num teste não precisa.
     */
    is_personal?: boolean;
  };
  conversation_id: string | null;
  previous_service?: { label: string; outcomes: string[] };
  /**
   * `null` quando nenhum humano decidiu nada sobre propostas deste contato.
   *
   * OBRIGATÓRIO, e a interrogação já foi tentada e revertida: com `?:` o
   * compilador fica calado sobre um `LeadContext` que nasce cego, e o próximo
   * a montar um esquece a decisão sem ninguém perceber — a cegueira silenciosa
   * que esta wave existe para matar. `get-lead-context-decisao.test.ts` cobre o
   * PRODUTOR; o tipo cobre todo mundo que constrói um contexto. São camadas
   * diferentes, não alternativas.
   */
  last_human_decision: UltimaDecisaoHumana | null;
  /**
   * N7 — desfecho da última proposta com desfecho real (`enviada`, `aceita`,
   * `recusada`, `vencida`). `null` quando só há rascunho aberto ou nenhuma
   * proposta: rascunho não é desfecho (pode ser o que o próprio agente acabou
   * de criar).
   */
  last_proposal?: UltimaProposta | null;
  /** Últimas N mensagens, da mais antiga para a mais nova. */
  messages: LeadContextMessage[];
}

export type LeadContextErrorCode = 'lead_not_found' | 'crm_error' | 'crm_unavailable';

/**
 * Resultado da tool. `ok:false` é a mensagem de ensino pro modelo — pt-br,
 * instrutiva, sem stack e sem credencial.
 */
export type LeadContextResult =
  | { ok: true; context: LeadContext; tokenCount: number; lgpd: LgpdInput }
  | { ok: false; error: { code: LeadContextErrorCode; message: string } };

function teach(code: LeadContextErrorCode, message: string): LeadContextResult {
  return { ok: false, error: { code, message } };
}

interface ContactRow {
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  tags: string[] | null;
  is_blocked: boolean;
  /** Spec 21: espelha a coluna (o veto de envio e o esconderijo entram na fatia 2). */
  is_personal: boolean;
  source: string | null;
  consent: Record<string, unknown> | null;
  is_anonymized: boolean;
}

interface DecisionRow {
  type: string;
  payload: Record<string, unknown> | null;
  reason: string | null;
  performed_at: string;
}

/**
 * O texto vem do `payload.next_action`, não do `reason`.
 *
 * `reason` é a frase legível do humano ("Aprovou: ligar para o Carlos") e serve
 * à TELA; o payload guarda a ação crua, que é o que o próximo turno precisa
 * comparar com a proposta atual. Usar o reason obrigaria o modelo a desfazer o
 * prefixo em português — parsing de frase para recuperar dado que já existe
 * estruturado ao lado.
 */
function paraDecisao(row: DecisionRow): UltimaDecisaoHumana | null {
  const acao =
    typeof row.payload?.next_action === 'string' ? row.payload.next_action.trim() : '';
  if (acao === '') return null; // sem O QUÊ, dizer "aprovado" não ajuda ninguém.
  return {
    action: acao,
    decision: row.type === 'next_action_approved' ? 'approved' : 'dismissed',
    at: row.performed_at,
  };
}

interface HistoryRow {
  id?: string;
  direction: 'inbound' | 'outbound';
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: Date;
  /**
   * #4580 — quem enviou, tão certo quanto a coluna garante: `ai` (fala da IA),
   * `user`/`crm` (uma pessoa pelo CRM, o default da coluna), `automation`,
   * `system` ou `external_device`. Sem esta coluna não há como dizer de quem é
   * a fala enviada.
   */
  sent_via?: string | null;
  /** #4580 — a PESSOA que enviou pelo CRM; nulo em IA, automação, sistema e celular. */
  sent_by_user_id?: string | null;
  /**
   * #1613 — a pessoa "em nome de" quem um token enviou. É a coluna que o servidor
   * grava; `metadata.sent_on_behalf` só vale quando ela está preenchida (a mesma
   * guarda do balão e do PDF).
   */
  sent_on_behalf_of_user_id?: string | null;
  /** #2729: `group_sender` do ingest de grupo — a única fonte de quem falou. */
  metadata: Record<string, unknown> | null;
  /** O último modelo aprovado da conversa, trazido de FORA da janela — ver `MODELO_FIXADO_DIAS`. */
  fixado?: boolean;
}

/**
 * ─── O ÚLTIMO MODELO APROVADO QUE O CLIENTE RECEBEU ENTRA NO HISTÓRICO ──────
 *
 * O histórico é a janela do ATENDIMENTO atual (inbound da demanda corrente,
 * outbound desde `service_started_at`), cortada nas últimas `historyLimit`
 * mensagens. Um modelo aprovado com uma oferta — mandado por campanha, por
 * fluxo de acompanhamento ou por gente — pode cair fora dos dois cortes:
 *
 *   - o cliente responde dias depois (o botão do modelo: "Sim, quero"), quando o
 *     atendimento anterior já fechou: a resposta abre um atendimento novo, e o
 *     modelo é de antes do `service_started_at`;
 *   - a conversa seguiu depois da oferta e ela passou das últimas N mensagens.
 *
 * Nos dois casos o agente respondia ao "sim" sem saber a que o cliente disse
 * sim — medido: a oferta com desconto foi aceita e o agente confirmou o preço
 * cheio, e ainda se apresentou de novo. O último modelo enviado nos últimos
 * `MODELO_FIXADO_DIAS` dias entra então na MESMA consulta (sem leitura nova em
 * voo), marcado `fixado`, e é o último a cair no orçamento de tokens. Uma
 * mensagem a mais, no máximo; quando ele já está na janela, nada muda.
 */
const MODELO_FIXADO_DIAS = 30;

/** Ordem cronológica, sem a cópia fixada de um modelo que já está na janela. */
export function historicoComOModeloFixado(linhasDaMaisNova: HistoryRow[]): HistoryRow[] {
  const naJanela = new Set(linhasDaMaisNova.filter((l) => !l.fixado && l.id).map((l) => l.id));
  return linhasDaMaisNova.filter((l) => !(l.fixado && l.id && naJanela.has(l.id))).reverse();
}

/** Os `sent_via` que a tela rotula como uma PESSOA da equipe (`MessageBubble.senderLabel`). */
const SENT_VIA_DE_PESSOA: ReadonlySet<string> = new Set(['user', 'crm']);

/** Texto útil ou `null` — `metadata` é JSONB e já veio número onde se espera nome. */
function textoUtil(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : null;
}

/**
 * O RÓTULO DE QUEM ENVIOU (#4580) — o autor que faltava nas mensagens de saída.
 *
 * O histórico só dizia o sentido ("nós"), então a resposta do agente de vendas, a
 * do agente de suporte e a de uma pessoa da equipe chegavam ao modelo como uma
 * voz só: ele lia o que outro escreveu como se fosse dele, repetia, contradizia
 * ou assumia compromisso alheio. O campo é o MESMO `sender` do grupo (#2729) e o
 * vocabulário é o da tela — `MessageBubble.senderLabel` é a régua do operador, e
 * duas réguas para o mesmo dado divergem com o tempo.
 *
 * A ordem dos ramos é a de quem tem dado mais forte: a pessoa "em nome de" que um
 * token enviou (#1613), depois a IA (com o nome que o envio gravou, #3649),
 * depois quem apertou o botão no CRM, e por fim as máquinas, que a coluna
 * `sent_via` nomeia sem ambiguidade. `null` só quando a própria coluna do autor
 * não veio — aí não há o que afirmar, e inventar autor é pior que calar.
 *
 * `nomesDaEquipe` vem de fora (uma consulta por contexto) e é opcional: sem ele
 * o rótulo cai em "Atendente", que é exatamente o que a tela faz quando o nome
 * do atendente não resolve.
 */
export function remetenteDaSaida(
  m: Pick<HistoryRow, 'sent_via' | 'sent_by_user_id' | 'sent_on_behalf_of_user_id' | 'metadata'>,
  nomesDaEquipe: ReadonlyMap<string, string | null> = new Map(),
): { name: string; phone: null } | null {
  const sentVia = m.sent_via ?? null;
  if (sentVia === null) return null;

  // O nome gravado em `metadata.sent_on_behalf` só vale com a coluna preenchida:
  // é a guarda do balão (`MessageBubble`) e do PDF (`exporta-pdf`).
  const emNomeDe = m.sent_on_behalf_of_user_id ? m.metadata?.sent_on_behalf : undefined;
  if (emNomeDe !== null && typeof emNomeDe === 'object') {
    const nome = primeiroNomeDeQuemEnviou((emNomeDe as Record<string, unknown>).user_name);
    return { name: nome !== null ? `Atendente · ${nome}` : 'Atendente', phone: null };
  }

  if (sentVia === 'ai') {
    const nome = textoUtil(m.metadata?.ai_actor_name);
    return { name: nome !== null ? `IA · ${nome}` : 'IA', phone: null };
  }

  if (SENT_VIA_DE_PESSOA.has(sentVia)) {
    const nome = m.sent_by_user_id
      ? primeiroNomeDeQuemEnviou(nomesDaEquipe.get(m.sent_by_user_id) ?? null)
      : null;
    return { name: nome !== null ? `Atendente · ${nome}` : 'Atendente', phone: null };
  }

  // O que não é gente nem agente: o rótulo é o da tela, e a coluna o garante.
  if (sentVia === 'automation') return { name: 'Automação', phone: null };
  if (sentVia === 'system') return { name: 'Sistema', phone: null };
  if (sentVia === 'external_device') return { name: 'Celular', phone: null };
  return null;
}

/**
 * O NOME de cada pessoa da equipe que enviou pelo CRM neste histórico — UMA
 * consulta por contexto, nunca por mensagem (#4580).
 *
 * O nome não está em `messages`: o envio grava o ID (`sent_by_user_id`) e o nome
 * mora em `auth.users.raw_user_meta_data`, que o pool do motor só alcança pela
 * função `fn_nomes_dos_membros` (migration 9314, `security definer`, `service_role`).
 * É a mesma leitura que a tela faz pelo admin client desde o #4031 — aqui sem RTT
 * ao GoTrue, porque do lado do motor já existe Postgres direto. Nome de pessoa
 * NUNCA é lido de `metadata`: ali é entrada do cliente (#3649).
 *
 * Nunca lança: sem `service_role`, com a função ausente numa instalação antiga ou
 * com a leitura falhando, o mapa volta vazio e o rótulo cai em "Atendente" —
 * autoria perdida é melhor que turno derrubado.
 */
async function nomesDaEquipeNoHistorico(
  db: Queryable,
  tenantId: string,
  history: HistoryRow[],
): Promise<Map<string, string | null>> {
  const ids = new Set<string>();
  for (const m of history) {
    if (m.direction !== 'outbound' || !m.sent_by_user_id) continue;
    if (!SENT_VIA_DE_PESSOA.has(m.sent_via ?? '')) continue;
    ids.add(m.sent_by_user_id);
  }
  if (ids.size === 0) return new Map();
  try {
    const { rows } = await db.query<{ user_id: string; full_name: string | null }>(
      `select n.user_id::text as user_id, n.full_name
         from fn_nomes_dos_membros($1, $2::uuid[]) n`,
      [tenantId, [...ids]],
    );
    return new Map(rows.map((r) => [r.user_id, r.full_name]));
  } catch (err) {
    logger.warn('lead-context: nome de quem enviou não lido — a fala sai sem nome', {
      organizationId: tenantId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

export async function getLeadContext(
  db: Queryable,
  _cfg: CrmEdgeConfig,
  input: { tenantId: string; leadId: string; conversationId?: string | null; fuso: string },
  knobs: LeadContextKnobs,
): Promise<LeadContextResult> {
  const { rows: contactRows } = await db.query<ContactRow>(
    `select name, display_name, email, phone_number, tags, is_blocked, is_personal, source, consent, is_anonymized
     from contacts where organization_id = $1 and id = $2`,
    [input.tenantId, input.leadId],
  );
  const contact = contactRows[0];
  if (!contact) {
    return teach(
      'lead_not_found',
      'não encontrei esse lead nesta organização — confira o lead antes de continuar; se o problema persistir, peça handoff humano.',
    );
  }

  // Daqui em diante tudo depende só do contato, e nada depende entre si além da
  // conversa (histórico e desfechos precisam do id dela). Cada `await` em série
  // era um RTT ao Supabase remoto antes do modelo responder; em paralelo, o turno
  // paga o mais lento. São no máximo 4 consultas em voo por contexto, e isso é o
  // formato das leituras, não um encaixe no pool: com vários chamadores juntos
  // (os turnos do worker, e também os rascunhos de resposta fora dele) a demanda
  // passa das 10 conexões do default do pg (knob DB_POOL_MAX). O pg enfileira e
  // nenhuma destas leituras segura conexão: o pior caso é espera, não erro.
  //
  // Conversa: a do job quando informada (fonte confiável); senão a 1:1 mais
  // recente do contato. Grupos NUNCA (regra dura nº 12).
  const conversaHistoricoEDesfechos = async (): Promise<{
    conversationId: string | null;
    history: HistoryRow[];
    previousOutcomes: Array<{ desfecho: string }>;
  }> => {
    let conversationId = input.conversationId ?? null;
    if (conversationId === null) {
      const { rows } = await db.query<{ id: string }>(
        `select id from conversations
         where organization_id = $1 and contact_id = $2 and is_group = false
         order by last_message_at desc nulls last limit 1`,
        [input.tenantId, input.leadId],
      );
      conversationId = rows[0]?.id ?? null;
    }
    const [history, { rows: previousOutcomes }] = await Promise.all([
      conversationId
        ? db
            .query<HistoryRow>(
              `select * from (
                (select id, direction, type, body, media_url, media_storage_path, media_mime,
                        media_derived_text, sent_at, metadata, sent_via, sent_by_user_id, sent_on_behalf_of_user_id, false as fixado
                 from messages
                 where organization_id = $1 and conversation_id = $2
                   and direction in ('inbound', 'outbound')
                   and exists(select 1 from conversations c where c.organization_id=$1 and c.id=$2
                     and ((messages.direction='inbound' and messages.service_revision=c.service_revision
                       and messages.demanda_id is not distinct from c.current_demanda_id)
                       or (messages.direction='outbound' and messages.sent_at >= c.service_started_at)))
                 order by sent_at desc, id desc
                 limit $3)
                union all
                (select id, direction, type, body, media_url, media_storage_path, media_mime,
                        media_derived_text, sent_at, metadata, sent_via, sent_by_user_id, sent_on_behalf_of_user_id, true as fixado
                 from messages
                 where organization_id = $1 and conversation_id = $2
                   and direction = 'outbound' and type = 'template'
                   and sent_at >= now() - make_interval(days => $4::int)
                 order by sent_at desc, id desc
                 limit 1)
               ) h
               order by sent_at desc, id desc`,
              [input.tenantId, conversationId, knobs.historyLimit, MODELO_FIXADO_DIAS],
            )
            .then((r) => historicoComOModeloFixado(r.rows))
        : Promise.resolve<HistoryRow[]>([]),
      db.query<{ desfecho: string }>(
        `select distinct d.desfecho from demandas d join demanda_conversas dc on dc.demanda_id=d.id and dc.organization_id=d.organization_id
         where d.organization_id=$1 and dc.conversation_id=$2 and d.fechada_em is not null limit 5`,
        [input.tenantId, conversationId]),
    ]);
    return { conversationId, history, previousOutcomes };
  };

  // A decisão vem do BARRAMENTO (crm_lead_activities), não de coluna nova: a
  // timeline já é a memória compartilhada entre humano e agente, e foi para isso
  // que a Wave 3 a construiu. Outra fonte seria o segundo funil que este épico
  // existe para acabar.
  //
  // Filtra por `contact_id` porque deste lado da casa `leadId` é o CONTATO —
  // e é assim que a decisão chega mesmo que o negócio tenha mudado de mãos.
  const ultimaDecisao = async (): Promise<UltimaDecisaoHumana | null> => {
    const { rows: decisaoRows } = await db.query<DecisionRow>(
      `select type, payload, reason, performed_at::text as performed_at
       from crm_lead_activities
       where organization_id = $1
         and contact_id = $2
         and type in ('next_action_approved', 'next_action_dismissed')
       order by performed_at desc, id desc
       limit 1`,
      [input.tenantId, input.leadId],
    );
    return decisaoRows[0] ? paraDecisao(decisaoRows[0]) : null;
  };

  // N7 — o desfecho da última proposta com desfecho real, no contexto do
  // turno. `leadId` aqui é o CONTATO (ver o comentário da consulta acima) —
  // por isso o filtro é por `contact_id`, igual ao da decisão humana logo
  // acima. Rascunho é excluído NO SQL (nunca é "desfecho"). Falha aberta de
  // propósito: proposta é contexto auxiliar — se esta consulta falhar, o turno
  // segue sem ela em vez de morrer.
  const ultimaProposta = async (): Promise<UltimaProposta | null> => {
    try {
      const { rows: propostaRows } = await db.query<UltimaProposta>(
        `select status, total_cents, decision_reason, numero, ano
           from crm_proposals
          where organization_id = $1 and contact_id = $2
            and status in ('enviada', 'aceita', 'recusada', 'vencida')
          order by created_at desc
          limit 1`,
        [input.tenantId, input.leadId],
      );
      return propostaRows[0] ?? null;
    } catch (err) {
      logger.warn('lead-context: consulta de proposta falhou — contexto segue sem ela', {
        organizationId: input.tenantId,
        erro: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const [{ conversationId, history, previousOutcomes }, lastHumanDecision, last_proposal] =
    await Promise.all([conversaHistoricoEDesfechos(), ultimaDecisao(), ultimaProposta()]);

  // #4580 — o nome de quem da EQUIPE enviou sai em UMA consulta por contexto, e
  // só quando há enviada de pessoa no histórico: conversa só de IA e de cliente
  // não paga este RTT (a função devolve mapa vazio sem ir ao banco).
  const nomesDaEquipe = await nomesDaEquipeNoHistorico(db, input.tenantId, history);

  // LGPD: base legal derivada DIRETO do contato (fonte da verdade, mesmo banco).
  // isProspecting=false: o MVP é inbound + follow-up — ambos respondem a lead que
  // já engajou, nunca 1º toque frio (o veto de is_anonymized vale SEMPRE).
  const lgpd = deriveLgpdFromContact(
    {
      source: contact.source,
      consent: contact.consent,
      is_anonymized: contact.is_anonymized,
    },
    false,
  );

  const context = fitToBudget(
    {
      previous_service: { label: 'Histórico encerrado. Desfechos anteriores não são tarefas ou compromissos pendentes.', outcomes: previousOutcomes.map((d) => d.desfecho) },
      // ⚠️ `lead_id` aqui é, e sempre foi, o id do CONTATO (ver o comentário da
      // consulta acima e `inbound-turn.ts:1121`). O nome mente, e o modelo
      // acreditava: passava este valor ao parâmetro `lead_id` das ferramentas
      // de agenda, que espera um NEGÓCIO do funil. (issue #509)
      //
      // O campo antigo fica — ele circula por follow-up, case-reply e escalação,
      // e por invariantes congelados; trocar o nome custa uma wave inteira e
      // somar o certo custa uma linha. `contact_id` é a porta para o modelo
      // acertar; as descrições das ferramentas apontam para ela.
      lead_id: input.leadId,
      contact_id: input.leadId,
      contact: {
        name: nomeDoContato(contact),
        phone: contact.phone_number,
        email: contact.email,
        tags: contact.tags ?? [],
        is_blocked: contact.is_blocked,
        is_personal: contact.is_personal,
      },
      conversation_id: conversationId,
      last_human_decision: lastHumanDecision,
      last_proposal,
    },
    history,
    knobs.maxTokens,
    input.fuso,
    knobs.verImagens ?? true,
    nomesDaEquipe,
  );
  return { ok: true, context, tokenCount: countPayloadTokens(JSON.stringify(context)), lgpd };
}

/** As colunas do CRM de que o corpo de UMA mensagem depende. */
export interface CorpoDaMensagemRow {
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_derived_text: string | null;
  /** Ausente = recebida (a linha do job só lê inbound). Decide o aviso de imagem não vista. */
  direction?: string;
}

/**
 * O corpo de UMA mensagem como o prompt o lê — UMA composição, DOIS leitores.
 *
 * O histórico (`fitToBudget`, logo abaixo) sempre compôs o corpo da linha. A
 * linha canônica do job (`inbound-turn.ts:loadInboundBodyForJob`) lia a coluna
 * `body` CRUA — as duas leem a MESMA linha por caminhos diferentes, e a
 * divergência não é teórica: áudio e foto chegam sem legenda, isto é, com `body`
 * NULL (o ingest do transporte devolve cedo quando a mensagem não tem texto,
 * nem URL de mídia, nem mídia), e o conteúdo é o derivado (transcrição/visão,
 * gravado DEPOIS pelo
 * `media-derive-worker` — a corrida) ou o marcador `[tipo]`. Lido cru, um áudio
 * transcrito valia `''` enquanto o texto do cliente estava no histórico logo
 * abaixo: a abertura anunciava "não há texto utilizável" sobre uma mensagem que
 * TEM texto, e a barreira do falso-vazio desarmava, porque
 * `claimsCurrentInboundIsEmpty` não arma sobre `''`. (issue #617)
 *
 * `@internal` só na intenção de não espalhar a receita: quem lê uma linha de
 * `messages` para o prompt passa por aqui, senão a composição volta a divergir.
 */
export function corpoDaMensagem(m: CorpoDaMensagemRow, verImagens = true): string {
  // Agente que não vê imagens (9108): o aviso, nunca a descrição nem o `[image]`
  // cru. Com `[documento]` o agente já inventou o conteúdo de um PDF que nunca
  // leu (17/09, ver `MARCADOR_NAO_LIDA`); o aviso diz que chegou e que ele não viu.
  // Só na foto que o CLIENTE mandou: na que nós mandamos, a legenda é nossa, e
  // rotulá-la "do cliente" atribuiria a ele o que dissemos.
  if (!verImagens && m.type === 'image' && m.direction !== 'outbound') {
    const legenda = (m.body ?? '').trim();
    return legenda === '' ? MARCADOR_IMAGEM_NAO_VISTA : `${MARCADOR_IMAGEM_NAO_VISTA}\nLegenda do cliente: ${legenda}`;
  }
  const hasMedia = Boolean(m.media_storage_path || m.media_url);
  const derived = m.media_derived_text;
  // Onda 3: legenda e derivado (transcrição/visão/pdf) COEXISTEM, e o derivado
  // vem ENQUADRADO (frameMediaBody) — sem isso o agente caía no reflexo
  // "não consigo ver mídia" mesmo tendo o conteúdo. Sem derivado, marcador [tipo].
  return derived
    ? frameMediaBody(m.type, m.body, derived)
    : (m.body ?? (hasMedia ? `[${m.type}]` : ''));
}

/**
 * Encaixa o payload no orçamento (determinístico):
 *   1. mensagens mais ANTIGAS caem primeiro — menos o modelo fixado
 *      (`MODELO_FIXADO_DIAS`), que é o último a cair;
 *   2. restando uma única mensagem que ainda estoura, o corpo é cortado ao meio
 *      repetidamente até caber. Nunca erro fatal.
 */
function fitToBudget(
  base: Omit<LeadContext, 'messages'>,
  history: HistoryRow[],
  maxTokens: number,
  fuso: string,
  verImagens = true,
  nomesDaEquipe: ReadonlyMap<string, string | null> = new Map(),
): LeadContext {
  let messages: LeadContextMessage[] = history.map((m) => {
    const hasMedia = Boolean(m.media_storage_path || m.media_url);
    // A composição do corpo é UMA só, exportada logo acima: a linha canônica do
    // job passa pela mesma função. Duas receitas para a mesma linha foi o defeito
    // da #617 — o histórico mostrava o texto do áudio e a abertura dizia vazio.
    const body = corpoDaMensagem(m, verImagens);
    // #2729/#4580 — quem falou. Recebida de grupo traz `group_sender` (o ingest
    // grava só nesse sentido) e as demais recebidas ficam sem autor, porque numa
    // 1:1 o autor é o contato da ficha. ENVIADA traz o autor que a linha garante
    // (IA, pessoa da equipe, automação...) — sem isso o agente lia o que outro
    // escreveu como se fosse dele.
    const remetente =
      m.direction === 'inbound' ? lerRemetenteDeGrupo(m.metadata) : remetenteDaSaida(m, nomesDaEquipe);
    return {
      direction: m.direction,
      body,
      // Hora de PAREDE do tenant, não UTC cru — ver o comentário de `sent_at` na
      // interface acima e o cabeçalho de `isoLocalComOffset`.
      sent_at: isoLocalComOffset(m.sent_at, fuso),
      ...(remetente !== null &&
      (remetente.name !== null || remetente.phone !== null)
        ? { sender: { name: remetente.name, phone: remetente.phone } }
        : {}),
      ...(hasMedia ? { type: m.type, media_storage_path: m.media_storage_path, media_mime: m.media_mime } : {}),
    };
  });
  const build = (msgs: LeadContextMessage[]): LeadContext => ({ ...base, messages: msgs });
  const over = (msgs: LeadContextMessage[]): boolean =>
    countPayloadTokens(JSON.stringify(build(msgs))) > maxTokens;

  // O modelo fixado (sempre o mais antigo, quando veio de fora da janela) é o
  // último a cair: é dele que sai o preço que o cliente está aceitando.
  const fixado = history[0]?.fixado === true;
  while (messages.length > (fixado ? 2 : 1) && over(messages)) {
    messages = fixado ? [messages[0]!, ...messages.slice(2)] : messages.slice(1);
  }
  if (fixado && messages.length === 2 && over(messages)) messages = messages.slice(1);
  while (messages.length === 1 && messages[0]!.body.length > 0 && over(messages)) {
    messages = [{ ...messages[0]!, body: messages[0]!.body.slice(0, Math.floor(messages[0]!.body.length / 2)) }];
  }
  return build(messages);
}


// A moldura e o seu desembrulho moram juntos em `moldura-de-midia.ts` (o cartão
// da passagem precisa ler a mesma moldura de volta). Reexportado aqui porque é
// por este módulo que o motor e os testes sempre a importaram.
export { frameMediaBody, MARCADOR_IMAGEM_NAO_VISTA };

/**
 * O que o CLIENTE digitou na última mensagem dele, e nada que o sistema compôs
 * em volta — `''` quando ela é mídia. É o dado que sai para um fornecedor sob o
 * aceite "cada mensagem, sozinha" (o Jev, R4).
 *
 * O `body` de uma mídia no contexto é COMPOSTO (`corpoDaMensagem`): transcrição,
 * descrição da imagem ou texto do PDF, e a moldura de instrução do agente. Isso é
 * o que o sistema derivou, não o que o cliente mandou — nome, endereço e dado de
 * saúde de um laudo iriam junto. A moldura é conferida além do `type` porque o
 * derivado sobrevive à mídia apagada (a anonimização zera a mídia, não ele).
 *
 * ponytail: a legenda de uma mídia também fica de fora. Separá-la exigiria a
 * coluna crua no contexto; e o classificador de sempre respondeu sobre o corpo
 * composto, então comparar os dois ali não seria a mesma pergunta.
 */
export function textoDoClienteNaUltimaMensagem(messages: readonly LeadContextMessage[]): string {
  const ultima = messages.findLast((m) => m.direction === 'inbound');
  if (!ultima || ultima.type !== undefined || ultima.body.startsWith(INICIO_DA_MOLDURA_DE_MIDIA)) return '';
  return ultima.body;
}

/** @internal exposto p/ teste — não usar fora de testes. */
export const __test_fitToBudget = fitToBudget;

// @vitest-environment node
/**
 * CONVERSAS E CONVERSATION-TAGS ACEITAM TOKEN (Spec 33, fatia R2, tarefa 2).
 *
 * `resolveAuthDual` entrega, no ramo do token, a service role: a RLS deixa de
 * proteger e o `.eq("organization_id", authz.organizationId)` de CADA cadeia é
 * a única barreira entre a organização do token e as demais. O cliente falso
 * (`../helpers/cliente-admin-falso`) vê: uma cadeia de tabela com
 * `organization_id` que não filtra a organização não alcança linha nenhuma, e
 * `cadeiasForaDaOrganizacao` aponta qual foi.
 *
 * Rotas que aceitam token nesta fatia: conversation-tags, messages, notes,
 * passagens, retention, sector, snooze e usable-for-rag. As demais rotas de
 * conversa ficaram só de sessão: o teste delas recusa o Bearer sem cookie com
 * 401 e não toca em `createAdminClient`.
 *
 * Seis testes por método convertido (a receita da R2): o token de A alcança o
 * recurso de A; o token de B não alcança; sem o escopo; abaixo do papel; acima
 * do teto; e a sessão segue com o mesmo portão. Depois, as garantias que só o
 * ramo do token precisa, e a borda do proxy.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole, orgAtivaDaApi } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
// O módulo `setores` liga-se por `platform_config`, que o cliente falso não
// semeia: sem este mock, as rotas de setor respondem 404 antes de chegar à
// regra que o teste quer medir.
vi.mock("@/lib/atendimento/setores-modulo", () => ({ seSetoresDesligado: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";

const CONVERSA_A = "a4444444-4444-4444-8444-444444444444";
const CONVERSA_B = "b4444444-4444-4444-8444-444444444444";
const CONTATO_A = "a6666666-6666-4666-8666-666666666666";
const CONTATO_B = "b6666666-6666-4666-8666-666666666666";
const NOTA_A = "a7777777-7777-4777-8777-777777777777";
const NOTA_B = "b7777777-7777-4777-8777-777777777777";
const PARTICIPANTE_A = "a8888888-8888-4888-8888-888888888888";
const PARTICIPANTE_B = "b8888888-8888-4888-8888-888888888888";
const PESSOA_PARTICIPANTE_A = "a9999999-9999-4999-8999-999999999999";
const PESSOA_PARTICIPANTE_B = "b9999999-9999-4999-8999-999999999999";
const NUMERO_A = "aaaaaaaa-1111-4111-8111-111111111111";
const NUMERO_B = "bbbbbbbb-1111-4111-8111-111111111111";
const CAMINHO_DO_ANEXO_A = `${ORG_A}/${CONVERSA_A}/anexo.png`;

const SEM_ORGANIZACAO = [] as const;

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;

/**
 * Linhas da organização A que cada rota precisa para responder 2xx, mais uma
 * linha da B na mesma tabela para o caso "token de A" provar que a de B não
 * aparece. Colunas conferidas no supabase/baseline.sql.
 */
const CONVERSAS: Linha[] = [
  {
    id: CONVERSA_A,
    organization_id: ORG_A,
    contact_id: CONTATO_A,
    channel: "whatsapp",
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: null,
    tags: [],
    is_group: false,
    bot_silenced_until: null,
    last_message_at: "2026-11-01T10:00:00.000Z",
    last_message_preview: null,
    unread_count_for_assignee: 0,
    snooze_until: null,
    sector_id: null,
    usable_for_rag: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
  },
  {
    id: CONVERSA_B,
    organization_id: ORG_B,
    contact_id: CONTATO_B,
    channel: "whatsapp",
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: null,
    tags: [],
    is_group: false,
    bot_silenced_until: null,
    last_message_at: "2026-11-01T10:00:00.000Z",
    last_message_preview: null,
    unread_count_for_assignee: 0,
    snooze_until: null,
    sector_id: null,
    usable_for_rag: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
  },
];
const CONTATOS: Linha[] = [
  {
    id: CONTATO_A,
    organization_id: ORG_A,
    name: "Cliente da A",
    email: null,
    phone_number: null,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    last_activity_at: null,
    force_human: false,
  },
  {
    id: CONTATO_B,
    organization_id: ORG_B,
    name: "Cliente da B",
    email: null,
    phone_number: null,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    last_activity_at: null,
    force_human: false,
  },
];
const NOTAS: Linha[] = [
  {
    id: NOTA_A,
    conversation_id: CONVERSA_A,
    organization_id: ORG_A,
    body: "Nota da A",
    created_by_user_id: null,
    created_by_name: null,
    created_at: "2026-11-01T10:00:00.000Z",
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    media_expired_at: null,
    media_retention_days: null,
  },
  {
    id: NOTA_B,
    conversation_id: CONVERSA_B,
    organization_id: ORG_B,
    body: "Nota secreta da B",
    created_by_user_id: null,
    created_by_name: null,
    created_at: "2026-11-01T10:00:00.000Z",
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    media_expired_at: null,
    media_retention_days: null,
  },
];

const LINHAS_BASE: Linhas = {
  conversations: CONVERSAS,
  contacts: CONTATOS,
  conversation_notes: NOTAS,
  conversation_participants: [],
  passagens_de_atendimento: [],
  before_send_traces: [],
  channel_knobs: [],
  channel_sessions: [],
  organizations: [
    { id: ORG_A, settings: {}, timezone: "America/Sao_Paulo", status: "active" },
    { id: ORG_B, settings: {}, timezone: "America/Sao_Paulo", status: "active" },
  ],
  user_organizations: [],
};

const PARTICIPANTES: Linha[] = [
  {
    id: PARTICIPANTE_A,
    organization_id: ORG_A,
    conversation_id: CONVERSA_A,
    user_id: PESSOA_PARTICIPANTE_A,
    invited_by: null,
    joined_at: "2026-11-01T10:00:00.000Z",
    left_at: null,
  },
  {
    id: PARTICIPANTE_B,
    organization_id: ORG_B,
    conversation_id: CONVERSA_B,
    user_id: PESSOA_PARTICIPANTE_B,
    invited_by: null,
    joined_at: "2026-11-01T10:00:00.000Z",
    left_at: null,
  },
];
const NUMEROS: Linha[] = [
  { id: NUMERO_A, organization_id: ORG_A, display_name: "Número da A", phone_number: "+5511900000001" },
  { id: NUMERO_B, organization_id: ORG_B, display_name: "Número da B", phone_number: "+5511900000002" },
];

const SO_DA_A = [CONVERSA_A, CONTATO_A, NOTA_A, ORG_A, PARTICIPANTE_A, PESSOA_PARTICIPANTE_A, NUMERO_A];
const SO_DA_B = [CONVERSA_B, CONTATO_B, NOTA_B, ORG_B, PARTICIPANTE_B, PESSOA_PARTICIPANTE_B, NUMERO_B];

type Metodo = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";

/** O que a chamada precisa: rota, método, caminho e corpo. */
type Pedido = {
  rota: string;
  metodo: Metodo;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
};

/** Rota convertida: entra nos seis testes por método. */
type Caso = Pedido & {
  linhas: Linhas;
  papel: Papel;
  escopo: "mcp:read" | "mcp:write";
  papelDoToken?: Papel;
  recurso: string;
  rpc?: Record<string, unknown>;
  status: number;
  audita?: boolean;
  receitaB?: boolean;
  /** Fora da organização do token a rota responde 200 com lista vazia, não 404. */
  semDadosDeB?: true;
};

/** Rota só de sessão: o teste dela é o "fica só de sessão". */
type CasoDeSessao = Pedido;

/** Qual `route.ts` importar, por rota. */
const CARREGA: Record<string, () => Promise<Record<string, unknown>>> = {
  "conversation-tags": () => import("@/app/api/v1/conversation-tags/route"),
  "conversations": () => import("@/app/api/v1/conversations/route"),
  "conversations/[id]": () => import("@/app/api/v1/conversations/[id]/route"),
  "conversations/[id]/aviso-de-mensagem": () =>
    import("@/app/api/v1/conversations/[id]/aviso-de-mensagem/route"),
  "conversations/[id]/close": () => import("@/app/api/v1/conversations/[id]/close/route"),
  "conversations/[id]/draft-reply": () => import("@/app/api/v1/conversations/[id]/draft-reply/route"),
  "conversations/[id]/messages": () => import("@/app/api/v1/conversations/[id]/messages/route"),
  "conversations/[id]/notes": () => import("@/app/api/v1/conversations/[id]/notes/route"),
  "conversations/[id]/notes/[noteId]": () =>
    import("@/app/api/v1/conversations/[id]/notes/[noteId]/route"),
  "conversations/[id]/notes/[noteId]/media": () =>
    import("@/app/api/v1/conversations/[id]/notes/[noteId]/media/route"),
  "conversations/[id]/participants": () =>
    import("@/app/api/v1/conversations/[id]/participants/route"),
  "conversations/[id]/passagens": () => import("@/app/api/v1/conversations/[id]/passagens/route"),
  "conversations/[id]/pause-ai": () => import("@/app/api/v1/conversations/[id]/pause-ai/route"),
  "conversations/[id]/reactivate-bot": () => import("@/app/api/v1/conversations/[id]/reactivate-bot/route"),
  "conversations/[id]/retention": () => import("@/app/api/v1/conversations/[id]/retention/route"),
  "conversations/[id]/sector": () => import("@/app/api/v1/conversations/[id]/sector/route"),
  "conversations/[id]/snooze": () => import("@/app/api/v1/conversations/[id]/snooze/route"),
  "conversations/[id]/transfer": () => import("@/app/api/v1/conversations/[id]/transfer/route"),
  "conversations/[id]/usable-for-rag": () =>
    import("@/app/api/v1/conversations/[id]/usable-for-rag/route"),
  "conversations/bulk": () => import("@/app/api/v1/conversations/bulk/route"),
  "conversations/counts": () => import("@/app/api/v1/conversations/counts/route"),
};

// ─── Rotas que aceitam token nesta fatia ────────────────────────────────────

const LISTA_TAGS: Caso = {
  rota: "conversation-tags",
  metodo: "GET",
  caminho: "/api/v1/conversation-tags",
  linhas: { ...LINHAS_BASE, conversation_tags: [] },
  papel: "viewer",
  papelDoToken: "agent",
  escopo: "mcp:read",
  recurso: "conversations",
  status: 200,
  audita: false,
  semDadosDeB: true,
};

const MESSAGES_GET: Caso = {
  rota: "conversations/[id]/messages",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/messages`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: "agent",
  recurso: "conversations",
  status: 200,
  audita: false,
  receitaB: true,
  semDadosDeB: true,
};

const LISTA_GET: Caso = {
  rota: "conversations",
  metodo: "GET",
  caminho: "/api/v1/conversations",
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: "agent",
  recurso: "conversations",
  status: 200,
  audita: false,
  receitaB: true,
  semDadosDeB: true,
};

const CONVERSA_GET: Caso = {
  rota: "conversations/[id]",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: "agent",
  recurso: "conversations",
  status: 200,
  audita: false,
  receitaB: true,
};

const NOTES_GET: Caso = {
  rota: "conversations/[id]/notes",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/notes`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:read",
  recurso: "conversation_notes",
  status: 200,
  audita: false,
};

const NOTES_POST: Caso = {
  rota: "conversations/[id]/notes",
  metodo: "POST",
  caminho: `/api/v1/conversations/${CONVERSA_A}/notes`,
  params: { id: CONVERSA_A },
  corpo: { body: "nota interna" },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "conversation_notes",
  status: 201,
  audita: true,
};

const NOTA_COM_ANEXO_GET: Caso = {
  rota: "conversations/[id]/notes/[noteId]/media",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/notes/${NOTA_A}/media`,
  params: { id: CONVERSA_A, noteId: NOTA_A },
  linhas: {
    ...LINHAS_BASE,
    conversation_notes: (LINHAS_BASE.conversation_notes ?? []).map((n) =>
      n.id === NOTA_A ? { ...n, media_storage_path: CAMINHO_DO_ANEXO_A } : n,
    ),
  },
  papel: "agent",
  escopo: "mcp:read",
  recurso: "conversation_notes",
  status: 302,
  audita: false,
};

const PARTICIPANTES_GET: Caso = {
  rota: "conversations/[id]/participants",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/participants`,
  params: { id: CONVERSA_A },
  linhas: { ...LINHAS_BASE, conversation_participants: PARTICIPANTES },
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: "agent",
  recurso: "conversations",
  status: 200,
  audita: false,
  receitaB: true,
};

const TRANSFERENCIA_PREVIA_GET: Caso = {
  rota: "conversations/[id]/transfer",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/transfer?to_user_id=${PESSOA_DA_SESSAO}`,
  params: { id: CONVERSA_A },
  linhas: { ...LINHAS_BASE, channel_sessions: NUMEROS },
  rpc: { fn_numero_da_transferencia: NUMERO_A },
  papel: "agent",
  escopo: "mcp:read",
  recurso: "conversations",
  status: 200,
  audita: false,
};

const PASSAGENS_GET: Caso = {
  rota: "conversations/[id]/passagens",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/passagens`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:read",
  recurso: "passagens_de_atendimento",
  status: 200,
  audita: false,
};

const RETENTION_GET: Caso = {
  rota: "conversations/[id]/retention",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/retention`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  recurso: "conversations",
  status: 200,
  audita: false,
  receitaB: true,
};

const SECTOR_PUT: Caso = {
  rota: "conversations/[id]/sector",
  metodo: "PUT",
  caminho: `/api/v1/conversations/${CONVERSA_A}/sector`,
  params: { id: CONVERSA_A },
  corpo: { sector_id: null },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "conversations",
  status: 200,
  audita: true,
};

const SECTOR_GET: Caso = {
  rota: "conversations/[id]/sector",
  metodo: "GET",
  caminho: `/api/v1/conversations/${CONVERSA_A}/sector`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:read",
  recurso: "conversations",
  status: 200,
  audita: false,
};

const SNOOZE_POST: Caso = {
  rota: "conversations/[id]/snooze",
  metodo: "POST",
  caminho: `/api/v1/conversations/${CONVERSA_A}/snooze`,
  params: { id: CONVERSA_A },
  corpo: { duration_hours: 24 },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "conversations",
  status: 200,
  audita: true,
};

const SNOOZE_DELETE: Caso = {
  rota: "conversations/[id]/snooze",
  metodo: "DELETE",
  caminho: `/api/v1/conversations/${CONVERSA_A}/snooze`,
  params: { id: CONVERSA_A },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "conversations",
  status: 204,
  audita: true,
};

const USABLE_FOR_RAG_POST: Caso = {
  rota: "conversations/[id]/usable-for-rag",
  metodo: "POST",
  caminho: `/api/v1/conversations/${CONVERSA_A}/usable-for-rag`,
  params: { id: CONVERSA_A },
  corpo: { enabled: false },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "conversations",
  status: 200,
  audita: true,
};

const CASOS: readonly Caso[] = [
  LISTA_TAGS,
  LISTA_GET,
  CONVERSA_GET,
  MESSAGES_GET,
  NOTES_GET,
  NOTES_POST,
  NOTA_COM_ANEXO_GET,
  PARTICIPANTES_GET,
  TRANSFERENCIA_PREVIA_GET,
  PASSAGENS_GET,
  RETENTION_GET,
  SECTOR_PUT,
  SECTOR_GET,
  SNOOZE_POST,
  SNOOZE_DELETE,
  USABLE_FOR_RAG_POST,
];

// ─── Rotas que ficaram só de sessão ─────────────────────────────────────────

/**
 * Uma por rota revertida. Nenhuma tem porta em `isPublicPath`, então o proxy
 * já recusa o Bearer; o teste prova que a própria rota também recusa, sem
 * tocar no cliente admin.
 */
const SO_DE_SESSAO: readonly CasoDeSessao[] = [
  // O GET de `[id]` aceita token; o PATCH da mesma rota segue só de sessão
  // (`fn_conversation_assign` roda com o cliente de sessão). A porta do caminho
  // vale para os dois métodos, e o PATCH recusa o Bearer sem cookie com 401.
  {
    rota: "conversations/[id]",
    metodo: "PATCH",
    caminho: `/api/v1/conversations/${CONVERSA_A}`,
    params: { id: CONVERSA_A },
    corpo: { status: "open" },
  },
  {
    rota: "conversations/[id]/aviso-de-mensagem",
    metodo: "GET",
    caminho: `/api/v1/conversations/${CONVERSA_A}/aviso-de-mensagem`,
    params: { id: CONVERSA_A },
  },
  {
    rota: "conversations/[id]/close",
    metodo: "POST",
    caminho: `/api/v1/conversations/${CONVERSA_A}/close`,
    params: { id: CONVERSA_A },
    corpo: {},
  },
  {
    rota: "conversations/[id]/draft-reply",
    metodo: "POST",
    caminho: `/api/v1/conversations/${CONVERSA_A}/draft-reply`,
    params: { id: CONVERSA_A },
    corpo: { texto: "rascunho" },
  },
  {
    rota: "conversations/[id]/notes/[noteId]",
    metodo: "DELETE",
    caminho: `/api/v1/conversations/${CONVERSA_A}/notes/${NOTA_A}`,
    params: { id: CONVERSA_A, noteId: NOTA_A },
  },
  // draft-reply GET e POST usam o pool do Postgres da requisição (e o POST, a
  // IA); aviso-de-mensagem pergunta "avisar ESTA pessoa", e reactivate-bot
  // decide pelo dono da conversa: nenhum tem sentido sem uma pessoa na sessão.
  {
    rota: "conversations/[id]/draft-reply",
    metodo: "GET",
    caminho: `/api/v1/conversations/${CONVERSA_A}/draft-reply`,
    params: { id: CONVERSA_A },
  },
  // GET de participants e de transfer aceitam token; convidar, remover e
  // transferir seguem só de sessão (`fn_conversation_assign`, vínculo forjável).
  {
    rota: "conversations/[id]/participants",
    metodo: "DELETE",
    caminho: `/api/v1/conversations/${CONVERSA_A}/participants`,
    params: { id: CONVERSA_A },
    corpo: { user_id: PESSOA_DA_SESSAO },
  },
  {
    rota: "conversations/[id]/participants",
    metodo: "POST",
    caminho: `/api/v1/conversations/${CONVERSA_A}/participants`,
    params: { id: CONVERSA_A },
    corpo: { user_id: PESSOA_DA_SESSAO },
  },
  {
    rota: "conversations/[id]/pause-ai",
    metodo: "POST",
    caminho: `/api/v1/conversations/${CONVERSA_A}/pause-ai`,
    params: { id: CONVERSA_A },
    corpo: {},
  },
  {
    rota: "conversations/[id]/reactivate-bot",
    metodo: "POST",
    caminho: `/api/v1/conversations/${CONVERSA_A}/reactivate-bot`,
    params: { id: CONVERSA_A },
    corpo: {},
  },
  {
    rota: "conversations/[id]/transfer",
    metodo: "POST",
    caminho: `/api/v1/conversations/${CONVERSA_A}/transfer`,
    params: { id: CONVERSA_A },
    corpo: { to_user_id: PESSOA_DA_SESSAO },
  },
  {
    rota: "conversations/bulk",
    metodo: "POST",
    caminho: "/api/v1/conversations/bulk",
    corpo: { ids: [CONVERSA_A], action: "close" },
  },
  { rota: "conversations/counts", metodo: "GET", caminho: "/api/v1/conversations/counts" },
];

// ─── Ferramentas do teste ───────────────────────────────────────────────────

const AUTORIZACAO = { authorization: "Bearer dsk_abc_def" };

type Manipulador = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const DEGRAU_ABAIXO: Record<Papel, Papel> = {
  admin: "manager",
  manager: "agent",
  agent: "viewer",
  viewer: "viewer",
};

function nome(c: Pedido): string {
  return `${c.metodo} ${c.caminho}`;
}

function requisicao(c: Pedido, cabecalhos: Record<string, string> = {}): NextRequest {
  const h = new Headers(cabecalhos);
  if (c.corpo !== undefined) h.set("content-type", "application/json");
  return new NextRequest(`http://localhost${c.caminho}`, {
    method: c.metodo,
    headers: h,
    body: c.corpo === undefined ? undefined : JSON.stringify(c.corpo),
  });
}

async function chamar(c: Pedido, req: NextRequest): Promise<Response> {
  const carregar = CARREGA[c.rota];
  if (!carregar) throw new Error(`rota sem carregador: ${c.rota}`);
  const modulo = (await carregar()) as unknown as Record<string, unknown>;
  const manipulador = modulo[c.metodo] as Manipulador;
  return manipulador(req, { params: Promise.resolve(c.params ?? {}) });
}

function tokenValido(o: { org: string; id: string; papel: string; escopos: string[] }): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: o.org,
    role: o.papel,
    actor: { type: "api_token", id: o.id, role: o.papel },
    apiTokenId: o.id,
    scopes: o.escopos,
  } as never);
}

/** Chama o método com um Bearer; o cliente do banco é o falso, dono das `linhas`. */
async function comoToken(c: Caso, o: { org?: string; papel?: string; escopos?: string[]; linhas?: Linhas } = {}) {
  const org = o.org ?? ORG_A;
  const falso = criarClienteAdminFalso({
    orgDona: org,
    linhas: o.linhas ?? c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  tokenValido({
    org,
    id: org === ORG_A ? TOKEN_A : TOKEN_B,
    papel: o.papel ?? c.papelDoToken ?? c.papel,
    escopos: o.escopos ?? [c.escopo],
  });
  const res = await chamar(c, requisicao(c, AUTORIZACAO));
  const texto = await res.text();
  return { res, texto, falso };
}

/** Chama o método SEM Authorization: o caminho de sessão segue seu portão. */
async function comoSessao(c: Caso) {
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createClient).mockResolvedValue({
    ...(falso.cliente as object),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" } },
        error: null,
      }),
    },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org", role: c.papel },
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: PESSOA_DA_SESSAO,
    idioma: "pt-BR",
  } as never);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({
    ok: true,
    org: { orgId: ORG_A, name: "Org", role: c.papel, org_status: "active" },
  } as never);
  const res = await chamar(c, requisicao(c));
  const texto = await res.text();
  return { res, texto, falso };
}

/**
 * Bearer SEM cookie numa rota só de sessão: a sessão ausente responde 401 pelo
 * portão que a rota já usa (`requireRole` ou `getUser`), e nada toca no admin.
 */
async function semCookieComBearer(c: CasoDeSessao): Promise<Response> {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
  } as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Auth required." } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue(null as never);
  tokenValido({ org: ORG_A, id: TOKEN_A, papel: "agent", escopos: ["mcp:read", "mcp:write"] });
  return chamar(c, requisicao(c, AUTORIZACAO));
}

function daOrganizacao(linhas: Linhas, org: string, tabelas: string[]): Linhas {
  return Object.fromEntries(
    tabelas.map((tabela) => [tabela, (linhas[tabela] ?? []).filter((l) => l.organization_id === org)]),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(audit).mockResolvedValue(undefined);
});

// ─── Os seis testes de cada método ──────────────────────────────────────────

describe("conversas e conversation-tags aceitam token", () => {
  for (const c of CASOS) {
    const n = nome(c);
    const tabelas = Object.keys(c.linhas);
    const papelEfetivo = c.papelDoToken ?? c.papel;

    it(`${n}: token de A alcança o recurso de A`, async () => {
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(c.status);
      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      for (const deB of SO_DA_B) expect(texto).not.toContain(deB);

      expect(createClient).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
        );
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${n}: token de B não alcança o recurso de A`, async () => {
      const { res, texto, falso } = await comoToken(c, { org: ORG_B });

      if (c.semDadosDeB) {
        expect(res.status, texto).toBe(200);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      } else {
        expect(res.status, texto).toBe(404);
        expect(audit).not.toHaveBeenCalled();
      }

      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      expect(daOrganizacao(falso.linhas, ORG_A, tabelas)).toEqual(daOrganizacao(c.linhas, ORG_A, tabelas));
    });

    it(`${n}: token sem o escopo é recusado`, async () => {
      const outro = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      const { res, texto, falso } = await comoToken(c, { escopos: [outro] });

      expect(res.status, texto).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    // Sem degrau abaixo de `viewer`: quando o papel efetivo do token já é o
    // mais baixo, não há o que recusar.
    if (papelEfetivo !== "viewer") {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, { papel: DEGRAU_ABAIXO[papelEfetivo] });

        expect(res.status, texto).toBe(403);
        expect(falso.cadeias).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${n}: acima do teto do token → 429`, async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recurso}:tok:${TOKEN_A}`);
    });

    it(`${n}: sessão continua com o mesmo portão`, async () => {
      const { res, texto } = await comoSessao(c);

      expect(res.status, texto).toBe(c.status);
      if (c.receitaB) {
        // Rotas de sessão pura (Receita B) não chamam requireRole.
        expect(requireRole).not.toHaveBeenCalled();
      } else {
        expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      }
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null }),
        );
      }
    });
  }
});

// ─── Rotas que ficaram só de sessão ─────────────────────────────────────────

describe("rotas de conversa que ficaram só de sessão", () => {
  for (const c of SO_DE_SESSAO) {
    it(`${nome(c)}: fica só de sessão`, async () => {
      const res = await semCookieComBearer(c);

      expect(res.status).toBe(401);
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
    });
  }
});

// ─── O que só o ramo do token precisa garantir ──────────────────────────────

describe("o ramo do token em conversas e conversation-tags", () => {
  it("GET /api/v1/conversation-tags?busca=: a RPC do vocabulário leva a organização do token", async () => {
    // Com `busca`, a rota chama `fn_vocabulario_de_tags_pagina`. O falso não
    // conhece o formato da resposta dela, então a asserção é sobre a chamada.
    const c: Caso = { ...LISTA_TAGS, caminho: "/api/v1/conversation-tags?busca=pro" };
    const { falso } = await comoToken(c);
    const rpc = falso.rpcs.find((r) => r.nome === "fn_vocabulario_de_tags_pagina");
    expect(rpc?.args.p_org).toBe(ORG_A);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
  });

  it("GET /api/v1/conversation-tags: leitura de conversations filtra a org do token", async () => {
    const { res, texto, falso } = await comoToken(LISTA_TAGS);
    expect(res.status, texto).toBe(200);
    const leituras = falso.cadeias.filter((c) => c.tabela === "conversations");
    expect(leituras.length).toBeGreaterThan(0);
    for (const leitura of leituras) expect(leitura.filtros).toContainEqual(["organization_id", ORG_A]);
    const rpc = falso.rpcs.find((r) => r.nome === "fn_tags_de_conversa_em_uso");
    expect(rpc?.args.p_org).toBe(ORG_A);
  });

  it("POST /api/v1/conversations/[id]/notes: grava actor null com token", async () => {
    const { res, texto, falso } = await comoToken(NOTES_POST);
    expect(res.status, texto).toBe(201);
    const cadeia = falso.cadeias.find((c) => c.tabela === "conversation_notes");
    expect(cadeia?.payload).toMatchObject({ organization_id: ORG_A, created_by_user_id: null });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
    );
  });

  it("POST /api/v1/conversations/[id]/usable-for-rag: a RPC recebe a organização do token", async () => {
    const { res, texto, falso } = await comoToken(USABLE_FOR_RAG_POST);
    expect(res.status, texto).toBe(200);
    const chamada = falso.rpcs.find((r) => r.nome === "fn_conversa_remove_trechos_do_rag");
    expect(chamada?.args.p_org).toBe(ORG_A);
  });

  it("GET /api/v1/conversations/[id]/sector: leitura filtra a org do token", async () => {
    const { res, texto, falso } = await comoToken(SECTOR_GET);
    expect(res.status, texto).toBe(200);
    const cadeia = falso.cadeias.find((c) => c.tabela === "conversations");
    expect(cadeia?.filtros).toContainEqual(["organization_id", ORG_A]);
  });

  it("PUT /api/v1/conversations/[id]/sector: escrita filtra a org do token", async () => {
    const { res, texto, falso } = await comoToken(SECTOR_PUT);
    expect(res.status, texto).toBe(200);
    const cadeia = falso.cadeias.find((c) => c.tabela === "conversations");
    expect(cadeia?.filtros).toContainEqual(["organization_id", ORG_A]);
  });

  it("PUT /api/v1/conversations/[id]/sector: conversa COM dono não é redistribuída", async () => {
    const linhas: Linhas = {
      ...LINHAS_BASE,
      conversations: [
        { ...CONVERSAS[0], assigned_to_user_id: PESSOA_DA_SESSAO, assignee_kind: "user", sector_id: null },
        CONVERSAS[1]!,
      ],
    };
    const { res, texto, falso } = await comoToken(SECTOR_PUT, { linhas });
    expect(res.status, texto).toBe(200);
    expect(texto).toContain('"redistribuiu":false');
    expect(falso.rpcs.find((r) => r.nome === "fn_request_channel_routing")).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
    );
  });

  it("GET /api/v1/conversations/[id]/participants: lista só quem participa na organização do token", async () => {
    const { res, texto, falso } = await comoToken(PARTICIPANTES_GET);
    expect(res.status, texto).toBe(200);
    expect(texto).toContain(PARTICIPANTE_A);
    expect(texto).not.toContain(PARTICIPANTE_B);
    const leituras = falso.cadeias.filter((c) => c.tabela === "conversation_participants");
    expect(leituras.length).toBeGreaterThan(0);
    for (const leitura of leituras) expect(leitura.filtros).toContainEqual(["organization_id", ORG_A]);
  });

  it("GET /api/v1/conversations/[id]/participants: token de B pedindo a conversa de A não lê a lista", async () => {
    const { res, falso } = await comoToken(PARTICIPANTES_GET, { org: ORG_B });
    expect(res.status).toBe(404);
    expect(falso.cadeias.some((c) => c.tabela === "conversation_participants")).toBe(false);
  });

  it("GET /api/v1/conversations/[id]/transfer: a RPC e o número levam a organização do token", async () => {
    const { res, texto, falso } = await comoToken(TRANSFERENCIA_PREVIA_GET);
    expect(res.status, texto).toBe(200);
    expect(texto).toContain("Número da A");
    expect(texto).not.toContain("Número da B");
    const chamada = falso.rpcs.find((r) => r.nome === "fn_numero_da_transferencia");
    expect(chamada?.args.p_organization_id).toBe(ORG_A);
    const sessoes = falso.cadeias.filter((c) => c.tabela === "channel_sessions");
    expect(sessoes.length).toBeGreaterThan(0);
    for (const s of sessoes) expect(s.filtros).toContainEqual(["organization_id", ORG_A]);
  });

  it("GET /api/v1/conversations/[id]/transfer: token de B não chega à RPC", async () => {
    const { res, falso } = await comoToken(TRANSFERENCIA_PREVIA_GET, { org: ORG_B });
    expect(res.status).toBe(404);
    expect(falso.rpcs.find((r) => r.nome === "fn_numero_da_transferencia")).toBeUndefined();
  });

  it("GET /api/v1/conversations/[id]/transfer: sem to_user_id válido → 400, sem tocar no banco", async () => {
    const c: Caso = { ...TRANSFERENCIA_PREVIA_GET, caminho: `/api/v1/conversations/${CONVERSA_A}/transfer` };
    const { res, falso } = await comoToken(c);
    expect(res.status).toBe(400);
    expect(falso.cadeias).toEqual([]);
    expect(falso.rpcs).toEqual([]);
  });

  it("GET /api/v1/conversations/[id]/notes/[noteId]/media: assina o anexo da organização do token", async () => {
    const { res, falso } = await comoToken(NOTA_COM_ANEXO_GET);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(CAMINHO_DO_ANEXO_A);
    expect(falso.uploads).toEqual([{ bucket: "internal-media", caminho: CAMINHO_DO_ANEXO_A, operacao: "createSignedUrl" }]);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("GET /api/v1/conversations/[id]/notes/[noteId]/media: token de B não assina nada da A", async () => {
    const { res, falso } = await comoToken(NOTA_COM_ANEXO_GET, { org: ORG_B });
    expect(res.status).toBe(404);
    expect(falso.uploads).toEqual([]);
  });
});

// ─── A borda que nenhum teste de handler alcança: o proxy ───────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * entrada em PUBLIC_PATHS o Bearer nem chega à rota. A porta precisa ser
 * ESTREITA: id em forma de UUID, âncora nos dois lados.
 *
 * Irmãos literais de `[id]` (ls app/api/v1/conversations/[id]/) que NÃO ganharam
 * porta nesta fatia: aviso-de-mensagem, claim, close, draft-reply, export,
 * mark-read, pause-ai, reactivate-bot, release.
 * Irmãos de nível raiz sem porta: bulk, counts.
 * Fora deste teste, porque já tinham porta antes da R2 (`[^/]+` ou UUID):
 * drafts, media, open-with-contact.
 */
describe("PUBLIC_PATHS — as portas de conversas e conversation-tags", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/conversation-tags",
    "/api/v1/conversations",
    `/api/v1/conversations/${UUID}`,
    `/api/v1/conversations/${UUID}/messages`,
    `/api/v1/conversations/${UUID}/notes`,
    `/api/v1/conversations/${UUID}/notes/${UUID}/media`,
    `/api/v1/conversations/${UUID}/participants`,
    `/api/v1/conversations/${UUID}/passagens`,
    `/api/v1/conversations/${UUID}/retention`,
    `/api/v1/conversations/${UUID}/sector`,
    `/api/v1/conversations/${UUID}/snooze`,
    `/api/v1/conversations/${UUID}/transfer`,
    `/api/v1/conversations/${UUID}/usable-for-rag`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // id fora da forma de UUID
    "/api/v1/conversations/abc",
    "/api/v1/conversations/x",
    `/api/v1/conversations/${UUID}/abc`,
    // sub-path
    `/api/v1/conversations/${UUID}/x`,
    `/api/v1/conversations/${UUID}/notes/x`,
    `/api/v1/conversations/${UUID}/notes/${UUID}`,
    `/api/v1/conversations/${UUID}/notes/${UUID}/media/x`,
    // irmão literal do mesmo nível que NÃO ganhou porta
    `/api/v1/conversations/${UUID}/aviso-de-mensagem`,
    `/api/v1/conversations/${UUID}/claim`,
    `/api/v1/conversations/${UUID}/close`,
    `/api/v1/conversations/${UUID}/draft-reply`,
    `/api/v1/conversations/${UUID}/export`,
    `/api/v1/conversations/${UUID}/mark-read`,
    `/api/v1/conversations/${UUID}/pause-ai`,
    `/api/v1/conversations/${UUID}/reactivate-bot`,
    `/api/v1/conversations/${UUID}/release`,
    // irmão literal da raiz que NÃO ganhou porta
    "/api/v1/conversations/bulk",
    "/api/v1/conversations/counts",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});

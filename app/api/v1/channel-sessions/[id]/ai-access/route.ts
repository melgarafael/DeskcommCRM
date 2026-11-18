import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHANNEL_PROVIDER_SOCIAL } from "@/lib/channels/capabilities";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { extractBearer } from "@/lib/mcp/auth";
import {
  aiAccessUpdateSchema, ehIdentidadeSocialDeTeste, lerIdentidadesSociaisDeTeste,
  lerModoDeAcessoDaIa, lerNumerosDeTeste,
} from "@/lib/ai/elegibilidade/pre-go-live";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Quantas conversas recentes do canal a tela oferece como testador social. */
const LIMITE_DE_CANDIDATOS = 100;

/**
 * Um contato que pode virar testador social: a identidade é o valor gravado na
 * lista; o nome é só para a pessoa reconhecer quem está escolhendo.
 */
interface CandidatoSocial { social_identity: string; name: string | null }

interface LinhaDeConversa {
  contacts: { social_identity: string | null; display_name: string | null; name: string | null } | null;
}

/**
 * Os contatos de rede social que JÁ conversaram com este canal, mais recentes
 * primeiro, e os que já estão na lista (mesmo que a conversa seja antiga). A
 * tela escolhe daqui em vez de pedir um id cru de 60 caracteres. Só quem
 * pede (`?candidatos=sociais`) paga a leitura: o painel de WhatsApp não pede.
 */
async function candidatosSociais(
  db: SupabaseClient,
  orgId: string,
  canalId: string,
  naLista: readonly string[],
): Promise<CandidatoSocial[] | null> {
  const { data, error } = await db.from("conversations")
    .select("contacts:contact_id!inner(social_identity, display_name, name)")
    .eq("organization_id", orgId).eq("channel_session_id", canalId)
    .not("contacts.social_identity", "is", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(LIMITE_DE_CANDIDATOS);
  if (error) return null;

  const porIdentidade = new Map<string, CandidatoSocial>();
  const guardar = (c: LinhaDeConversa["contacts"]) => {
    const identidade = c?.social_identity?.trim();
    // Só o que a lista aceitaria: oferecer algo que a gravação recusa seria
    // um botão que dá erro.
    if (!identidade || !ehIdentidadeSocialDeTeste(identidade) || porIdentidade.has(identidade)) return;
    porIdentidade.set(identidade, { social_identity: identidade, name: nomeDoContato(c) });
  };
  for (const linha of (data ?? []) as unknown as LinhaDeConversa[]) guardar(linha.contacts);

  const faltam = naLista.filter((i) => !porIdentidade.has(i));
  if (faltam.length > 0) {
    const { data: contatos, error: erroDosContatos } = await db.from("contacts")
      .select("social_identity, display_name, name")
      .eq("organization_id", orgId).in("social_identity", faltam).is("is_merged_into", null);
    if (erroDosContatos) return null;
    for (const c of (contatos ?? []) as LinhaDeConversa["contacts"][]) guardar(c);
    // Na lista e sem ficha viva (anonimizada, fundida): continua visível para
    // poder ser REMOVIDA, só que sem nome.
    for (const i of faltam) if (!porIdentidade.has(i)) porIdentidade.set(i, { social_identity: i, name: null });
  }
  return [...porIdentidade.values()];
}

/** Só administradores podem ler os testadores ou mudar o alcance da IA. */
export async function GET(req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();

  // DOIS PORTÕES, UM CORPO (Spec 33, R3). O token `dsk_…` (escopo `mcp:read`,
  // papel admin) entra por `resolveAuthDual`; a sessão segue pelo `requireRole`
  // de sempre. A organização vem da linha do token ou da sessão, nunca do path.
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "channel_sessions",
      role: "admin",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "channel_sessions", requestId);
    if (teto) return teto;
    return lerAiAccess(authz.supabase, authz.organizationId, (await params).id, querCandidatos(req), requestId);
  }

  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  return lerAiAccess(createAdminClient(), auth.org.orgId, (await params).id, querCandidatos(req), requestId);
}

/** Só quem pede (`?candidatos=sociais`) paga a leitura dos contatos do canal. */
function querCandidatos(req: NextRequest): boolean {
  return req.nextUrl?.searchParams.get("candidatos") === "sociais";
}

async function lerAiAccess(
  db: SupabaseClient,
  organizationId: string,
  id: string,
  candidatos: boolean,
  requestId: string,
): Promise<Response> {
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const { data, error } = await db.from("channel_sessions")
    .select("metadata").eq("organization_id", organizationId).eq("id", id)
    .is("archived_at", null).maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar o acesso da IA.", 500, { requestId });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  const testSocialIdentities = lerIdentidadesSociaisDeTeste(data.metadata);
  const base = {
    mode: lerModoDeAcessoDaIa(data.metadata),
    test_phone_numbers: lerNumerosDeTeste(data.metadata),
    test_social_identities: testSocialIdentities,
  };
  if (!candidatos) return ok(base, { requestId });
  const sociais = await candidatosSociais(db, organizationId, id, testSocialIdentities);
  if (sociais === null) return fail("internal_error", "Não foi possível carregar os contatos deste canal.", 500, { requestId });
  return ok({ ...base, social_candidates: sociais }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = aiAccessUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Use telefones com DDI, por exemplo +5511999998888, e escolha os testadores de rede social entre os contatos do canal.", 422, { requestId });
  const { mode, test_phone_numbers, test_social_identities } = parsed.data;
  // A forma não basta: só entra o que a tela oferece para ESTE canal. Lista
  // vazia é remoção, e remover é sempre permitido.
  if (test_social_identities !== undefined && test_social_identities.length > 0) {
    const admin = createAdminClient();
    const { data: canal, error: erroDoCanal } = await admin.from("channel_sessions")
      .select("provider, metadata").eq("organization_id", auth.org.orgId).eq("id", id)
      .is("archived_at", null).maybeSingle();
    if (erroDoCanal) return fail("internal_error", "Não foi possível carregar o canal.", 500, { requestId });
    if (!canal) return fail("not_found", "Canal não encontrado.", 404, { requestId });
    if (canal.provider !== CHANNEL_PROVIDER_SOCIAL) {
      return fail("testador_social_recusado", `Este canal não é de rede social; a identidade ${test_social_identities[0]} não pode ser testadora aqui.`, 422, { requestId });
    }
    const gravadas = lerIdentidadesSociaisDeTeste(canal.metadata);
    const novas = test_social_identities.filter((i) => !gravadas.includes(i));
    if (novas.length > 0) {
      // A MESMA leitura que o GET usa para oferecer os candidatos.
      const candidatos = await candidatosSociais(admin, auth.org.orgId, id, gravadas);
      if (candidatos === null) return fail("internal_error", "Não foi possível carregar os contatos deste canal.", 500, { requestId });
      const oferecidas = new Set(candidatos.map((c) => c.social_identity));
      const recusada = novas.find((i) => !oferecidas.has(i));
      if (recusada !== undefined) {
        return fail("testador_social_recusado", `A identidade ${recusada} não é de um contato que conversou com este canal. Escolha entre os contatos oferecidos.`, 422, { requestId });
      }
    }
  }
  // RPC atômica: não sobrescreve as demais configurações de metadata. A lista
  // social só vai quando a tela a mandou — ausente, a sobrecarga de 4
  // argumentos deixa a lista gravada como está.
  const { data, error } = test_social_identities === undefined
    ? await createAdminClient().rpc("fn_configurar_pre_go_live_canal", {
      p_org: auth.org.orgId, p_canal: id, p_modo: mode, p_numeros: test_phone_numbers,
    })
    : await createAdminClient().rpc("fn_configurar_pre_go_live_canal", {
      p_org: auth.org.orgId, p_canal: id, p_modo: mode, p_numeros: test_phone_numbers,
      p_identidades: test_social_identities,
    });
  if (error) return fail("internal_error", "Não foi possível salvar o acesso da IA. Verifique se o banco está atualizado.", 500, { requestId });
  if (data !== 1) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  void audit({
    action: "channel.ai_access_updated", actorUserId: auth.user.id,
    organizationId: auth.org.orgId, resourceType: "channel_session", resourceId: id, requestId,
    // Contagens, nunca os valores: telefone e identidade social são dado pessoal.
    metadata: {
      mode, test_phone_numbers_count: test_phone_numbers.length,
      ...(test_social_identities !== undefined ? { test_social_identities_count: test_social_identities.length } : {}),
    },
  });
  return ok(parsed.data, { requestId });
}

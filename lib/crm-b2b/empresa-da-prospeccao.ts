/**
 * "Transformar em empresa": o contato que a prospecção criou passa a ter a
 * Empresa do módulo "Empresas e pessoas" (issue #3198, fatia 3).
 *
 * A fatia 2 faz isso sozinha para o contato que NASCE depois dela. Quem já foi
 * prospectado antes — ou com o módulo desligado — fica sem empresa, e este
 * handler é o caminho pela tela: o atendente clica na ficha e o servidor faz o
 * mesmo que a prospecção faria.
 *
 * Reaproveita `empresaDoCandidato` (fatia 2): cria ou reaproveita a Empresa
 * pelo `place_id` DENTRO da organização. O que esta fatia acrescenta é só:
 *   - de onde vêm os dados — a linha viva de `prospecting_candidates` e, vencida
 *     a poda de 365 dias, o que sobrou no contato (`place_id` e `maps_url`);
 *   - o endereço, separado em colunas pelo parser conservador
 *     (`endereco-do-maps.ts`), gravado só onde a coluna está VAZIA;
 *   - o vínculo `contacts.company_id`, com rastro no audit.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { enderecoDoMaps, type EnderecoDaEmpresa } from "@/lib/crm-b2b/endereco-do-maps";
import { logger } from "@/lib/logger";
import { empresaDoCandidato, type NegocioDoMaps } from "@/lib/prospecting/empresa-do-candidato";
import { prospectEnrichmentSchema } from "@/lib/prospecting/schema";
import { createAdminClient } from "@/lib/supabase/admin";

type SB = SupabaseClient;

const COLUNAS_DE_ENDERECO = [
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "zip_code",
] as const;

function err(ctx: HandlerCtx, status: number, code: string, message: string): never {
  throw new ApiError(status, code, undefined, ctx.requestId, message);
}

interface LinhaDoContato {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  company_id: string | null;
  is_anonymized: boolean | null;
}

function placeIdDoContato(c: LinhaDoContato): string | null {
  if (c.source !== "prospecting") return null;
  const v = c.source_metadata?.place_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function lerContato(supabase: SB, ctx: HandlerCtx, contactId: string): Promise<LinhaDoContato> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, name, display_name, phone_number, source, source_metadata, company_id, is_anonymized")
    .eq("organization_id", ctx.organization_id)
    .eq("id", contactId)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Contato não encontrado.");
  return data as LinhaDoContato;
}

export interface EstadoDaEmpresaDaProspeccao {
  /** O botão faz sentido: contato da prospecção, com `place_id`, sem empresa, não anonimizado. */
  elegivel: boolean;
  /** A Empresa já ligada ao contato, se houver. */
  empresa: { id: string; nome: string | null } | null;
}

/** O que a ficha precisa para decidir se mostra o botão. Só lê. */
export async function estadoDaEmpresaDaProspeccaoHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<EstadoDaEmpresaDaProspeccao> {
  const contato = await lerContato(supabase, ctx, contactId);

  let empresa: EstadoDaEmpresaDaProspeccao["empresa"] = null;
  if (contato.company_id) {
    const { data, error } = await supabase
      .from("companies")
      .select("id, trade_name, legal_name")
      .eq("organization_id", ctx.organization_id)
      .eq("id", contato.company_id)
      .maybeSingle();
    if (error) err(ctx, 500, "internal_error", error.message);
    if (data) {
      const linha = data as { id: string; trade_name: string | null; legal_name: string | null };
      empresa = { id: linha.id, nome: linha.trade_name || linha.legal_name };
    }
  }

  return {
    elegivel: !contato.is_anonymized && !contato.company_id && placeIdDoContato(contato) !== null,
    empresa,
  };
}

/**
 * O que a prospecção sabia do negócio: a linha viva do candidato quando existe,
 * senão só o que o contato guardou. A linha é apagada após 365 dias — sem ela
 * sobram o nome, o telefone, o `place_id` e o `maps_url` do contato.
 */
async function negocioDoContato(
  admin: SB,
  ctx: HandlerCtx,
  contato: LinhaDoContato,
  placeId: string,
): Promise<{ negocio: NegocioDoMaps; endereco: string | null }> {
  const { data: candidato } = await admin
    .from("prospecting_candidates")
    .select("data")
    .eq("organization_id", ctx.organization_id)
    .eq("contact_id", contato.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const parsed = candidato ? prospectEnrichmentSchema.safeParse((candidato as { data: unknown }).data) : null;
  const dados = parsed?.success ? parsed.data : null;

  const mapsDoContato =
    typeof contato.source_metadata?.maps_url === "string" ? contato.source_metadata.maps_url : null;

  return {
    negocio: {
      key: placeId,
      name: dados?.name || nomeDoContato(contato) || "Empresa sem nome",
      phone: contato.phone_number,
      website: dados?.website ?? null,
      maps_url: dados?.maps_url ?? mapsDoContato,
      emails: dados?.emails ?? [],
    },
    endereco: dados?.address ?? null,
  };
}

/** Preenche só a coluna de endereço que está VAZIA: o que a equipe digitou manda. */
async function completarEndereco(
  admin: SB,
  ctx: HandlerCtx,
  companyId: string,
  endereco: EnderecoDaEmpresa,
): Promise<string[]> {
  if (Object.keys(endereco).length === 0) return [];
  const { data, error } = await admin
    .from("companies")
    .select(COLUNAS_DE_ENDERECO.join(", "))
    .eq("organization_id", ctx.organization_id)
    .eq("id", companyId)
    .maybeSingle();
  if (error || !data) {
    logger.warn("[crm-b2b] empresa da prospecção: leitura do endereço falhou", {
      organization_id: ctx.organization_id,
      company_id: companyId,
      request_id: ctx.requestId,
      error: error?.message,
    });
    return [];
  }
  const atual = data as unknown as Record<string, string | null>;
  const patch: Record<string, string> = {};
  for (const coluna of COLUNAS_DE_ENDERECO) {
    const novo = endereco[coluna];
    if (novo && !(atual[coluna] ?? "").trim()) patch[coluna] = novo;
  }
  if (Object.keys(patch).length === 0) return [];
  const { error: erroDoUpdate } = await admin
    .from("companies")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", companyId);
  if (erroDoUpdate) {
    // O endereço é complemento: sem ele a Empresa existe e o vínculo segue.
    logger.warn("[crm-b2b] empresa da prospecção: gravar o endereço falhou", {
      organization_id: ctx.organization_id,
      company_id: companyId,
      request_id: ctx.requestId,
      error: erroDoUpdate.message,
    });
    return [];
  }
  return Object.keys(patch);
}

export interface EmpresaDaProspeccaoResultado {
  company_id: string;
  /** `true` quando esta chamada criou a Empresa; `false` quando reaproveitou uma do mesmo `place_id`. */
  criada: boolean;
  /** As colunas de endereço que esta chamada preencheu. */
  endereco_preenchido: string[];
}

export async function transformarContatoEmEmpresaHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  contactId: string,
): Promise<EmpresaDaProspeccaoResultado> {
  const contato = await lerContato(supabase, ctx, contactId);

  if (contato.is_anonymized) {
    err(ctx, 422, "validation_failed", "Contato anonimizado não vira empresa.");
  }
  if (contato.company_id) {
    err(ctx, 409, "conflict", "Este contato já está ligado a uma empresa.");
  }
  const placeId = placeIdDoContato(contato);
  if (!placeId) {
    err(ctx, 422, "validation_failed", "Só o contato que veio da prospecção vira empresa por aqui.");
  }

  const admin = createAdminClient();
  const { negocio, endereco } = await negocioDoContato(admin, ctx, contato, placeId);

  const { data: jaExistia, error: erroDaBusca } = await admin
    .from("companies")
    .select("id")
    .eq("organization_id", ctx.organization_id)
    .eq("place_id", placeId)
    .maybeSingle();
  if (erroDaBusca) err(ctx, 500, "internal_error", erroDaBusca.message);

  const companyId = await empresaDoCandidato(admin, ctx.organization_id, negocio);
  if (!companyId) err(ctx, 500, "internal_error", "Não foi possível criar a empresa.");

  const enderecoPreenchido = await completarEndereco(admin, ctx, companyId, enderecoDoMaps(endereco));

  // O vínculo: só se o contato continua sem empresa (duas pessoas clicando juntas).
  // O gatilho `trg_contacts_company_same_org` (9406) recusa empresa de outra organização.
  const { data: ligado, error: erroDoVinculo } = await supabase
    .from("contacts")
    .update({ company_id: companyId })
    .eq("organization_id", ctx.organization_id)
    .eq("id", contactId)
    .is("company_id", null)
    .select("id");
  if (erroDoVinculo) err(ctx, 500, "internal_error", erroDoVinculo.message);
  if (!ligado || ligado.length === 0) {
    const atual = await lerContato(supabase, ctx, contactId);
    if (atual.company_id === companyId) {
      return { company_id: companyId, criada: !jaExistia, endereco_preenchido: enderecoPreenchido };
    }
    err(ctx, 409, "conflict", "Este contato já está ligado a uma empresa.");
  }

  if (!jaExistia) {
    await audit({
      organizationId: ctx.organization_id,
      actorUserId,
      actorApiTokenId: ctx.apiTokenId ?? null,
      action: "companies.created",
      resourceType: "companies",
      resourceId: companyId,
      requestId: ctx.requestId,
      metadata: { origin: "prospecting_contact", place_id: placeId },
    });
  }
  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    actorApiTokenId: ctx.apiTokenId ?? null,
    action: "contacts.company_linked",
    resourceType: "contacts",
    resourceId: contactId,
    requestId: ctx.requestId,
    metadata: { company_id: companyId, origin: "prospecting_contact" },
  });

  return { company_id: companyId, criada: !jaExistia, endereco_preenchido: enderecoPreenchido };
}

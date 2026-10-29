/**
 * Telefones da ficha além do principal (Spec 31, B2): adicionar, editar tipo /
 * WhatsApp / rótulo, remover e "Tornar principal".
 *
 * As rotas em `..` cuidam de sessão, papel (`agent`), `requireSupportWrite` e do
 * envelope. Aqui fica a regra: a ficha precisa estar viva (não mesclada, não
 * anonimizada) e da organização, e cada consulta filtra organização e ficha —
 * o `{id}` da URL não basta sozinho, porque o `{phoneId}` pode ser de outra ficha.
 *
 * O audit leva ids, tipo e WhatsApp; o NÚMERO não entra no metadata (a trilha é
 * append-only e a cascata de LGPD não a alcança).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { ApiError } from "@/lib/api/types";
import { canonicalPhoneBR, normalizePhoneBR } from "@/lib/channels/phone-variants";
import type { TelefoneExtraCreate, TelefoneExtraPatch } from "@/lib/schemas/contacts";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Id malformado nunca chega ao Postgres (que responderia 500 por `22P02`). */
export function ehUuid(valor: string): boolean {
  return UUID_RE.test(valor);
}

export interface TelefoneCtx {
  supabase: SupabaseClient;
  organizationId: string;
  contactId: string;
  actorUserId: string;
  requestId: string;
  idioma?: Idioma;
}

/** A forma que a API devolve para um extra (sem `wa_lid`, de propósito). */
export interface TelefoneExtraApi {
  id: string;
  phone_number: string;
  type: string;
  whatsapp: string;
  label: string | null;
  origin: string;
  created_at: string;
}

interface LinhaDeTelefone {
  id: string;
  phone_number: string;
  tipo: string;
  whatsapp: string;
  rotulo: string | null;
  origem: string;
  created_at: string;
}

const COLUNAS_DO_EXTRA = "id, phone_number, tipo, whatsapp, rotulo, origem, created_at";

function idioma(ctx: TelefoneCtx): Idioma {
  return ctx.idioma ?? "pt-BR";
}

function mapaDoExtra(linha: LinhaDeTelefone): TelefoneExtraApi {
  return {
    id: linha.id,
    phone_number: linha.phone_number,
    type: linha.tipo,
    whatsapp: linha.whatsapp,
    label: linha.rotulo,
    origin: linha.origem,
    created_at: linha.created_at,
  };
}

function erroDeBanco(ctx: TelefoneCtx, mensagem: string): ApiError {
  return new ApiError(500, "internal_error", undefined, ctx.requestId, mensagem);
}

/** 23505: o número (ou o `lid`) já é de outra ficha viva da organização. */
function erroDeNumeroEmUso(ctx: TelefoneCtx, mensagem?: string): ApiError {
  return new ApiError(
    409,
    "phone_in_use",
    undefined,
    ctx.requestId,
    mensagem ?? traduzir("Este número já está em outra ficha.", idioma(ctx)),
  );
}

/**
 * A ficha viva da organização, ou 404. Mesma régua do PATCH de contato: mesclada
 * e anonimizada não recebem telefone novo.
 */
async function fichaViva(ctx: TelefoneCtx): Promise<{ id: string; phone_number: string | null }> {
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("id, phone_number")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.contactId)
    .is("is_merged_into", null)
    .eq("is_anonymized", false)
    .maybeSingle();
  if (error) throw erroDeBanco(ctx, error.message);
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, traduzir("Contato não encontrado.", idioma(ctx)));
  }
  return data as { id: string; phone_number: string | null };
}

function numeroCanonico(ctx: TelefoneCtx, bruto: string): string {
  const e164 = normalizePhoneBR(bruto);
  if (!e164) {
    throw new ApiError(
      422,
      "invalid_phone",
      undefined,
      ctx.requestId,
      traduzir("Telefone inválido. Informe DDD e número.", idioma(ctx)),
    );
  }
  return e164;
}

/** Registra o evento de "a ficha ganhou o principal", como o PATCH de contato já faz. */
async function emitirTelefoneAdicionado(ctx: TelefoneCtx, numero: string): Promise<void> {
  await createAdminClient()
    .rpc("emit_event", {
      p_event_type: "contact.phone_added",
      p_entity_kind: "contact",
      p_entity_id: ctx.contactId,
      p_payload: { phone_number: numero },
      p_metadata: { request_id: ctx.requestId, actor_user_id: ctx.actorUserId },
      p_organization_id: ctx.organizationId,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.phones] emit_event failed", error.message);
    });
}

async function auditar(
  ctx: TelefoneCtx,
  action: AuditAction,
  contatoId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await audit({
    action,
    actorUserId: ctx.actorUserId,
    organizationId: ctx.organizationId,
    resourceType: "contact",
    resourceId: contatoId,
    requestId: ctx.requestId,
    metadata,
  });
}

/**
 * `POST /contacts/{id}/phones`. Ficha SEM principal: o número vira o principal
 * (`became_primary`). Ficha com principal: vira um extra de origem `manual`.
 */
export async function adicionarTelefone(
  ctx: TelefoneCtx,
  input: TelefoneExtraCreate,
): Promise<{ became_primary: true } | TelefoneExtraApi> {
  const ficha = await fichaViva(ctx);
  const numero = numeroCanonico(ctx, input.phone_number);

  if (!ficha.phone_number) {
    // Só os campos que vieram: o que não veio, o gatilho do banco preenche.
    const patch: Record<string, unknown> = {
      phone_number: numero,
      updated_at: new Date().toISOString(),
    };
    if (input.type !== undefined) patch.phone_type = input.type;
    if (input.whatsapp !== undefined) patch.phone_whatsapp = input.whatsapp;
    const { error } = await ctx.supabase
      .from("contacts")
      .update(patch)
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.contactId);
    if (error) {
      if (error.code === "23505") throw erroDeNumeroEmUso(ctx);
      throw erroDeBanco(ctx, error.message);
    }
    await auditar(ctx, "contact.primary_phone_changed", ctx.contactId, {
      became_primary: true,
      type: input.type ?? null,
      whatsapp: input.whatsapp ?? null,
    });
    await emitirTelefoneAdicionado(ctx, numero);
    return { became_primary: true };
  }

  if (canonicalPhoneBR(ficha.phone_number) === numero) {
    throw erroDeNumeroEmUso(ctx, traduzir("Este número já é o principal desta ficha.", idioma(ctx)));
  }

  const linha: Record<string, unknown> = {
    organization_id: ctx.organizationId,
    contact_id: ctx.contactId,
    phone_number: numero,
    origem: "manual",
  };
  if (input.type !== undefined) linha.tipo = input.type;
  if (input.whatsapp !== undefined) linha.whatsapp = input.whatsapp;
  if (input.label) linha.rotulo = input.label;

  const { data, error } = await ctx.supabase
    .from("contact_phones")
    .insert(linha)
    .select(COLUNAS_DO_EXTRA)
    .single();
  if (error) {
    if (error.code === "23505") throw erroDeNumeroEmUso(ctx);
    throw erroDeBanco(ctx, error.message);
  }
  const extra = mapaDoExtra(data as LinhaDeTelefone);
  await auditar(ctx, "contact.extra_phone_added", ctx.contactId, {
    extra_phone_id: extra.id,
    type: extra.type,
    whatsapp: extra.whatsapp,
    origin: extra.origin,
  });
  return extra;
}

/** `PATCH /contacts/{id}/phones/{phoneId}`: tipo, WhatsApp e rótulo. */
export async function editarTelefoneExtra(
  ctx: TelefoneCtx,
  phoneId: string,
  input: TelefoneExtraPatch,
): Promise<TelefoneExtraApi> {
  await fichaViva(ctx);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.type !== undefined) patch.tipo = input.type;
  if (input.whatsapp !== undefined) patch.whatsapp = input.whatsapp;
  if (input.label !== undefined) patch.rotulo = input.label ? input.label : null;

  const { data, error } = await ctx.supabase
    .from("contact_phones")
    .update(patch)
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", ctx.contactId)
    .eq("id", phoneId)
    .select(COLUNAS_DO_EXTRA)
    .maybeSingle();
  if (error) throw erroDeBanco(ctx, error.message);
  if (!data) throw telefoneNaoEncontrado(ctx);

  const extra = mapaDoExtra(data as LinhaDeTelefone);
  await auditar(ctx, "contact.extra_phone_updated", ctx.contactId, {
    extra_phone_id: extra.id,
    campos: Object.keys(patch).filter((c) => c !== "updated_at"),
  });
  return extra;
}

/** `DELETE /contacts/{id}/phones/{phoneId}`. */
export async function removerTelefoneExtra(ctx: TelefoneCtx, phoneId: string): Promise<void> {
  await fichaViva(ctx);
  const { data, error } = await ctx.supabase
    .from("contact_phones")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", ctx.contactId)
    .eq("id", phoneId)
    .select("id")
    .maybeSingle();
  if (error) throw erroDeBanco(ctx, error.message);
  if (!data) throw telefoneNaoEncontrado(ctx);
  await auditar(ctx, "contact.extra_phone_removed", ctx.contactId, { extra_phone_id: phoneId });
}

/**
 * `POST /contacts/{id}/phones/{phoneId}/primary`: a troca numa operação só, na
 * função `fn_tornar_telefone_principal` (migration 9043). `P0002` = o extra não é
 * desta ficha, ou a ficha não está viva.
 */
export async function tornarTelefonePrincipal(ctx: TelefoneCtx, phoneId: string): Promise<void> {
  const { error } = await ctx.supabase.rpc("fn_tornar_telefone_principal", {
    p_org: ctx.organizationId,
    p_contato: ctx.contactId,
    p_extra: phoneId,
  });
  if (error) {
    if (error.code === "P0002") throw telefoneNaoEncontrado(ctx);
    if (error.code === "23505") throw erroDeNumeroEmUso(ctx);
    throw erroDeBanco(ctx, error.message);
  }
  await auditar(ctx, "contact.primary_phone_changed", ctx.contactId, {
    became_primary: false,
    extra_phone_id: phoneId,
  });
}

function telefoneNaoEncontrado(ctx: TelefoneCtx): ApiError {
  return new ApiError(
    404,
    "not_found",
    undefined,
    ctx.requestId,
    traduzir("Telefone não encontrado nesta ficha.", idioma(ctx)),
  );
}

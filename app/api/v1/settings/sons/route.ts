import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/settings/sons — os sons dos avisos da Central (a etapa que avisa e o
 * pedido de pessoa), escolhidos pela organização. Ver `lib/notifications/sons-da-org.ts`.
 *
 *   GET    — URL assinada (1 h) de cada som, para a campainha tocar. Qualquer membro.
 *   POST   — multipart `tipo` + `arquivo`. Manager ou acima. Substitui o anterior.
 *   DELETE — `?tipo=`. Manager ou acima. Volta ao bipe do produto.
 *
 * O tipo do arquivo é FAREJADO pelos bytes; o bucket é privado e só o
 * service_role lê e grava (migration 0441). Organização sempre da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import {
  BUCKET_DOS_SONS,
  TAMANHO_MAXIMO_DO_SOM,
  TIPOS_DE_SOM,
  extensaoDoAudio,
  farejarAudio,
  type TipoDeSom,
} from "@/lib/notifications/sons-da-org";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const VALIDADE_SEGUNDOS = 3600;

type Sons = Partial<Record<TipoDeSom, string>>;

function ehTipo(v: unknown): v is TipoDeSom {
  return typeof v === "string" && (TIPOS_DE_SOM as readonly string[]).includes(v);
}

/**
 * `null` quando a leitura FALHOU — e quem grava tem de parar aí. Tratar a falha
 * como `settings` vazio faria o update seguinte regravar o jsonb inteiro só com
 * `sons_de_aviso`, apagando toda a configuração da organização.
 */
async function lerConfiguracao(
  orgId: string,
): Promise<{ settings: Record<string, unknown>; sons: Sons } | null> {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    logger.error("[settings/sons] leitura de organizations.settings falhou", { detail: error.message });
    return null;
  }
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const bruto = settings.sons_de_aviso;
  const sons: Sons = {};
  if (bruto && typeof bruto === "object") {
    for (const tipo of TIPOS_DE_SOM) {
      const caminho = (bruto as Record<string, unknown>)[tipo];
      // Só caminho DESTA organização: a linha é gravável e o bucket é assinado pelo service_role.
      if (typeof caminho === "string" && caminho.startsWith(`${orgId}/`)) sons[tipo] = caminho;
    }
  }
  return { settings, sons };
}

async function gravarSons(orgId: string, settings: Record<string, unknown>, sons: Sons): Promise<boolean> {
  // Cliente admin: a RLS de `organizations` só deixa platform admin escrever, e
  // com o cliente de sessão isto casaria zero linhas dizendo "sucesso".
  const admin = createAdminClient();
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, sons_de_aviso: sons } })
    .eq("id", orgId);
  return !error;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "settings_sons" });
  if (!authz.ok) return authz.response;

  // Leitura que falhou degrada para o bipe do produto: o aviso toca de qualquer jeito.
  const sons = (await lerConfiguracao(authz.org.orgId))?.sons ?? {};
  const urls: Record<TipoDeSom, string | null> = { venda: null, pessoa: null };
  for (const tipo of TIPOS_DE_SOM) {
    const caminho = sons[tipo];
    if (!caminho) continue;
    const { data } = await createAdminClient().storage.from(BUCKET_DOS_SONS).createSignedUrl(caminho, VALIDADE_SEGUNDOS);
    urls[tipo] = data?.signedUrl ?? null;
  }
  return ok(urls, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_sons" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  // O `arquivo.size` abaixo continua sendo o check autoritativo. A folga cobre
  // o envelope multipart.
  const corpo = await lerCorpoComTeto(req, TAMANHO_MAXIMO_DO_SOM + 64 * 1024, {
    requestId,
    idioma: authz.user.idioma,
    acimaDoTeto: t("O som pode ter no máximo 1 MB."),
  });
  if (!corpo.ok) return corpo.response;
  const form = await corpo.corpo.formData().catch(() => null);
  const tipo = form?.get("tipo");
  const arquivo = form?.get("arquivo");
  if (!ehTipo(tipo) || !(arquivo instanceof File)) {
    return fail("invalid_request", t("Escolha o aviso e o arquivo de som."), 400, { requestId });
  }
  if (arquivo.size > TAMANHO_MAXIMO_DO_SOM) {
    return fail("payload_too_large", t("O som pode ter no máximo 1 MB."), 413, { requestId });
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const tipoReal = farejarAudio(bytes);
  if (!tipoReal) {
    return fail("unsupported_media_type", t("O som precisa ser MP3, OGG ou WAV."), 415, { requestId });
  }

  // Lê a configuração ANTES de subir: falhar aqui não deixa arquivo órfão.
  const atual = await lerConfiguracao(orgId);
  if (!atual) return fail("internal_error", t("Erro ao salvar o som."), 500, { requestId });

  const caminho = `${orgId}/${tipo}-${randomUUID()}.${extensaoDoAudio(tipoReal)}`;
  const admin = createAdminClient();
  const { error: erroUp } = await admin.storage
    .from(BUCKET_DOS_SONS)
    .upload(caminho, Buffer.from(bytes), { contentType: tipoReal, upsert: false });
  if (erroUp) {
    logger.error("[settings/sons] upload falhou", { detail: erroUp.message, requestId });
    return fail("internal_error", t("Erro ao subir o som."), 500, { requestId });
  }

  const { settings, sons } = atual;
  const anterior = sons[tipo];
  if (!(await gravarSons(orgId, settings, { ...sons, [tipo]: caminho }))) {
    await admin.storage.from(BUCKET_DOS_SONS).remove([caminho]);
    return fail("internal_error", t("Erro ao salvar o som."), 500, { requestId });
  }
  // O arquivo anterior sai DEPOIS de o novo estar gravado: falhar aqui deixa um
  // órfão pequeno, nunca um aviso sem som.
  if (anterior) await admin.storage.from(BUCKET_DOS_SONS).remove([anterior]);

  void audit({
    action: "settings.notification_sound_updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { tipo, bytes: bytes.length, formato: tipoReal },
  });
  return ok({ tipo }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_sons" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const tipo = new URL(req.url).searchParams.get("tipo");
  if (!ehTipo(tipo)) return fail("invalid_request", t("Aviso desconhecido."), 400, { requestId });

  const atual = await lerConfiguracao(orgId);
  if (!atual) return fail("internal_error", t("Erro ao salvar o som."), 500, { requestId });
  const { settings, sons } = atual;
  const caminho = sons[tipo];
  const resto = { ...sons };
  delete resto[tipo];
  if (!(await gravarSons(orgId, settings, resto))) {
    return fail("internal_error", t("Erro ao salvar o som."), 500, { requestId });
  }
  if (caminho) await createAdminClient().storage.from(BUCKET_DOS_SONS).remove([caminho]);

  void audit({
    action: "settings.notification_sound_removed",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { tipo },
  });
  return ok({ tipo }, { requestId });
}

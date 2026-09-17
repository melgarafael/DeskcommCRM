import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida, sessionAal } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

import { ExtensionError } from "./errors";

/** Falhas do gestor, separadas das falhas do arquivo/distribuição. */
export class ExtensionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ExtensionServiceError";
  }
}

type PlatformCheck = { ok: true; user: AuthUser } | { ok: false; response: Response };

/** Guard de API: o guard de páginas redireciona e não deve virar resposta JSON 500. */
export async function requireExtensionPlatform(): Promise<PlatformCheck> {
  const user = await loadAuthUser();
  if (!user) {
    return { ok: false, response: fail("unauthenticated", "Faça login para continuar.", 401) };
  }
  return requireExtensionPlatformFor(user);
}

/**
 * A mesma conferência, para quem já carregou o usuário. Recarregar faria um segundo getUser() pela
 * rede, e uma falha passageira nele virava 401, lido como "não administra a instalação".
 */
export async function requireExtensionPlatformFor(user: AuthUser): Promise<PlatformCheck> {
  const t = (text: string) => traduzir(text, user.idioma);
  if (!user.is_platform_admin || user.support) {
    return {
      ok: false,
      response: fail(
        "forbidden",
        t("Só o administrador da instalação pode gerenciar os pacotes disponíveis."),
        403,
      ),
    };
  }
  const db = await createClient();
  const { data: platform, error } = await db
    .from("platform_admins")
    .select("scope, mfa_required")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      response: fail(
        "upstream_unavailable",
        t("Não foi possível confirmar a permissão de acesso."),
        503,
      ),
    };
  }
  if (!platform || platform.scope !== "full") {
    return {
      ok: false,
      response: fail(
        "forbidden",
        t("Só o administrador da instalação pode gerenciar os pacotes disponíveis."),
        403,
      ),
    };
  }
  if ((platform.mfa_required && (await sessionAal()) !== "aal2") || (await mfaEmDivida())) {
    return {
      ok: false,
      response: fail(
        "mfa_required",
        t(
          "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.",
        ),
        403,
      ),
    };
  }
  return { ok: true, user };
}

export function operationKey(request: Request): string {
  const key = z.string().uuid().safeParse(request.headers.get("Idempotency-Key"));
  if (!key.success) {
    throw new ExtensionServiceError(
      "validation_failed",
      "Falta a identificação do pedido. Recarregue a página e tente novamente.",
      422,
    );
  }
  return key.data;
}

/**
 * Precondição da tela, nunca autoridade. A organização continua vindo do
 * resolvedor canônico; uma aba antiga não pode gravar usando um cookie que
 * outra aba mudou desde a última leitura.
 */
export function requireExtensionOrganization(request: Request, organizationId: string): void {
  const expected = z.string().uuid().safeParse(request.headers.get("X-Expected-Organization-Id"));
  if (!expected.success) {
    throw new ExtensionServiceError(
      "validation_failed",
      "Falta o contexto da organização. Recarregue a página e tente novamente.",
      400,
    );
  }
  if (expected.data.toLowerCase() !== organizationId.toLowerCase()) {
    throw new ExtensionServiceError(
      "extension_context_changed",
      "A organização ativa mudou em outra aba. Recarregue a página antes de continuar.",
    );
  }
}

export function extensionId(value: string): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success)
    throw new ExtensionServiceError("not_found", "Extensão não encontrada.", 404);
  return result.data;
}

/** O teto alcança os bytes lidos, inclusive quando o cabeçalho mente ou está ausente. */
export async function readExtensionBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ExtensionServiceError("validation_failed", "Envie um documento JSON.", 415);
  }
  if (
    request.headers.get("content-encoding") &&
    request.headers.get("content-encoding")?.toLowerCase() !== "identity"
  ) {
    throw new ExtensionServiceError("validation_failed", "Envie o documento sem compressão.", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await request.body?.cancel().catch(() => undefined);
    throw new ExtensionError("extension_payload_too_large");
  }
  if (!request.body)
    throw new ExtensionServiceError("validation_failed", "O documento está vazio.", 422);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ExtensionServiceError(
          "request_timeout",
          "O envio foi interrompido. Tente novamente.",
          408,
        ),
      );
      void reader.cancel().catch(() => undefined);
    }, 15_000);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new ExtensionError("extension_payload_too_large");
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function extensionFailure(error: unknown, locale: Idioma = "pt-BR"): Response {
  const requestId = randomUUID();
  const t = (text: string) => traduzir(text, locale);
  if (error instanceof ExtensionServiceError) {
    return fail(error.code, t(error.message), error.status, { requestId });
  }
  if (error instanceof ExtensionError) {
    const status =
      error.code === "extension_download_failed"
        ? 503
        : error.code === "extension_payload_too_large"
          ? 413
          : 422;
    return fail(error.code, t(error.message), status, { requestId });
  }
  if (error instanceof z.ZodError) {
    return fail("validation_failed", t("Confira os dados do pedido e tente novamente."), 422, {
      requestId,
    });
  }
  // Mensagem de banco/rede/documento pode conter dados brutos; não vai a log nem à UI.
  logger.error("[extensions] operação sem resultado confirmado", { requestId });
  return fail(
    "upstream_unavailable",
    t("Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido."),
    503,
    { requestId },
  );
}

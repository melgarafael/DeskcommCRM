"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { loadAuthUser } from "@/lib/auth/server";
import {
  CHAVE_CSS_PERSONALIZADO,
  invalidarCssPersonalizadoDaInstalacao,
  validarCssPersonalizado,
} from "@/lib/branding/css-personalizado";
import { gravarPelaTela } from "@/lib/instalacao/config";

export type UpdateCustomBrandingCssResult = { ok: true } | { ok: false; error: string };

export async function updateCustomBrandingCss(
  input: unknown,
): Promise<UpdateCustomBrandingCssResult> {
  // Permissão ANTES de olhar a entrada: quem não pode gravar recebe a recusa,
  // nunca as mensagens do validador (que descrevem o que ele aceita).
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) {
    return {
      ok: false,
      error:
        escrita.error === "mfa_required"
          ? "Confirme a verificação em duas etapas."
          : "Esta ação exige acesso completo à instalação.",
    };
  }
  const { user } = escrita.ctx;
  const usuarioAtual = await loadAuthUser();
  if (usuarioAtual?.support) {
    return { ok: false, error: "Saia do acompanhamento administrativo antes de mudar a marca." };
  }

  const parsed = z.string().max(16_384).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Informe CSS como texto de até 16 KB." };

  const entrada = parsed.data;
  const validacao = validarCssPersonalizado(entrada);
  if (validacao.erro) return { ok: false, error: validacao.erro };

  const resultado = await gravarPelaTela(CHAVE_CSS_PERSONALIZADO, entrada.trim(), {
    ehSegredo: false,
    ator: user.id,
  });
  if (!resultado.ok) {
    return { ok: false, error: "Não foi possível gravar o CSS no banco da instalação." };
  }

  invalidarCssPersonalizadoDaInstalacao();
  const hdrs = await headers();
  await audit({
    action: "platform_branding.updated",
    actorUserId: user.id,
    resourceType: "platform_branding",
    resourceId: null,
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
    actingAsPlatformAdmin: true,
    metadata: {
      fields_changed: ["custom_css"],
      css_bytes: new TextEncoder().encode(entrada.trim()).byteLength,
      css_rules: validacao.regras,
      css_declarations: validacao.declaracoes,
    },
  });

  return { ok: true };
}

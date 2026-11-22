"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { loadAuthUser } from "@/lib/auth/server";
import {
  CHAVE_CSS_PERSONALIZADO,
  CHAVE_CSS_PERSONALIZADO_ESCURO,
  invalidarCssPersonalizadoDaInstalacao,
  validarCssPersonalizado,
} from "@/lib/branding/css-personalizado";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { gravarPelaTela } from "@/lib/instalacao/config";

export type UpdateCustomBrandingCssResult = { ok: true } | { ok: false; error: string };

/**
 * O CSS personalizado tem DUAS folhas (#4463): a do tema claro e a do escuro.
 *
 * As duas são validadas ANTES de qualquer escrita — se o escuro estiver
 * inválido, o claro também não é gravado. Gravar metade deixaria a marca pela
 * metade e a pessoa sem saber qual campo corrigir. A entrada é objeto, e não
 * string, justamente para que os dois campos não possam ser confundidos.
 */
const EntradaCss = z.object({
  claro: z.string().max(16_384),
  escuro: z.string().max(16_384),
});

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

  const parsed = EntradaCss.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Informe CSS como texto de até 16 KB." };

  const entrada = parsed.data;
  const claroSemEspacos = entrada.claro.trim();
  const escuroSemEspacos = entrada.escuro.trim();
  const validacaoClara = validarCssPersonalizado(claroSemEspacos, "claro");
  if (validacaoClara.erro) return { ok: false, error: validacaoClara.erro };
  const validacaoEscura = validarCssPersonalizado(escuroSemEspacos, "escuro");
  if (validacaoEscura.erro) return { ok: false, error: validacaoEscura.erro };

  const gravacaoClara = await gravarPelaTela(CHAVE_CSS_PERSONALIZADO, claroSemEspacos, {
    ehSegredo: false,
    ator: user.id,
  });
  if (!gravacaoClara.ok) {
    return { ok: false, error: "Não foi possível gravar o CSS no banco da instalação." };
  }
  const gravacaoEscura = await gravarPelaTela(CHAVE_CSS_PERSONALIZADO_ESCURO, escuroSemEspacos, {
    ehSegredo: false,
    ator: user.id,
  });
  // O claro já foi gravado: a invalidação também vale para esta saída, senão a
  // folha antiga ficaria 30 s no memo enquanto o escuro novo entrava.
  invalidarCssPersonalizadoDaInstalacao();
  if (!gravacaoEscura.ok) {
    return { ok: false, error: "Não foi possível gravar o CSS no banco da instalação." };
  }

  const hdrs = await headers();
  await audit({
    action: "platform_branding.updated",
    actorUserId: user.id,
    resourceType: "platform_branding",
    resourceId: null,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
    actingAsPlatformAdmin: true,
    metadata: {
      fields_changed: ["custom_css", "custom_css_dark"],
      css_bytes: new TextEncoder().encode(claroSemEspacos).byteLength,
      css_rules: validacaoClara.regras,
      css_declarations: validacaoClara.declaracoes,
      css_dark_bytes: new TextEncoder().encode(escuroSemEspacos).byteLength,
      css_dark_rules: validacaoEscura.regras,
      css_dark_declarations: validacaoEscura.declaracoes,
    },
  });

  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { guardarLoginCodex } from "@/lib/ai/credenciais/login-codex";
import { trocarCodigoPorTokens } from "@/lib/ai/pontos/pkce-da-assinatura";
import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";

/**
 * TROCAR O CÓDIGO COLADO POR TOKENS, e guardá-los cifrados.
 *
 * O `code` vem do navegador que parou em `http://localhost:1455/auth/callback`
 * (lista branca do Codex), colado em `/admin/sistema`; o `codeVerifier` é o
 * par que a própria tela gerou. Só platform admin passa daqui — o recurso vale
 * para a instalação inteira, mesmo argumento de `updateModuloDaInstalacao`.
 *
 * O `fetch` é o da plataforma, e este é o ÚNICO caminho que fala com
 * `auth.openai.com`: nenhum teste, nenhum worker e nenhum agente o chama. Nesta
 * instalação o endpoint não foi chamado uma vez sequer — não há credencial
 * nenhuma aqui.
 */
const entradaSchema = z.object({
  codigo: z.string().min(1).max(4096),
  codeVerifier: z.string().min(43).max(128),
});

export type ConectarLoginCodexResult = { ok: true } | { ok: false; error: string };

export async function conectarLoginCodex(
  input: z.infer<typeof entradaSchema>,
): Promise<ConectarLoginCodexResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  let tokens: Awaited<ReturnType<typeof trocarCodigoPorTokens>>;
  try {
    tokens = await trocarCodigoPorTokens({
      code: parsed.data.codigo,
      codeVerifier: parsed.data.codeVerifier,
    });
  } catch {
    // Sem detalhe na resposta: o corpo do provedor pode carregar material da
    // credencial, e a tela só precisa saber que a troca não deu.
    return { ok: false, error: "troca_recusada" };
  }

  const gravado = await guardarLoginCodex(tokens, user.id);
  if (!gravado.ok) return { ok: false, error: gravado.motivo };

  const hdrs = await headers();
  await audit({
    action: "ai.login_codex_conectado",
    actorUserId: user.id,
    resourceType: "platform_config",
    resourceId: null,
    metadata: { provedor: "openai-assinatura" },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/sistema");
  return { ok: true };
}

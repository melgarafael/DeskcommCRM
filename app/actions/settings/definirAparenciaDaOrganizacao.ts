"use server";

/**
 * GRAVAR A APARÊNCIA DA ORGANIZAÇÃO — template visual e ajustes da tela
 * Configurações › Aparência.
 *
 * É só estética: o que se grava é uma escolha de lista fechada (template, fonte,
 * arredondamento, densidade, intensidade dos efeitos) e uma cor em hex. Nada
 * daqui muda rota, permissão, dado ou comportamento.
 *
 * ⚠️ PELO CLIENT DA SESSÃO, E NÃO PELO ADMIN CLIENT. Quem decide é
 * `fn_definir_aparencia_da_organizacao` (migration 9388), que confere papel,
 * modo suporte e segundo fator pelo `auth.uid()` e grava com `jsonb_set` só a
 * chave `aparencia` — sem disputar `settings` com os outros escritores. A
 * conferência de papel daqui só evita chamar o banco à toa; a autoridade é a
 * função.
 *
 * O `organization_id` vem de `resolveActiveOrg`, nunca do argumento.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { DENSIDADES, EFEITOS, RAIOS, type Aparencia } from "@/lib/aparencia/ajustes";
import { TEMPLATES } from "@/lib/aparencia/catalogo";
import { CHAVES_DE_FONTE } from "@/lib/aparencia/fontes";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const IDS = TEMPLATES.map((t) => t.id) as [string, ...string[]];

const entradaSchema = z
  .object({
    template: z.enum(IDS).nullable(),
    fonte: z.enum(CHAVES_DE_FONTE).nullable(),
    raio: z.enum(RAIOS).nullable(),
    densidade: z.enum(DENSIDADES),
    efeitos: z.enum(EFEITOS),
    cor_secundaria: z
      .string()
      .trim()
      .refine(ehHexValido, { message: "cor_secundaria não é hex" })
      .transform(normalizarHex)
      .nullable(),
  })
  .strict();

const resultadoSchema = z.object({ mudou: z.boolean() }).passthrough();

/** Códigos, e não frases: a tela traduz. */
export type ErroDaAparencia =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "falha";

export type RespostaDaAparencia = { ok: true } | { ok: false; erro: ErroDaAparencia };

/**
 * O que vai para o banco: só o que difere do padrão do produto. Tudo no padrão
 * vira `null`, que a função entende como "apague a chave" — a organização volta
 * à aparência de fábrica sem deixar um objeto vazio para trás.
 */
function payloadDe(a: Aparencia): Record<string, string> | null {
  const p: Record<string, string> = {};
  if (a.template) p.template = a.template;
  if (a.fonte) p.fonte = a.fonte;
  if (a.raio) p.raio = a.raio;
  if (a.densidade !== "confortavel") p.densidade = a.densidade;
  if (a.efeitos !== "completo") p.efeitos = a.efeitos;
  if (a.cor_secundaria) p.cor_secundaria = a.cor_secundaria;
  return Object.keys(p).length > 0 ? p : null;
}

export async function definirAparenciaDaOrganizacao(entrada: Aparencia): Promise<RespostaDaAparencia> {
  const parsed = entradaSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, erro: "invalido" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, erro: "sem_permissao" };

  const aparencia = payloadDe(parsed.data);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_definir_aparencia_da_organizacao", {
    p_org: org.orgId,
    p_aparencia: aparencia,
  });

  if (error) {
    if (error.code === "42501") {
      return { ok: false, erro: error.message.includes("mfa_required") ? "mfa" : "sem_permissao" };
    }
    if (error.code === "22023") return { ok: false, erro: "invalido" };
    logger.error("[aparencia] a RPC falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    logger.error("[aparencia] a RPC devolveu um corpo inesperado", { organization_id: org.orgId });
    return { ok: false, erro: "falha" };
  }

  if (resultado.data.mudou) {
    await audit({
      action: "org.aparencia_updated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "organization",
      resourceId: org.orgId,
      metadata: { aparencia },
    });
  }

  revalidatePath("/app", "layout");
  return { ok: true };
}

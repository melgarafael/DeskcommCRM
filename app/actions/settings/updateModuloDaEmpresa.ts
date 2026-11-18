"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import {
  ESTADOS_DO_MODULO_NA_EMPRESA,
  MODULOS_POR_EMPRESA,
  empresaExiste,
} from "@/lib/instalacao/modulos-por-empresa";
import { MODULOS_AINDA_NAO_LIGAVEIS, modulosLigados } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `herda` NÃO tem linha: gravar `herda` = apagar a linha, e a empresa volta a
 * seguir a instalação. É o que mantém a tabela pequena (só a exceção) e o que faz
 * "voltar ao padrão" ser uma operação de uma linha, não um estado a mais para
 * toda leitura considerar.
 */
export type UpdateModuloDaEmpresaResult = { ok: true } | { ok: false; error: string };

const entradaSchema = z.object({
  // `uuid()` e não `string()`: identificador de organização chega da tela, mas
  // quem chama uma Server Action é o navegador. UUID malformado = recusa nomeada,
  // nunca 500 da FK nem consulta com string arbitrária.
  organizationId: z.string().uuid(),
  modulo: z.enum(MODULOS_POR_EMPRESA),
  estado: z.enum(ESTADOS_DO_MODULO_NA_EMPRESA),
});

/**
 * Liga, desliga ou devolve ao padrão UM módulo opcional de UMA empresa (#3868).
 *
 * ─── Quem pode ──────────────────────────────────────────────────────────────
 *
 * `is_platform_admin` (`escritaDeAdminOuRecusa`), e NÃO o admin de uma empresa: o
 * bloco "Por empresa" mora em `/admin/sistema`, que é a tela de quem responde
 * pelo servidor. Um admin de organização que chame esta ação por fora da tela é
 * recusado pelo gate — é a prova de que ninguém liga módulo para terceiro.
 *
 * ─── O que é recusado, e por quê ────────────────────────────────────────────
 *
 *  - `organizacao_inexistente`: a FK recusaria a linha, mas o erro do Postgres
 *    viraria 500 na tela. Recusa nomeada, e nada é gravado.
 *  - `modulo_desligado_na_instalacao`: a instalação é TETO — ligar para a empresa
 *    um módulo que o servidor não tem deixaria a linha `ligado` mentindo (a
 *    leitura devolveria desligado de qualquer forma). Recusar é mais honesto que
 *    gravar um estado que não vale.
 *  - `modulo_so_da_instalacao`: `cobranca` e `login_codex` não entram por empresa
 *    (ver `MODULOS_POR_EMPRESA`); o Zod já os barra como `invalid_input`, e a
 *    mensagem nomeada existe para quando a lista mudar.
 *  - `modulo_ainda_nao_disponivel`: módulo que o produto ainda não liga.
 *
 * ─── Desligar NÃO apaga nada ────────────────────────────────────────────────
 *
 * A escrita só toca `organization_modules`: um `delete` da PRÓPRIA linha (quando
 * `herda`) ou um `upsert` dela. Nenhuma tabela do módulo é tocada — o que existe
 * continua existindo e volta a aparecer ao religar. É o lado oposto de "desligar
 * apaga".
 *
 * Auditado porque "desde quando esta empresa tem cobrança/banco externo?" não
 * tem resposta em nenhuma outra tabela: a linha guarda o estado, não o histórico.
 */
export async function updateModuloDaEmpresa(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdateModuloDaEmpresaResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const { organizationId, modulo, estado } = parsed.data;

  if (estado === "ligado" && MODULOS_AINDA_NAO_LIGAVEIS.includes(modulo)) {
    return { ok: false, error: "modulo_ainda_nao_disponivel" };
  }

  const db = createAdminClient();

  if (!(await empresaExiste(db, organizationId))) {
    return { ok: false, error: "organizacao_inexistente" };
  }

  // Estado de ANTES, para a trilha: `null` = não havia linha (herdava).
  const { data: anterior, error: erroDaLeitura } = await db
    .from("organization_modules")
    .select("estado")
    .eq("organization_id", organizationId)
    .eq("modulo", modulo)
    .maybeSingle();
  if (erroDaLeitura) {
    logger.error("módulo da empresa: não deu para ler o estado anterior", {
      organization_id: organizationId,
      modulo,
      codigo: erroDaLeitura.code,
      detalhe: erroDaLeitura.message,
    });
    return { ok: false, error: "write_failed" };
  }

  if (estado === "ligado") {
    const naInstalacao = await modulosLigados(db);
    if (!naInstalacao.includes(modulo)) {
      return { ok: false, error: "modulo_desligado_na_instalacao" };
    }
  }

  if (estado === "herda") {
    // A linha da empresa É a exceção; sem ela, herda. Apagar só a própria linha.
    const { error } = await db
      .from("organization_modules")
      .delete()
      .eq("organization_id", organizationId)
      .eq("modulo", modulo);
    if (error) {
      logger.error("módulo da empresa: não deu para devolver ao padrão", {
        organization_id: organizationId,
        modulo,
        codigo: error.code,
        detalhe: error.message,
      });
      return { ok: false, error: "write_failed" };
    }
  } else {
    const { error } = await db.from("organization_modules").upsert(
      {
        organization_id: organizationId,
        modulo,
        estado,
        updated_by: user.id,
      },
      { onConflict: "organization_id,modulo" },
    );
    if (error) {
      logger.error("módulo da empresa: não deu para gravar", {
        organization_id: organizationId,
        modulo,
        estado,
        codigo: error.code,
        detalhe: error.message,
      });
      return { ok: false, error: "write_failed" };
    }
  }

  const hdrs = await headers();
  await audit({
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId,
    resourceType: "organization_modules",
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
    action: "organization.modulo_updated",
    metadata: {
      modulo,
      de: (anterior as { estado?: string } | null)?.estado ?? "herda",
      para: estado,
    },
  });

  revalidatePath("/admin/sistema");
  // O menu de `/app` é o consumidor mais visível da decisão por empresa (#3868):
  // sem esta linha, a empresa continuaria com a porta na navegação até o próximo
  // carregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}

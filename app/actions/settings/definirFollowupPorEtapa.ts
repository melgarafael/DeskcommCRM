"use server";

/**
 * GRAVAR O FOLLOW-UP POR ETAPA (#3603, fatia 3) — o segundo cartão da tela
 * Configurações → Entrada e follow-up.
 *
 * O contrato da chave está em `lib/schemas/settings.ts`
 * (`followupPorEtapaDeclarado`); a tela lê por lá e escreve por aqui. O que a
 * action faz é estreito de propósito: uma gravação de jsonb, com as conferências
 * que SÓ o banco pode fazer (a etapa existe? é desta organização? está aberta?).
 *
 * ⚠️ NÃO É UMA SEGUNDA ESCRITA DA FATIA 1. O primeiro cartão da tela chama
 * `definirEntradaAutomaticaNoFunil`, que já existe desde a fatia 1 — a tela
 * importa aquela action. Esta aqui grava OUTRA chave
 * (`settings.followup_por_etapa`); duas cópias da mesma gravação divergiriam no
 * primeiro ajuste.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirEntradaAutomaticaNoFunil`, `definirAiDecideDaEmpresa` e
 * `definirVendaPeloCanal`: pelo client de sessão, o UPDATE de um admin de tenant
 * em `organizations` casa ZERO linhas e o PostgREST devolve sucesso — a tela
 * diria "salvo" e nada teria sido gravado. O id vem de `resolveActiveOrg`, nunca
 * de argumento.
 *
 * ⚠️ `settings` é jsonb COMPARTILHADO: ler, mesclar NO NÍVEL DA CHAVE e gravar.
 * Um `update({ settings: { followup_por_etapa } })` ingênuo apagaria `branding`,
 * `crm`, `entrada_automatica_no_funil` e o resto em silêncio.
 *
 * ⚠️ A MESCLA É POR ETAPA, e não "substitui o mapa". A tela manda as etapas que
 * ela renderizou; uma etapa que ficou fora do payload (funil novo, aba aberta há
 * meia hora) não pode perder a regra porque outra pessoa salvou a tela. Mesma
 * razão pela qual DESLIGAR não apaga o prazo nem o texto: religar não deve
 * obrigar a escrever tudo de novo (decisão idêntica à da etapa escolhida em
 * `definirEntradaAutomaticaNoFunil`).
 *
 * ⚠️ ETAPA SEM FORMA DE UUID NÃO É ETAPA. `z.uuid()` diz que o valor tem cara de
 * identificador, não que ele exista nesta organização — e a chave é jsonb, sem
 * FK. Sem a conferência contra `crm_stages`, uma etapa de OUTRO tenant entraria
 * calada e a tela mostraria uma linha que ninguém vê no funil: falha silenciosa
 * que só apareceria meses depois, no dia em que alguém procurasse a regra.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import {
  FOLLOWUP_POR_ETAPA_CHAVE,
  MENSAGEM_DE_FOLLOWUP_MAX,
  PRAZO_DE_FOLLOWUP_HORAS_MAX,
  PRAZO_DE_FOLLOWUP_HORAS_MIN,
  type FollowupPorEtapa,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** O caminho da tela que lê esta chave. Revalidado na gravação. */
const CAMINHO_DO_FOLLOWUP_POR_ETAPA = "/app/settings/entrada-e-followup";

const regraDaEtapaSchema = z.object({
  stage_id: z.uuid(),
  ativa: z.boolean(),
  prazo_horas: z
    .number()
    .int()
    .min(PRAZO_DE_FOLLOWUP_HORAS_MIN)
    .max(PRAZO_DE_FOLLOWUP_HORAS_MAX)
    .nullable(),
  mensagem: z.string().trim().max(MENSAGEM_DE_FOLLOWUP_MAX).nullable(),
});

const etapasSchema = z.object({
  /** Teto de 200 é folga larga: um funil de verdade tem dezenas de etapas. */
  etapas: z.array(regraDaEtapaSchema).max(200),
});

export type FollowupPorEtapaInput = z.infer<typeof etapasSchema>;

export type ResultadoDoFollowupPorEtapa =
  | { ok: true; gravadas: number }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "etapa_invalida"
        | "erro_ao_gravar";
    };

export async function definirFollowupPorEtapa(
  entrada: FollowupPorEtapaInput,
): Promise<ResultadoDoFollowupPorEtapa> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = etapasSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, error: "validation_failed" };

  // Ligar sem prazo ou sem texto é a configuração incompleta que a tela mostraria
  // como "ligada" sem ter o que executar. A recusa é a MESMA régua da etapa sem
  // funil na fatia 1: não prometer na tela o que não existe no dado.
  for (const regra of lido.data.etapas) {
    if (regra.ativa && (regra.prazo_horas === null || !regra.mensagem)) {
      return { ok: false, error: "validation_failed" };
    }
  }

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  // Manager+ é quem monta a régua de acompanhamento — a mesma linha da matriz da
  // spec 13 que cobre a entrada no funil e a distribuição de atendimento.
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();

  // As etapas, conferidas contra o banco DESTA organização. Uma consulta só: a
  // lista que a tela mandou é pequena e o `.in` fecha a porta de uma vez — um
  // `in` vazio devolveria TUDO, e é por isso que ele nem é tentado.
  const ids = Array.from(new Set(lido.data.etapas.map((regra) => regra.stage_id)));
  if (ids.length > 0) {
    const { data: etapas, error: erroDasEtapas } = await admin
      .from("crm_stages")
      .select("id")
      .eq("organization_id", org.orgId)
      .in("id", ids)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false);
    if (erroDasEtapas) {
      logger.warn("[followup-por-etapa] conferência das etapas falhou na gravação", {
        organization_id: org.orgId,
        error: erroDasEtapas.message,
      });
      return { ok: false, error: "erro_ao_gravar" };
    }
    const existentes = new Set(
      ((etapas ?? []) as Array<{ id?: string }>).map((etapa) => String(etapa.id)),
    );
    if (ids.some((id) => !existentes.has(id))) return { ok: false, error: "etapa_invalida" };
  }

  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  const settings = ((atual as { settings?: unknown } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  const anterior = settings[FOLLOWUP_POR_ETAPA_CHAVE];
  const mapa: FollowupPorEtapa =
    anterior && typeof anterior === "object" && !Array.isArray(anterior)
      ? { ...(anterior as FollowupPorEtapa) }
      : {};
  for (const regra of lido.data.etapas) {
    mapa[regra.stage_id] = {
      ativa: regra.ativa,
      prazo_horas: regra.prazo_horas,
      mensagem: regra.mensagem,
    };
  }
  const novo = { ...settings, [FOLLOWUP_POR_ETAPA_CHAVE]: mapa };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[followup-por-etapa] a gravação da preferência falhou", {
      organization_id: org.orgId,
      error: error.message.slice(0, 120),
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "settings.followup_por_etapa_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // A trilha diz QUANTAS e QUAIS etapas mudaram — o `mapa` inteiro cresceria
    // uma linha de auditoria por etapa de todo funil a cada salvamento.
    metadata: {
      etapas: lido.data.etapas.length,
      ligadas: lido.data.etapas.filter((regra) => regra.ativa).length,
      stage_ids: ids,
    },
  });

  // A tela lê a chave na renderização do servidor: sem invalidar, ela continuaria
  // mostrando o estado antigo até um recarregamento completo.
  revalidatePath(CAMINHO_DO_FOLLOWUP_POR_ETAPA);
  return { ok: true, gravadas: lido.data.etapas.length };
}

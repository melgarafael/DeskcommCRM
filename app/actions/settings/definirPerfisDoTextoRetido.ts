"use server";

/**
 * Quem pode revelar o texto de uma mensagem apagada pelo contato (#4500).
 *
 * A régua de ACESSO mora em `lib/messaging/texto-retido.ts`; aqui só a gravação,
 * no mesmo formato das outras chaves de `organizations.settings`.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirAiDecideDaEmpresa`: pelo client de sessão, o UPDATE de admin de tenant
 * em `organizations` casa ZERO linhas e devolve sucesso — a tela diria "salvo" e
 * a lista continuaria vazia. O id vem de `resolveActiveOrg`, nunca de argumento.
 *
 * `settings` é jsonb COMPARTILHADO (branding, llm, routing, conversions…): ler,
 * mesclar e gravar preserva o que não é nosso. Um `update({ settings: { texto_retido } })`
 * apagaria o resto da empresa em silêncio.
 *
 * A lista é INDEPENDENTE POR ORGANIZAÇÃO porque a linha é a da organização ativa
 * — não existe caminho aqui para gravar em outra. E o padrão é VAZIO: a tela
 * abre sem nenhum perfil marcado, então ninguém perde acesso por esta entrega.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  CHAVE_DO_TEXTO_RETIDO,
  PERFIS_AUTORIZAVEIS,
  blocoDoTextoRetido,
  perfisDoTextoRetido,
} from "@/lib/messaging/texto-retido";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDosPerfisDoTextoRetido =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
    };

export async function definirPerfisDoTextoRetido(
  perfis: unknown,
): Promise<ResultadoDosPerfisDoTextoRetido> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.array(z.enum(["viewer", "agent", "manager", "admin"])).safeParse(perfis);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  // Conceder acesso a conteúdo retido é decisão de ADMINISTRADOR — a mesma porta
  // da tela (`settings/tenant`), e não a de manager que monta automação.
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  // Ordem canônica e sem repetição: a tela manda o que foi marcado, e o gravado
  // não depende da ordem dos cliques. O `Set<string>` evita o atrito de tipos
  // entre o enum do zod (sem `ai_operator`) e `Role` — a interseção é o que vale.
  const marcados = new Set<string>(entrada.data);
  const escolhidos = PERFIS_AUTORIZAVEIS.filter((papel) => marcados.has(papel));

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const antes = perfisDoTextoRetido(settings);
  const novo = { ...settings, [CHAVE_DO_TEXTO_RETIDO]: blocoDoTextoRetido(escolhidos) };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  // A mudança da LISTA também é auditada: "quem autorizou que este conteúdo
  // pudesse ser revelado?" é a pergunta que a trilha tem de responder. Só os
  // papéis entram no metadata — nada de conteúdo.
  await audit({
    action: "settings.retained_text_profiles_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { de: antes, para: escolhidos },
  });

  revalidatePath("/app/settings/tenant");
  return { ok: true };
}

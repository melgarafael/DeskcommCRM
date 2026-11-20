/**
 * GET /api/v1/ai/cases — lista os casos humanos da org (spec 15 §7, Wave 5).
 * Read-only via PostgREST (`createAdminClient`) — a escrita de estado do caso
 * mora em POST /api/v1/ai/cases/[id]/reply (pg.Pool do engine, ver ADR ali).
 *
 * A consulta em si vive em `lib/escalacao/chamados.ts`: a capacidade "ver os
 * chamados em aberto" do agente lê exatamente a mesma lista, e a tela e o agente
 * discordarem sobre o que está aberto seria o pior tipo de divergência.
 *
 * O que a tela e o agente NÃO compartilham é o alcance: `conversations` tem RLS
 * por atendente, e esta lista devolve nome e telefone do contato. Por isso o
 * conjunto de conversas visíveis é resolvido ANTES, com o cliente de SESSÃO — é
 * a policy do banco que responde, não uma cópia da regra aqui —, e a divergência
 * vai declarada no argumento `visiveisPara` (o agente passa `"todas"`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { conversasVisiveisDosCasos, listarChamados, type ConversasVisiveis } from "@/lib/escalacao/chamados";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Sessão OU token (Spec 33, R1): o token precisa de config:read e papel admin.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "agent_cases",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "agent_cases", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    // A ordem importa: o recorte é resolvido pelo cliente de SESSÃO (RLS
    // aplicada) ANTES da leitura privilegiada. Manager e admin seguem vendo
    // tudo porque é `fn_can_view_conversation` que decide — eles são org-wide
    // por desenho, e não há regra de papel repetida aqui para desatualizar.
    // Token: admin é org-wide por desenho (o mesmo que a RLS devolveria), então
    // o recorte é "todas"; a organização continua filtrada em toda consulta.
    const visiveisPara: ConversasVisiveis =
      authz.via === "token"
        ? "todas"
        : await conversasVisiveisDosCasos(authz.supabase, org.orgId);
    const { chamados, abertos } = await listarChamados(createAdminClient(), org.orgId, {
      estado: parsed.data.status === "open" ? "abertos" : "fechados",
      visiveisPara,
      contatoSeparado: authz.via === "token",
    });
    return ok({ cases: chamados, open_count: abertos }, { requestId });
  } catch (erro) {
    /**
     * O `catch` era NU, e a fila de casos ficava sem causa em lugar nenhum.
     *
     * Medido em 2026-09-18 na prova em tela: a tela mostrou "Nenhum caso
     * aberto" por 60 s seguidos enquanto o banco tinha o caso em
     * `awaiting_human` — o 500 daqui vira `data === undefined` no React Query,
     * e o componente não distingue "não há casos" de "não deu para saber".
     * Quem estava diagnosticando tinha o banco correto, a tela vazia e NADA
     * escrito entre os dois: o log do servidor não dizia uma palavra, porque
     * este `catch` descartava o erro antes de qualquer um vê-lo.
     *
     * A frase para quem lê a tela não muda (genérica de propósito: a causa é do
     * operador, não do atendente). O que muda é existir causa registrada — e é
     * a diferença entre "falhar fechado na ação, aberto na informação" e
     * simplesmente falhar.
     */
    logger.error("[ai/cases] falha ao listar os chamados", {
      requestId,
      organizationId: org.orgId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail("internal_error", t("Falha ao carregar os casos."), 500, { requestId });
  }
}

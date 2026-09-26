import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * As definições aprovadas do canal INTERMEDIADO — listar, sincronizar, criar.
 *
 * ─── Por que uma rota nova, e não a de sempre ──────────────────────────────
 *
 * `/api/v1/channels/templates` resolve a conexão por `metaSessionForOrg` e lê
 * `wabaId`. Numa instalação que só tem o canal intermediado, isso devolve lista
 * VAZIA — e o operador conclui que não tem nenhuma definição aprovada quando
 * tem várias. Foi exatamente o que aconteceu: o seletor do inbox dizia "nenhum
 * modelo aprovado ainda" para uma conta cheia deles.
 *
 * A rota de lá continua intacta. Fundir as duas exigiria mexer no caminho do
 * canal oficial, que funciona, para servir um canal que ele não conhece.
 *
 * ─── Tudo passa pelo seam ──────────────────────────────────────────────────
 *
 * Esta rota não sabe com QUEM fala: pede o adapter da sessão e chama
 * `adapter.templates`. Quem não implementa devolve 501, e nenhum nome de
 * provider aparece aqui — o `lint:channels` reprovaria.
 *
 * ─── O espelho carrega a conexão de origem (migration 0144) ───────────────
 *
 * `channel_session_id` é o que permite responder "o que posso usar NESTA
 * conexão?". Sem ele, dois números do mesmo provider dividiriam a mesma lista.
 *
 * ─── Quem pode ──────────────────────────────────────────────────────────────
 *
 * Ler (`agent`): é a lista que o seletor do inbox usa, e quem atende precisa
 * dela. Sincronizar e criar (`admin`): escreve na conta da empresa na
 * plataforma, como a gestão de modelos do canal oficial. Antes daqui a rota só
 * pedia login — qualquer membro, inclusive `viewer`, criava modelo, e o gate de
 * MFA (que mora em `requireRole`) não era consultado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { findPartnerSession } from "@/lib/channels/connect";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { acaoApagarSchema, acaoEditarSchema, executarGestao } from "@/lib/channels/gestao-de-modelos";

export const dynamic = "force-dynamic";

/**
 * O corpo do POST. `components` viaja cru até a plataforma — ela é quem valida
 * o formato e devolve o motivo; aqui só se garante a forma e o vocabulário
 * fechado da categoria.
 */
const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("sincronizar") }),
  z.object({
    acao: z.literal("criar"),
    name: z.string().trim().min(1).max(512),
    language: z.string().trim().min(2).max(15),
    category: z.enum(["AUTHENTICATION", "MARKETING", "UTILITY"]).default("UTILITY"),
    components: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
  }),
  // Editar e apagar pela tela (ver lib/channels/gestao-de-modelos.ts).
  acaoEditarSchema,
  acaoApagarSchema,
]);

interface Contexto {
  orgId: string;
  userId: string;
  sessionId: string;
  sessionRef: string;
  provider: ChannelProvider;
  idioma: Idioma;
}

/**
 * Resolve org + conexão + adapter, ou devolve a resposta de erro pronta.
 *
 * A conexão vem do banco e não do corpo: `organization_id` tirado do body é o
 * anti-pattern nº 10 da doutrina, e aqui daria a um tenant a lista do outro.
 */
async function contexto(
  requestId: string,
  papel: "agent" | "admin",
): Promise<{ ok: true; ctx: Contexto } | { ok: false; res: Response }> {
  // O papel ANTES da conexão: o 404 de "sem conexão" diria a quem não pode
  // nada se a organização tem ou não o canal.
  const authz = await requireRole(papel, { requestId, resource: "channel_templates" });
  if (!authz.ok) return { ok: false, res: authz.response };
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const admin = createAdminClient();
  const sessao = await findPartnerSession(admin, org.orgId);
  if (!sessao || sessao.archivedAt) {
    return {
      ok: false,
      res: fail("not_found", t("Nenhuma conexão de parceiro ativa."), 404, { requestId }),
    };
  }

  const { data: linha } = await admin
    .from("channel_sessions")
    // As COLUNAS do ref vêm do seam. Escrevê-las à mão aqui nomeia os providers
    // — e o `lint:channels` reprovou a primeira versão deste arquivo por isso,
    // que é a catraca funcionando.
    .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("organization_id", org.orgId)
    .eq("id", sessao.id)
    .maybeSingle();

  const provider = ((linha?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider;
  const sessionRef = linha ? resolveSessionRef(linha as unknown as ChannelSessionRef) : null;
  if (!sessionRef) {
    return {
      ok: false,
      res: fail("failed_precondition", t("Conexão sem identificador utilizável."), 409, { requestId }),
    };
  }

  return {
    ok: true,
    ctx: { orgId: org.orgId, userId: user.id, sessionId: sessao.id, sessionRef, provider, idioma: user.idioma },
  };
}

/** Lista o que está ESPELHADO. Rápido, e é o que a tela mostra. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const r = await contexto(requestId, "agent");
  if (!r.ok) return r.res;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_templates")
    .select("name, language, status, category, rejected_reason, components, synced_at")
    .eq("organization_id", r.ctx.orgId)
    .eq("channel_session_id", r.ctx.sessionId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    {
      templates: (data ?? []).map((t) => ({
        name: t.name as string,
        language: t.language as string,
        status: t.status as string,
        category: (t.category as string | null) ?? null,
        rejectedReason: (t.rejected_reason as string | null) ?? null,
        syncedAt: t.synced_at as string,
        // O CONTEÚDO, e não só o estado. Ver "APPROVED" sem ver o texto obriga
        // o operador a abrir a plataforma para saber o que a definição diz —
        // e é o texto que ele precisa para escolher qual mandar.
        components: (t.components as unknown[]) ?? [],
      })),
    },
    { requestId },
  );
}

/**
 * Sincroniza com a plataforma, ou CRIA uma definição nova.
 *
 * Duas ações na mesma rota porque as duas terminam no mesmo lugar — o espelho —
 * e separá-las obrigaria a tela a saber que criar também sincroniza.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await contexto(requestId, "admin");
  if (!r.ok) return r.res;
  const t = (texto: string) => traduzir(texto, r.ctx.idioma);

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Faltam nome, idioma ou conteúdo."), 422, { requestId });
  }
  const corpo = parsed.data;

  const adapter = getAdapter(r.ctx.provider);
  if (!adapter.templates) {
    return fail("not_implemented", t("Este canal não gerencia definições."), 501, { requestId });
  }

  try {
    if (corpo.acao === "editar" || corpo.acao === "apagar") {
      const gestao = await executarGestao(
        adapter.templates,
        createAdminClient(),
        { orgId: r.ctx.orgId, sessionId: r.ctx.sessionId, sessionRef: r.ctx.sessionRef },
        corpo,
      );
      if (!gestao.ok) {
        // Apagar um modelo em uso faria o passo do follow-up pular e o agente
        // errar o envio, em silêncio. A tela mostra ONDE e pede a confirmação.
        return fail("template_in_use", t("Este modelo está em uso. Confirme para apagar assim mesmo."), 409, {
          requestId,
          details: {
            usos: gestao.usos.map((u) => `${u.tipo === "fluxo" ? t("Follow-up") : t("Agente")} «${u.nome}»`),
          },
        });
      }
      await audit({
        action: gestao.acao === "editar" ? "template.updated" : "template.deleted",
        actorUserId: r.ctx.userId,
        organizationId: r.ctx.orgId,
        resourceType: "channel_session",
        resourceId: r.ctx.sessionId,
        requestId,
        metadata: { name: corpo.name, language: corpo.language },
      });
    }

    if (corpo.acao === "criar") {
      // A plataforma valida o formato do nome e devolve o motivo com código. Não
      // duplicamos a regra: regra copiada envelhece separado da fonte.
      await adapter.templates.create({
        organizationId: r.ctx.orgId,
        sessionRef: r.ctx.sessionRef,
        draft: {
          name: corpo.name,
          language: corpo.language,
          category: corpo.category,
          components: corpo.components,
        },
      });
      await audit({
        action: "template.created",
        actorUserId: r.ctx.userId,
        organizationId: r.ctx.orgId,
        resourceType: "channel_session",
        resourceId: r.ctx.sessionId,
        requestId,
        metadata: { name: corpo.name, language: corpo.language },
      });
    }

    // Sincroniza sempre — inclusive depois de criar: a definição nasce em
    // revisão, e o operador precisa VER que ela existe e está pendente. Sem
    // isso ele criaria a mesma de novo, achando que não salvou.
    const remotas = await adapter.templates.list({
      organizationId: r.ctx.orgId,
      sessionRef: r.ctx.sessionRef,
    });
    const admin = createAdminClient();
    const agora = new Date().toISOString();

    let gravadas = 0;
    for (const t of remotas) {
      const { error } = await admin.from("meta_templates").upsert(
        {
          organization_id: r.ctx.orgId,
          channel_session_id: r.ctx.sessionId,
          // A chave de unicidade herdada é `(org, waba_id, name, language)`. A
          // conta do provider ocupa o lugar do waba porque é o que ela é: o id
          // da conta na plataforma. O nome da coluna é da época em que só havia
          // um canal; trocá-lo mexeria no caminho do outro, que funciona.
          waba_id: r.ctx.sessionRef,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          rejected_reason: t.rejectedReason ?? null,
          components: t.components,
          contract_hash: "",
          parameter_format: t.parameterFormat ?? "POSITIONAL",
          synced_at: agora,
          updated_at: agora,
        },
        { onConflict: "organization_id,waba_id,name,language" },
      );
      if (error) {
        logger.warn("[partner/templates] upsert falhou", { name: t.name, detail: error.message });
        continue;
      }
      gravadas++;
    }

    return ok({ sincronizadas: gravadas, total: remotas.length }, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    logger.error("[partner/templates] falhou", { detail: msg, requestId });
    // A mensagem do provider CHEGA ao operador: é ela que distingue "nome
    // inválido" de "conta sem permissão", e sem ela a tela diz só "falhou".
    return fail("upstream_error", msg, 502, { requestId });
  }
}

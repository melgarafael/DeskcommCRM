// app/api/v1/conversations/[id]/export/route.ts
//
// GET /api/v1/conversations/[id]/export?formato=pdf — o histórico de UMA
// conversa como PDF, para o atendente/supervisor baixar (issue #1982, F1).
//
// O operador não tem para onde ir: só existe o export LGPD, e aquele é devido
// ao TITULAR (ele pede, a lista engloba outras tabelas e sai por e-mail). Um
// histórico de UMA conversa, datado e em ordem, é prova citável que o operador
// precisa guardar no caso — art. 18, II e V, do LGPD (meios para acessar e
// confirmar a existência do tratamento) não fazem distinção entre quem pede.
//
// ─── Acesso ─────────────────────────────────────────────────────────────────
// Gate ANTES de qualquer leitura: `requireRole("agent")`, o mesmo das outras
// rotas de `conversations/[id]` (claim, transfer, notes). `viewer` segue lendo
// a conversa na Inbox — baixar é outra coisa: um arquivo é o histórico inteiro
// num download portátil, e papel que só olha não leva o arquivo. Além do papel:
// o client da SESSÃO na leitura (RLS + `fn_can_view_conversation` decidem se a
// linha é desta org/deste atendente) e `organization_id` filtrado em cada
// consulta. Conversa invisível vira 404 — não se revela existência alheia.
//
// ─── O PDF ──────────────────────────────────────────────────────────────────
// `lib/conversas/exporta-pdf.ts` monta o documento reaproveitando o padrão de
// `lib/propostas/pdf-da-proposta.ts` (mesma biblioteca, mesmo contrato
// `{ ok, motivo }`, marca da org). O export LGPD não é tocado por este PR.
//
// LGPD: nada do corpo da mensagem vira log aqui — só ids e contagem no audit.
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DA_MENSAGEM,
  LIMITE_DE_MENSAGENS,
  montarPdfDaConversa,
  type ConversaParaPdf,
  type MensagemParaPdf,
} from "@/lib/conversas/exporta-pdf";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

// O render é a parte cara: CPU e memória do mesmo processo que serve o CRM
// inteiro. O teto por pessoa barra o clique repetido; o da organização, vários
// atendentes exportando ao mesmo tempo. Mesmo padrão de `ai/knowledge/busca`.
const TETO_POR_USUARIO = 5;
const TETO_POR_ORGANIZACAO = 20;
const JANELA_SEGUNDOS = 60;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();

  // Escopo primeiro: papel, org e idioma vêm do JWT, não do caminho.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  // 422 em formato desconhecido em vez de devolver PDF para quem pediu CSV:
  // silenciar o pedido errado aqui é como o operador descobre que a URL mudou.
  const formato = new URL(req.url).searchParams.get("formato") ?? "pdf";
  if (formato !== "pdf") {
    return fail("validation_failed", t("Formato não suportado: use ?formato=pdf."), 422, { requestId });
  }

  const porUsuario = await checkRateLimit(`conversa-export:${authz.user.id}`, TETO_POR_USUARIO, JANELA_SEGUNDOS);
  const porOrganizacao = await checkRateLimit(
    `conversa-export-org:${authz.org.orgId}`,
    TETO_POR_ORGANIZACAO,
    JANELA_SEGUNDOS,
  );
  if (!porUsuario.allowed || !porOrganizacao.allowed) {
    const barrou = porUsuario.allowed ? porOrganizacao : porUsuario;
    return fail("rate_limited", t("Muitas exportações seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(barrou.limit),
        "X-RateLimit-Remaining": String(Math.max(0, barrou.limit - barrou.count)),
      },
    });
  }

  const supabase = await createClient();

  const { data: conversa, error: erroDaConversa } = await supabase
    .from("conversations")
    .select("id, contact_id, channel, status, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroDaConversa) {
    return fail("internal_error", t("Erro ao ler a conversa."), 500, { requestId });
  }
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // DESC + limite: o corte fica no FIM do histórico (as recentes entram), e a
  // ordem da página é refeita por `linhasDoHistorico` — a garantia de ordem
  // cronológica mora na função, não na ordem de leitura.
  const [contato, mensagensLidas] = await Promise.all([
    conversa.contact_id
      ? supabase
          .from("contacts")
          .select("name, display_name, phone_number")
          .eq("organization_id", authz.org.orgId)
          .eq("id", conversa.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("messages")
      .select(COLUNAS_DA_MENSAGEM)
      .eq("organization_id", authz.org.orgId)
      .eq("conversation_id", id)
      .order("created_at", { ascending: false })
      // Uma a mais que o limite: é ela que diz se a conversa passou do teto.
      .limit(LIMITE_DE_MENSAGENS + 1),
  ]);
  if (contato.error) {
    return fail("internal_error", t("Erro ao ler o contato."), 500, { requestId });
  }
  if (mensagensLidas.error) {
    return fail("internal_error", t("Erro ao ler as mensagens."), 500, { requestId });
  }

  const lidas = (mensagensLidas.data ?? []) as unknown as MensagemParaPdf[];
  const truncada = lidas.length > LIMITE_DE_MENSAGENS;
  const mensagens = truncada ? lidas.slice(0, LIMITE_DE_MENSAGENS) : lidas;

  // Uma leitura por user id DISTINTO (o helper deduplica) — nome de quem
  // enviou não fica na linha da mensagem, e "Atendente" no PDF de prova é a
  // metade da prova. Se o lookup cair, o rótulo cai junto, sem falhar o export.
  const nomesDosUsuarios = await nomesDosAtendentes(mensagens.map((m) => m.sent_by_user_id));

  const conversaParaPdf: ConversaParaPdf = {
    id,
    channel: (conversa.channel as string | null) ?? null,
    status: (conversa.status as string | null) ?? null,
    created_at: (conversa.created_at as string | null) ?? null,
    contato: (contato.data as ConversaParaPdf["contato"]) ?? null,
  };

  const pdf = await montarPdfDaConversa(supabase, authz.org.orgId, conversaParaPdf, mensagens, {
    t,
    idioma: authz.user.idioma,
    exportadoPor: authz.user.full_name ?? authz.user.email ?? null,
    nomesDosUsuarios,
    truncada,
  });
  if (!pdf.ok) return fail("internal_error", pdf.motivo, 500, { requestId });

  // Audit sem PII: a conversa foi exportada, por quem, quantas linhas.
  void audit({
    action: "conversation.exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: { mensagens: mensagens.length, formato: "pdf" },
  });

  return new Response(new Uint8Array(pdf.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdf.nomeDoArquivo}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}

/**
 * GET /api/v1/reports/vendas/export — o RELATÓRIO DE VENDAS do Desempenho de
 * volta para quem opera (issue #4802, item 5 de 5).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * O produto já devolvia contatos (`/api/v1/contacts/export`), conversas
 * (`/conversations/[id]/export`) e auditoria (`/api/v1/audit/export`). O
 * resultado de vendas — a tabela "Performance por atendente" da tela de
 * Desempenho — só existia na tela: para levar o número para a gestão ou abrir
 * numa planilha, o caminho era print ou digitação. É o que a issue nomeia.
 *
 * ─── Mesmo número, não um recálculo ─────────────────────────────────────────
 *
 * A leitura é `lerRelatorioDeVendas` (`lib/relatorios/vendas.ts`), a MESMA
 * função que a rota da tela (`/api/v1/metrics/attendants`) chama: mesma RPC
 * `fn_attendant_metrics`, mesma janela padrão de 30 dias, mesmo `p_owner`. Não
 * há `reduce`, `count` nem segunda consulta aqui — o arquivo é uma RENDERIZAÇÃO
 * do que a tela recebe. A prova é o teste que compara, linha a linha, o CSV com
 * a resposta JSON da rota da tela.
 *
 * ─── Escopo e permissão: os das outras exportações ──────────────────────────
 *
 * `requireRole("manager")`, o mesmo piso de `contacts/export` e `audit/export`:
 * levar resultado de vendas da equipe inteira embora é gestão, não rotina de
 * atendimento. A organização vem do COOKIE validado (`authz.org.orgId`), nunca
 * da query; o client é o de SESSÃO, então a RLS de `crm_leads`/`conversations`
 * continua recortando o que cada pessoa pode ver — a rota não amplia escopo,
 * só devolve em arquivo o que a tela já mostraria.
 *
 * ─── O filtro da tela vai junto ─────────────────────────────────────────────
 *
 * `?owner_user_id=` é o "Atendente" do topo da tela: o arquivo sai com o
 * recorte VISÍVEL, não com o mundo inteiro — e o teste prova que, filtrando um
 * atendente, o arquivo tem só a linha dele (e que o `p_owner` chega à RPC).
 *
 * ─── Formato ────────────────────────────────────────────────────────────────
 *
 * O das exportações existentes, medido antes de escrever: `text/csv;
 * charset=utf-8`, `Content-Disposition: attachment` com nome datado, BOM,
 * `;` de separador (Excel pt-BR), CRLF, decimal com vírgula. O porquê de cada
 * um está em `lib/relatorios/vendas-csv.ts`.
 *
 * Só LEITURA no banco. O audit registra que o arquivo saiu, com QUANTOS
 * atendentes e QUAL recorte — nunca conteúdo de venda.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { DIAS_DA_JANELA, janelaDoRelatorio, lerRelatorioDeVendas } from "@/lib/relatorios/vendas";
import {
  csvDoRelatorioDeVendas,
  nomeDoArquivoDoRelatorio,
  type LinhaDoRelatorio,
} from "@/lib/relatorios/vendas-csv";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

export const dynamic = "force-dynamic";

/**
 * Os MESMOS parâmetros da rota da tela, com o mesmo validador: data fora do
 * ISO é 422 aqui e lá; atendente que não é uuid também. Um export que aceitasse
 * o que a tela recusa poderia produzir um recorte que a tela nunca mostrou.
 */
const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  owner_user_id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", {
    requestId,
    resource: "reports",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    owner_user_id: url.searchParams.get("owner_user_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const janela = janelaDoRelatorio(parsed.data);
  if (!janela) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const lido = await lerRelatorioDeVendas(supabase, {
    orgId: authz.org.orgId,
    janela,
    owner_user_id: parsed.data.owner_user_id,
  });
  if (!lido.ok) return fail("internal_error", lido.message, 500, { requestId });

  // O nome de quem atende, pela MESMA régua de rótulo da tela (`rotuloDoMembro`:
  // nome → e-mail → "Atendente <sufixo>", nunca o uuid cru). A leitura é UMA
  // consulta para todos os ids (`fn_nomes_dos_membros`); o e-mail fica de fora
  // porque a tabela da tela só o usa como fallback de nome — o arquivo já tem o
  // rótulo resolvido, e expor e-mail de colegas num CSV que circula é dado a
  // mais de graça.
  const nomes = await nomesDosAtendentes(
    authz.org.orgId,
    lido.relatorio.attendants.map((a) => a.user_id),
  );

  const linhas: LinhaDoRelatorio[] = lido.relatorio.attendants.map((a) => {
    // O mapa pode não ter este id (a RPC pode devolver um atendente que já saiu
    // da organização): `null`. Quem decide o que o arquivo escreve — o nome, o
    // fallback "Atendente <sufixo>" — é a régua do helper, não esta rota; aqui
    // só se entrega o dado que já veio da leitura.
    const nome = nomes.get(a.user_id) ?? null;
    return {
      atendente: rotuloDoMembro({ full_name: nome, email: null, user_id: a.user_id }, t),
      won: a.won,
      lost: a.lost,
      conversations_handled: a.conversations_handled,
      avg_first_response_seconds: a.avg_first_response_seconds,
      median_first_response_seconds: a.median_first_response_seconds,
    };
  });

  await audit({
    action: "reports.sales_exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "report",
    resourceId: null,
    requestId,
    metadata: {
      actor_type: "user",
      formato: "csv",
      // QUANTOS e QUAL recorte — nunca o conteúdo de venda.
      total: linhas.length,
      janela: {
        de: janela.from.toISOString(),
        ate: janela.to.toISOString(),
        dias: DIAS_DA_JANELA,
      },
      filtros: { atendente: parsed.data.owner_user_id ?? null },
      excluded_tag: lido.relatorio.excluded_tag,
    },
  });

  return comIdDaRequisicao(
    new Response(csvDoRelatorioDeVendas(linhas), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nomeDoArquivoDoRelatorio(janela)}"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    }),
    requestId,
  );
}

/**
 * GET /api/v1/admin/tenants/export — o inventário das instalações em CSV
 * (issue #2777).
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * A plataforma já exportava contato (LGPD art. 18, V; #2759) e auditoria
 * (`app/api/v1/audit/export`), mas não a própria lista de instalações: quem
 * opera não tinha como tirar o inventário das instalações que administra
 * (faturamento, atendimento, revenda, e o pedido do titular que pergunta
 * "quais instâncias minhas existem e desde quando").
 *
 * ─── Nenhuma porta nova ────────────────────────────────────────────────────
 *
 * Mesmo guard (`requirePlatformAdmin`), mesmo `querySchema`, mesmo leitor
 * (`_lista.ts`) da rota de listagem: exportar é exportar o que a tela mostra,
 * e duas respostas para a mesma pergunta seriam a divergência que ninguém veria.
 * O `cursor` e o `limit` da listagem não viajam — o arquivo é o CONJUNTO
 * filtrado inteiro, e o teto é o do export, não o da página.
 *
 * ─── O que este arquivo NÃO deixa sair ─────────────────────────────────────
 *
 * Um tenant `status=redacted`: o worker de LGPD só vira o `status` da
 * organização, então `display_name`, `legal_name` e `cnpj` seguem na tabela
 * como estavam antes. O corte acontece em `_csv.ts`, pela regra de
 * `lib/lgpd/cascata.ts`, antes de qualquer célula ser escrita — ver o
 * cabeçalho de lá, que é quem decide o que significa "redigido".
 *
 * ─── Corte e trilha ────────────────────────────────────────────────────────
 *
 * Teto de 10.000 linhas (o do export de auditoria) com `X-Export-Truncado:
 * true` quando corta — uma rota que drena a plataforma inteira numa resposta só
 * não é inventário, é exfiltração com atalho. `audit("platform.tenants_exported")`
 * grava quem, quando, QUANTO saiu, se cortou e QUE filtros valiam — nunca o
 * texto da busca, que é dado de quem foi buscado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import { fail } from "@/lib/api/wrappers";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { normalizarIdioma, parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { querySchema, listarTenants } from "../_lista";
import { csvDosTenants, nomeDoArquivo } from "./_csv";

export const dynamic = "force-dynamic";

/** A página máxima do `querySchema` — é o que a listagem já aceita de teto. */
const TAMANHO_DA_PAGINA = 100;
/** Mesmo teto do export de auditoria: cabe na memória do processo que serve o CRM. */
const TETO_DO_EXPORT = 10_000;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  // O idioma de quem exporta: preferência salva no perfil, e o `Accept-Language`
  // como sinal — a mesma cadeia de `idiomaDoVisitante`, sem o `next/headers`
  // (que só existe dentro do runtime de requisição do App Router).
  const preferido = adminCtx.user.user_metadata?.locale;
  const idioma = normalizarIdioma(
    typeof preferido === "string" ? preferido : parseAcceptLanguage(req.headers.get("accept-language")),
  );
  const t = (texto: string) => traduzir(texto, idioma);

  // 422 em formato desconhecido, como o export de contatos: silenciar o pedido
  // errado aqui é como quem integra descobre que a URL mudou.
  const formato = (req.nextUrl.searchParams.get("formato") ?? "csv").toLowerCase();
  if (formato !== "csv") {
    return fail("validation_failed", t("Formato não suportado: use ?formato=csv."), 422, {
      requestId,
    });
  }

  // Mesma validação da listagem: `q`, `status`, `cursor` e `limit` com os
  // MESMOS limites. `cursor`/`limit` são paginação, não filtro, e daqui em
  // diante não viajam — o arquivo é o conjunto filtrado inteiro.
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_error", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { q, status } = parsed.data;
  const admin = createAdminClient();

  const linhas: AdminTenantRow[] = [];
  let cursor: string | undefined;
  let truncado = false;

  for (;;) {
    const pagina = await listarTenants(admin, {
      q,
      status,
      cursor,
      limit: TAMANHO_DA_PAGINA,
    });
    if (pagina.error) {
      return fail("internal_error", "Query failed", 500, {
        requestId,
        details: pagina.error.message,
      });
    }
    if (pagina.page.length === 0) break;

    linhas.push(...pagina.page);
    if (linhas.length >= TETO_DO_EXPORT) {
      // `> TETO` porque a última página pode passar do teto (a lista tem 10.003
      // e a página devolve as 103 finais até o corte): aí o corte acontece e o
      // header tem de dizer.
      truncado = linhas.length > TETO_DO_EXPORT || pagina.has_more;
      break;
    }
    if (!pagina.has_more || !pagina.nextCursor) break;
    cursor = pagina.nextCursor;
  }

  const exportadas = linhas.slice(0, TETO_DO_EXPORT);
  const corpo = csvDosTenants(exportadas);

  void audit({
    action: "platform.tenants_exported",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      formato: "csv",
      total: exportadas.length,
      truncado,
      // O FILTRO, nunca o TEXTO do filtro — a mesma régua do export de contatos.
      filtros: { status: status ?? null, has_q: !!q },
    },
  });

  return new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivo()}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      ...(truncado ? { "X-Export-Truncado": "true" } : {}),
    },
  });
}

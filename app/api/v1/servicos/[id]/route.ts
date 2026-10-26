/**
 * GET   /api/v1/servicos/[id] — um serviço, com as variações e "a partir de".
 * PATCH /api/v1/servicos/[id] — edita; exige a revisão que quem edita viu.
 *
 * Issue #3372, fatia B. A revisão é o que impede duas pessoas (ou a tela e um
 * script) de salvarem em cima uma da outra: `expected_revision` velho = 409, o
 * mesmo desfecho das outras escritas concorrentes do repo.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DO_SERVICO,
  menorPreco,
  montarServicos,
  type LinhaDoCatalogo,
  type TipoDeServico,
  type UnidadeDeCobranca,
} from "@/lib/catalogo/servicos";
import {
  problemasDoServico,
  servicoPatchSchema,
  type EntradaDeServico,
} from "@/lib/schemas/servicos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface Contexto {
  params: Promise<{ id: string }>;
}

/** O principal e as variações dele, ou a variação e o principal dela. */
async function lerServico(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  id: string,
): Promise<{ linhas: LinhaDoCatalogo[]; encontrado: boolean }> {
  const { data: linha } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_SERVICO)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  const alvo = linha as unknown as LinhaDoCatalogo | null;
  // Produto de prateleira não é serviço: esta rota responde 404 para ele, e não
  // um objeto vazio que faria a tela achar que o cadastro está incompleto.
  if (!alvo || (!alvo.tipo_servico && !alvo.pai_id)) return { linhas: [], encontrado: false };

  const principalId = alvo.pai_id ?? alvo.id;
  const { data: familiares } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_SERVICO)
    .eq("organization_id", organizationId)
    .or(`id.eq.${principalId},pai_id.eq.${principalId}`);

  return { linhas: (familiares ?? []) as unknown as LinhaDoCatalogo[], encontrado: true };
}

export async function GET(_req: NextRequest, ctx: Contexto): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { linhas, encontrado } = await lerServico(supabase, authz.org.orgId, id);
  if (!encontrado) return fail("not_found", "Serviço não encontrado.", 404, { requestId });

  const montados = montarServicos(linhas);
  const servico =
    montados.find((s) => s.id === id) ?? montados.find((s) => s.variacoes.some((v) => v.id === id));
  if (!servico) return fail("not_found", "Serviço não encontrado.", 404, { requestId });

  return ok(servico, { requestId });
}

export async function PATCH(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = servicoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const patch = parsed.data;
  const supabase = await createClient();

  const { data: atualBruto } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_SERVICO)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  const atual = atualBruto as unknown as LinhaDoCatalogo | null;
  if (!atual || (!atual.tipo_servico && !atual.pai_id)) {
    return fail("not_found", "Serviço não encontrado.", 404, { requestId });
  }

  // A régua roda sobre a LINHA MESCLADA: `prazo` sem `tipo` no corpo pode ser
  // válido ou não, e quem sabe é a linha que já está gravada.
  const tipoFinal = (patch.tipo ?? atual.tipo_servico ?? null) as TipoDeServico | null;
  const unidadeFinal = (patch.unidade ??
    atual.unidade_cobranca ??
    null) as UnidadeDeCobranca | null;
  const mesclado: EntradaDeServico = {
    tipo: tipoFinal,
    unidade: unidadeFinal,
    preco_cents: patch.preco_cents ?? atual.preco_cents,
    prazo_dias_uteis:
      patch.prazo_dias_uteis === undefined ? atual.prazo_dias_uteis : patch.prazo_dias_uteis,
    sinal:
      patch.sinal === undefined
        ? atual.sinal_tipo === "percentual" && atual.sinal_percentual !== null
          ? { tipo: "percentual" as const, valor: Number(atual.sinal_percentual) }
          : atual.sinal_tipo === "fixo" && atual.sinal_cents !== null
            ? { tipo: "fixo" as const, valor: Number(atual.sinal_cents) }
            : null
        : patch.sinal,
    pai_id: atual.pai_id,
    controla_estoque: false,
    quantidade: 0,
  };

  // Menor preço do serviço = principal + variações, já com o preço novo deste
  // PATCH. É o piso do sinal fixo.
  const { data: familiares } = await supabase
    .from("catalog_products")
    .select("id, preco_cents")
    .eq("organization_id", authz.org.orgId)
    .or(`id.eq.${atual.pai_id ?? atual.id},pai_id.eq.${atual.pai_id ?? atual.id}`);
  const precoNovo = mesclado.preco_cents ?? atual.preco_cents;
  const precos = ((familiares ?? []) as Array<{ id: string; preco_cents: number }>).map((linha) =>
    linha.id === id ? precoNovo : linha.preco_cents,
  );
  const menor = menorPreco(precos.map((preco_cents) => ({ preco_cents })));

  const problemas = problemasDoServico(mesclado, { menorPrecoDoServico: menor });
  if (problemas.length > 0) {
    return fail("validation_failed", t("Este serviço não passou nas regras do cadastro."), 422, {
      requestId,
      details: Object.fromEntries(problemas.map((p) => [p.campo, [p.mensagem]])),
    });
  }

  const { data, error } = await supabase
    .from("catalog_products")
    .update({
      ...(patch.codigo !== undefined ? { codigo: patch.codigo } : {}),
      ...(patch.nome !== undefined ? { nome: patch.nome } : {}),
      ...(patch.descricao !== undefined ? { descricao: patch.descricao } : {}),
      ...(patch.preco_cents !== undefined ? { preco_cents: patch.preco_cents } : {}),
      ...(patch.tipo !== undefined ? { tipo_servico: atual.pai_id ? null : patch.tipo } : {}),
      ...(patch.unidade !== undefined
        ? { unidade_cobranca: atual.pai_id ? null : patch.unidade }
        : {}),
      ...(patch.prazo_dias_uteis !== undefined
        ? { prazo_dias_uteis: atual.pai_id ? null : patch.prazo_dias_uteis }
        : {}),
      ...(patch.sinal !== undefined
        ? {
            sinal_tipo: atual.pai_id ? null : (patch.sinal?.tipo ?? null),
            sinal_percentual:
              !atual.pai_id && patch.sinal?.tipo === "percentual" ? patch.sinal.valor : null,
            sinal_cents: !atual.pai_id && patch.sinal?.tipo === "fixo" ? patch.sinal.valor : null,
          }
        : {}),
      ...(patch.instrucoes_ia !== undefined
        ? { instrucoes_ia: atual.pai_id ? null : patch.instrucoes_ia }
        : {}),
      ...(patch.ia_oferece !== undefined ? { ia_oferece: patch.ia_oferece } : {}),
      ...(patch.ia_agenda !== undefined && !atual.pai_id ? { ia_agenda: patch.ia_agenda } : {}),
    })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    // A revisão vai no WHERE: se outra pessoa salvou entre a leitura e esta
    // escrita, nenhuma linha casa e a resposta é 409 — nunca "salvou por cima".
    .eq("revision", patch.expected_revision)
    .select(COLUNAS_DO_SERVICO)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um item com esse código."), 409, { requestId });
    }
    if (error.code === "23514" || error.code === "23503") {
      return fail("validation_failed", t("Este serviço não passou nas regras do cadastro."), 422, {
        requestId,
        details: { banco: [error.message] },
      });
    }
    return fail("internal_error", "Erro ao salvar o serviço.", 500, { requestId });
  }

  if (!data) {
    // Nenhuma linha casou: ou a revisão está velha, ou o serviço sumiu. A
    // releitura distingue os dois — responder 409 para um item apagado manda a
    // tela recarregar algo que não existe mais.
    const { data: agora } = await supabase
      .from("catalog_products")
      .select("revision")
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (!agora) return fail("not_found", "Serviço não encontrado.", 404, { requestId });
    return fail("conflict", t("Este serviço foi alterado por outra pessoa."), 409, {
      requestId,
      details: { revision_atual: (agora as { revision: number }).revision },
    });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: atual.pai_id ? "catalog_service.variation_updated" : "catalog_service.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  const { linhas } = await lerServico(supabase, authz.org.orgId, id);
  const montados = montarServicos(linhas);
  const servico =
    montados.find((s) => s.id === id) ?? montados.find((s) => s.variacoes.some((v) => v.id === id));

  return ok(servico ?? data, { requestId });
}

/**
 * GET   /api/v1/servicos/[id] — um serviço, com as variações e "a partir de".
 * PATCH /api/v1/servicos/[id] — edita; exige a revisão que quem edita viu.
 *
 * Módulo opcional `catalogo_servicos` (doc 212, ADR-0002): desligado, 404.
 *
 * A revisão é o que impede duas pessoas (ou a tela e um script) de salvarem em
 * cima uma da outra: `expected_revision` velho = 409. A conferência da revisão e
 * a do sinal acontecem dentro de `fn_catalogo_servicos_salvar`, com a família
 * travada — uma edição do sinal e outra do preço de uma variação passam em fila.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  linhaDoCatalogo,
  montarServicos,
  type TipoDeServico,
  type UnidadeDeCobranca,
} from "@/lib/catalogo/servicos";
import {
  MODULO_SERVICOS,
  UUID,
  camposDaRecusa,
  detalheDoItem,
  lerFamilias,
  salvarServico,
} from "@/lib/catalogo/servicos-supabase";
import { moduloLigado } from "@/lib/instalacao/modulos";
import {
  problemasDoServico,
  servicoPatchSchema,
  type EntradaDeServico,
} from "@/lib/schemas/servicos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface Contexto {
  params: Promise<{ id: string }>;
}

async function seModuloDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), MODULO_SERVICOS)) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}

/** O serviço montado que contém `id` — como principal ou como variação. */
async function servicoDoItem(
  supabase: Awaited<ReturnType<typeof createClient>>,
  org: string,
  id: string,
) {
  const detalhe = await detalheDoItem(supabase, org, id);
  if (!detalhe) return null;
  const montados = montarServicos(await lerFamilias(supabase, org, [detalhe.pai_product_id ?? id]));
  return montados[0] ?? null;
}

export async function GET(_req: NextRequest, ctx: Contexto): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("not_found", "Serviço não encontrado.", 404, { requestId });

  try {
    const servico = await servicoDoItem(await createClient(), authz.org.orgId, id);
    // Produto de prateleira não é serviço: 404, e não um objeto vazio que faria
    // a tela achar que o cadastro está incompleto.
    if (!servico) return fail("not_found", "Serviço não encontrado.", 404, { requestId });
    return ok(servico, { requestId });
  } catch {
    return fail("internal_error", "Erro ao ler o serviço.", 500, { requestId });
  }
}

export async function PATCH(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("not_found", "Serviço não encontrado.", 404, { requestId });

  const parsed = servicoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const patch = parsed.data;
  const org = authz.org.orgId;
  const supabase = await createClient();

  const detalhe = await detalheDoItem(supabase, org, id).catch(() => null);
  if (!detalhe) return fail("not_found", "Serviço não encontrado.", 404, { requestId });
  const ehVariacao = detalhe.pai_product_id !== null;
  const atual = linhaDoCatalogo(
    { id, codigo: "", nome: "", descricao: null, preco_cents: 0, moeda: "BRL", ativo: true },
    detalhe,
  );

  // A régua de FORMA roda sobre a linha mesclada: `prazo` sem `tipo` no corpo
  // pode ser válido ou não, e quem sabe é o que já está gravado. A regra do
  // sinal contra o preço da família é do banco, que lê a família travada.
  const mesclado: EntradaDeServico = {
    tipo: (patch.tipo ?? atual.tipo_servico ?? null) as TipoDeServico | null,
    unidade: (patch.unidade ?? atual.unidade_cobranca ?? null) as UnidadeDeCobranca | null,
    prazo_dias_uteis: patch.prazo_dias_uteis === undefined ? atual.prazo_dias_uteis : patch.prazo_dias_uteis,
    sinal:
      patch.sinal === undefined
        ? atual.sinal_tipo === "percentual" && atual.sinal_percentual !== null
          ? { tipo: "percentual" as const, valor: atual.sinal_percentual }
          : atual.sinal_tipo === "fixo" && atual.sinal_cents !== null
            ? { tipo: "fixo" as const, valor: atual.sinal_cents }
            : null
        : patch.sinal,
    pai_id: atual.pai_id,
    controla_estoque: false,
    quantidade: 0,
  };
  const problemas = problemasDoServico(mesclado);
  if (problemas.length > 0) {
    return fail("validation_failed", t("Este serviço não passou nas regras do cadastro."), 422, {
      requestId,
      details: Object.fromEntries(problemas.map((p) => [p.campo, [p.mensagem]])),
    });
  }

  const r = await salvarServico(createAdminClient(), org, id, {
    item: {
      ...(patch.codigo !== undefined ? { codigo: patch.codigo } : {}),
      ...(patch.nome !== undefined ? { nome: patch.nome } : {}),
      ...(patch.descricao !== undefined ? { descricao: patch.descricao } : {}),
      ...(patch.preco_cents !== undefined ? { preco_cents: patch.preco_cents } : {}),
    },
    // Na variação só `ia_oferece` é dela; o resto é do principal, e a régua
    // acima já recusou quem tentou mandar.
    detalhe: {
      ...(!ehVariacao && patch.tipo !== undefined ? { tipo: patch.tipo } : {}),
      ...(!ehVariacao && patch.unidade !== undefined ? { unidade: patch.unidade } : {}),
      ...(!ehVariacao && patch.prazo_dias_uteis !== undefined ? { prazo_dias_uteis: patch.prazo_dias_uteis } : {}),
      ...(!ehVariacao && patch.sinal !== undefined
        ? {
            sinal_tipo: patch.sinal?.tipo ?? null,
            sinal_percentual: patch.sinal?.tipo === "percentual" ? patch.sinal.valor : null,
            sinal_cents: patch.sinal?.tipo === "fixo" ? patch.sinal.valor : null,
          }
        : {}),
      ...(!ehVariacao && patch.instrucoes_ia !== undefined ? { instrucoes_ia: patch.instrucoes_ia } : {}),
      ...(patch.ia_oferece !== undefined ? { ia_oferece: patch.ia_oferece } : {}),
    },
    expectedRevision: patch.expected_revision,
  });

  if (!r.ok) {
    if (r.motivo === "nao_encontrado") return fail("not_found", "Serviço não encontrado.", 404, { requestId });
    if (r.motivo === "revisao_velha") {
      return fail("conflict", t("Este serviço foi alterado por outra pessoa."), 409, {
        requestId,
        details: { revision_atual: Number(r.detalhe) || null },
      });
    }
    if (r.motivo === "codigo_repetido") {
      return fail("conflict", t("Já existe um item com esse código."), 409, { requestId });
    }
    return fail("validation_failed", t("Este serviço não passou nas regras do cadastro."), 422, {
      requestId,
      details: camposDaRecusa(r.detalhe),
    });
  }

  await audit({
    organizationId: org,
    actorUserId: authz.user.id,
    action: ehVariacao ? "catalog_service.variation_updated" : "catalog_service.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  const servico = await servicoDoItem(supabase, org, id).catch(() => null);
  return ok(servico ?? { id, revision: r.revision }, { requestId });
}

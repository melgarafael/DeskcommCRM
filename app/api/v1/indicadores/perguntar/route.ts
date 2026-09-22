/**
 * POST /api/v1/indicadores/perguntar — o "Indicador IA": responde e desenha
 * um gráfico a partir da pergunta, sobre os agregados do mês (leitura: viewer+).
 *
 * Aterrado por construção: o modelo recebe SÓ os números já calculados por
 * `agregadosDoMes` (a mesma fonte do painel) e devolve no schema fechado
 * abaixo — ele escolhe o recorte e o tipo de gráfico, nunca os valores.
 * Sem IA configurada, 503 honesto em vez de resposta inventada.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { FUSO_PADRAO } from "@/lib/comercial/inteligencia";
import { agregadosDoMes } from "@/lib/comercial/contexto-indicadores";
import { DEFAULT_BOT_MODEL, gatewayHeaders, resolveLanguageModel } from "@/lib/ai/gateway";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ANO_MES = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

const perguntaSchema = z.object({
  pergunta: z.string().trim().min(2, "pergunte com ao menos 2 letras").max(500),
  ano_mes: z.string().regex(ANO_MES, "ano_mes usa YYYY-MM").optional(),
});

const graficoSchema = z.object({
  tipo: z.enum(["barras", "pizza", "linha"]),
  titulo: z.string().max(120),
  dados: z.array(z.object({ rotulo: z.string().max(60), valor_cents: z.number() })).max(20),
});

const respostaSchema = z.object({
  resposta: z.string().max(2000),
  grafico: graficoSchema.nullable(),
});

function deslocarMes(anoMes: string, delta: number): string {
  const [ano = 0, mes = 1] = anoMes.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const parsed = perguntaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const model = resolveLanguageModel(DEFAULT_BOT_MODEL);
  if (!model) {
    return fail("service_unavailable", "IA não configurada nesta instalação — fale com o administrador.", 503, {
      requestId,
    });
  }

  const supabase = await createClient();
  const agoraMs = new Date().getTime();
  const { data: org } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  let fuso: string = FUSO_PADRAO;
  try {
    const tz = (org as unknown as { timezone?: string | null } | null)?.timezone ?? null;
    if (tz) {
      new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
      fuso = tz;
    }
  } catch {
    // Fuso inválido: segue o padrão.
  }
  const mes = parsed.data.ano_mes ?? new Date(agoraMs).toISOString().slice(0, 7);
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(agoraMs),
  );

  const { agregados: ag } = await agregadosDoMes({
    supabase,
    orgId: authz.org.orgId,
    mes,
    fuso,
    hoje,
    inicioJanela: `${deslocarMes(mes, -12)}-01`,
  });

  const contexto = {
    mes,
    vendido_cents: ag.vendidoMes,
    qtd_pedidos: ag.qtdMes,
    meta_cents: ag.metaLoja,
    ranking_top10: ag.ranking.slice(0, 10).map((r) => ({ vendedor: r.vendedorId, total_cents: r.total, pedidos: r.qtd, ticket_cents: r.ticket })),
    carteira: ag.carteira,
    positivacao: ag.positivacao,
    curva_abc: ag.abc,
    faturado_cents: ag.faturado,
    nao_faturado_cents: ag.naoFaturado,
  };

  try {
    const { object } = await generateObject({
      model,
      headers: gatewayHeaders({ organizationId: authz.org.orgId }),
      schema: respostaSchema,
      prompt:
        `Você é o analista comercial da loja. Mês de referência: ${mes}. ` +
        `Responda em pt-BR, curto e direto, usando APENAS os números do contexto abaixo. ` +
        `Se a pergunta pedir algo fora do contexto, diga o que falta em vez de inventar. ` +
        `Sempre que fizer sentido, monte "grafico" (barras, pizza ou linha) com até 20 pontos em centavos, ` +
        `reaproveitando os números do contexto sem recalculá-los. Valores em centavos.\n\n` +
        `Pergunta: ${parsed.data.pergunta}\n\nContexto:\n${JSON.stringify(contexto)}`,
    });
    return ok(object, { requestId });
  } catch (e) {
    return fail("internal_error", "A IA não respondeu agora — tente de novo em instantes.", 500, {
      requestId,
      details: { motivo: e instanceof Error ? e.message.slice(0, 200) : "desconhecido" },
    });
  }
}

/**
 * GET /api/v1/ai/turn-traces — leitor técnico parcial do traço do turno (#3201).
 *
 * Decisão 218: reusa AI_TELEMETRY_RETENTION_DAYS (400 / piso 100), sem nova
 * configuração. Datas pedidas são dias civis UTC; a janela começa no instante
 * agora - retenção. Fora da janela consultável não significa expurgo provado.
 *
 * A projeção do recibo não consulta error_message nem devolve erros livres ou
 * JSON arbitrário do legado. A gravação e a RLS da 0721 não mudam nesta fatia.
 * Cookie, manager+, organização resolvida no guard e filtro explícito da sessão.
 * A tela e sua prova visual continuam pendentes na issue #3201.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
  interpretarRetencao,
} from "@/lib/retencao/politica";
import { createClient } from "@/lib/supabase/server";
import { diaIso, janelaDaLeitura } from "@/lib/retencao/janela-do-traco";
import {
  COLUNAS_DO_TRACO,
  LIMITE_MAXIMO,
  reciboDoTraco,
} from "@/lib/agent-engine/agent/recibo-do-traco";

export const dynamic = "force-dynamic";

const LIMITE_PADRAO = 50;

const filtrosDaQuery = z.object({
  conversation_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  /** O turno real é chaveado por `job_id` — é o link com a fila e com `llm_calls`. */
  job_id: z.string().uuid().optional(),
  status: z.enum(["completed", "failed", "aborted"]).optional(),
  /** `real` = turno de verdade; `previa` = execução de teste (`is_dry_run`). */
  tipo: z.enum(["real", "previa"]).optional(),
  desde: z.iso.date().optional(),
  ate: z.iso.date().optional(),
  limite: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).default(LIMITE_PADRAO),
});

/** Por que a resposta veio sem nenhum traço. Nunca `null` em silêncio. */
type MotivoDoVazio = "nenhum_turno_na_janela" | "fora_da_retencao";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_turn_traces" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const filtros = filtrosDaQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!filtros.success) {
    return fail("invalid_query", t("filtros inválidos"), 422, {
      requestId,
      details: filtros.error.issues,
    });
  }
  const { conversation_id, contact_id, job_id, status, tipo, desde, ate, limite } = filtros.data;
  const agora = new Date();
  if (desde !== undefined && desde > (ate ?? diaIso(agora))) {
    return fail("invalid_query", t("filtros inválidos"), 422, { requestId });
  }

  // Um knob, dois leitores: o expurgo (cron) e esta rota. Ler o MESMO
  // `interpretarRetencao` é o que impede os dois de divergirem — o dia em que a
  // retenção for menor que a janela da tela, é aqui que o corte aparece.
  const retencao = interpretarRetencao(env.AI_TELEMETRY_RETENTION_DAYS, {
    chave: "AI_TELEMETRY_RETENTION_DAYS",
    padrao: RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
    piso: RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
  });
  const janela = janelaDaLeitura({ desde, ate }, retencao.dias, agora);
  const dadosDaJanela = {
    janela: {
      de: diaIso(janela.de),
      ate: diaIso(janela.foraDaRetencao ? janela.de : janela.ate),
      dias: janela.dias,
    },
    retencao_dias: retencao.dias,
    corte_retencao_em: janela.corte.toISOString(),
    truncado_pela_retencao: janela.truncada,
  };
  if (janela.foraDaRetencao) {
    return ok(
      { tracos: [], total: 0, ...dadosDaJanela, motivo_do_vazio: "fora_da_retencao" },
      { requestId },
    );
  }

  const falhaNaConsulta = () =>
    fail("query_failed", t("Erro interno. Tente de novo em instantes."), 500, { requestId });
  try {
    const db = await createClient();
    let consulta = db
      .from("agent_turn_traces")
      .select(COLUNAS_DO_TRACO)
      // A organização vem da SESSÃO (o portão já a resolveu contra as memberships),
      // nunca de um filtro do pedido. A RLS da 0721 isola igual; isto é a segunda.
      .eq("organization_id", authz.org.orgId)
      .gte("created_at", janela.de.toISOString())
      .lt("created_at", janela.fimExclusivo.toISOString())
      .order("created_at", { ascending: false })
      .limit(limite);

    if (conversation_id !== undefined) consulta = consulta.eq("conversation_id", conversation_id);
    if (contact_id !== undefined) consulta = consulta.eq("contact_id", contact_id);
    if (job_id !== undefined) consulta = consulta.eq("job_id", job_id);
    if (status !== undefined) consulta = consulta.eq("status", status);
    if (tipo !== undefined) consulta = consulta.eq("is_dry_run", tipo === "previa");

    const { data, error } = await consulta;
    if (error) return falhaNaConsulta();
    const tracos = (data ?? []).map(reciboDoTraco);

    // O contrário do silêncio: lista vazia sempre vem com o porquê. A tela (fatia
    // seguinte) escreve a frase; a rota não inventa prosa traduzível.
    const motivoDoVazio: MotivoDoVazio | null = tracos.length > 0 ? null : "nenhum_turno_na_janela";

    return ok(
      {
        tracos,
        total: tracos.length,
        ...dadosDaJanela,
        motivo_do_vazio: motivoDoVazio,
      },
      { requestId },
    );
  } catch {
    return falhaNaConsulta();
  }
}

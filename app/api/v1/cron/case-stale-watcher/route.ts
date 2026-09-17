/**
 * O CASO QUE NINGUÉM ABRIU VOLTA A PEDIR PASSAGEM.
 *
 * Um caso em `awaiting_human` é a IA esperando uma pessoa destravar alguma
 * coisa, com um cliente do outro lado. Se ninguém olha, ele fica lá — e nada no
 * sistema avisa. O cliente espera para sempre e a única evidência de que ele
 * existiu é uma linha numa tela que ninguém abriu naquele dia.
 *
 * ⚠️ ISTO NÃO É HIPÓTESE. Medido num CRM em produção com o mesmo desenho de
 * fila (2026-09-14): **22 pedidos parados, o mais antigo há 17,6 dias**, e onze
 * deles eram gente pedindo para falar com uma pessoa. A fila era usada — 72 de
 * 102 pedidos foram resolvidos — e mesmo assim esses 22 ficaram para trás,
 * porque não havia nada que os trouxesse de volta.
 *
 * ═══ POR QUE UM AVISO NA CENTRAL, E NÃO UMA MENSAGEM ═══
 *
 * O destinatário da cobrança é a EQUIPE, não o cliente. Um aviso na Central
 * (com o sino) chega a quem pode resolver, não consome janela de envio do
 * WhatsApp, não gasta o número e não corre o risco de a cobrança interna vazar
 * para fora. O sistema que originou este defeito mandava WhatsApp para a dona do
 * negócio; aqui o canal certo já existe.
 *
 * ═══ POR QUE ELE PARA DE COBRAR ═══
 *
 * `followup_attempts` — coluna que existe desde a migration 0066 e que, até
 * aqui, **só tinha leitores** (as métricas do Índice de Atrito; a própria 0133
 * registra: "já conta a insistência e nenhuma tela lê"). Ela ganha o escritor
 * que faltava, e é ela que segura o teto.
 *
 * Três avisos e para. Quem ignorou três vezes não vai atender no quarto, e
 * alarme que nunca cala treina a equipe a ignorar o alarme certo — o mesmo
 * argumento que o dedup de `insertInboxItem` já faz no repositório.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Quanto tempo um caso pode ficar sem ninguém encostar antes do primeiro aviso,
 * e o intervalo entre as cobranças seguintes.
 *
 * Constante e não configuração: enquanto ninguém pedir um valor diferente, um
 * knob a mais é uma pergunta a mais no onboarding e um campo a mais para ficar
 * errado. Vira `organizations.settings` no dia em que alguém precisar.
 */
const SILENCIO_ATE_COBRAR_MS = 24 * 60 * 60 * 1000;

/** Depois disto, insistir não informa mais nada — só ensina a ignorar. */
const TETO_DE_COBRANCAS = 3;

/** Teto por rodada. Roda de hora em hora; sobra volta na seguinte. */
const LIMITE_DA_VARREDURA = 200;

function comoFaz(horas: number): string {
  const dias = Math.floor(horas / 24);
  if (dias >= 1) return dias === 1 ? "há um dia" : `há ${dias} dias`;
  return `há ${Math.max(1, Math.round(horas))} horas`;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = Date.now();
  const corte = new Date(agora - SILENCIO_ATE_COBRAR_MS).toISOString();

  // `updated_at` e não `opened_at`: qualquer mexida no caso (uma nota do agente,
  // uma transição) conta como "alguém encostou". Cobrar por idade absoluta
  // avisaria de novo sobre um caso que a equipe está tratando naquele instante.
  const { data, error } = await admin
    .from("agent_cases")
    .select("id, organization_id, title, opened_at, updated_at, followup_attempts")
    .eq("status", "awaiting_human")
    .lt("updated_at", corte)
    .lt("followup_attempts", TETO_DE_COBRANCAS)
    .order("updated_at", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[case-stale-watcher] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar casos parados.", 500, { requestId });
  }

  const casos = data ?? [];
  let avisados = 0;
  let jaAvisados = 0;

  for (const caso of casos) {
    const horas = (agora - Date.parse(caso.opened_at as string)) / 3_600_000;
    const tentativa = (caso.followup_attempts as number) + 1;

    // Um aviso ABERTO por caso: enquanto o anterior não for resolvido, não
    // nasce outro. Quem resolve o aviso sem resolver o caso é cobrado de novo no
    // ciclo seguinte — e é `followup_attempts` que impede isso para sempre.
    const { data: jaTem } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", caso.organization_id)
      .eq("kind", "case_stale")
      .eq("ref_id", caso.id)
      .eq("status", "open")
      .maybeSingle();

    if (jaTem) {
      jaAvisados += 1;
      continue;
    }

    const { error: erroAviso } = await admin.from("agent_inbox_items").insert({
      organization_id: caso.organization_id,
      kind: "case_stale",
      // `warn` e não `critical`: há um cliente esperando, mas nada quebrou. O
      // vermelho é para o que está fora do ar — usá-lo aqui o desvaloriza.
      severity: "warn",
      title: `Um atendimento espera decisão ${comoFaz(horas)}`,
      body:
        `"${caso.title as string}" está aguardando alguém da equipe desde que foi aberto, ` +
        `e o cliente continua do outro lado. Abra o caso e diga o que fazer — concluir, ` +
        `pedir informação ao cliente ou passar para uma pessoa.` +
        (tentativa >= TETO_DE_COBRANCAS
          ? " Este é o último aviso automático sobre ele."
          : ""),
      ref_kind: "agent_case",
      ref_id: caso.id,
    });

    if (erroAviso) {
      logger.error("[case-stale-watcher] aviso não foi aberto", {
        case_id: caso.id,
        organization_id: caso.organization_id,
        error: erroAviso.message,
        requestId,
      });
      continue;
    }

    // ⚠️ NÃO usa `update ... set updated_at`: mexer em `updated_at` faria a
    // própria cobrança parecer "alguém encostou no caso" e adiaria a seguinte
    // por mais 24h — o watcher sabotando a si mesmo. O trigger de updated_at
    // desta tabela é o que decide; aqui só o contador muda.
    const { error: erroContador } = await admin
      .from("agent_cases")
      .update({ followup_attempts: tentativa })
      .eq("id", caso.id)
      .eq("organization_id", caso.organization_id)
      .eq("status", "awaiting_human");

    if (erroContador) {
      logger.error("[case-stale-watcher] contador não subiu", {
        case_id: caso.id,
        error: erroContador.message,
        requestId,
      });
    }
    avisados += 1;
  }

  // Rodada que não avisou ninguém NÃO é mutação e não audita (CLAUDE.md §Audit
  // log, vigiado por `cron-audita-so-quando-ha-efeito.test.ts`).
  if (avisados > 0) {
    await audit({
      action: "ai.caso_parado_cobrado",
      resourceType: "agent_case",
      requestId,
      metadata: { avisados, examinados: casos.length },
    });
  }

  return ok(
    { examinados: casos.length, avisados, ja_avisados: jaAvisados },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;

/**
 * O RELATÓRIO DIÁRIO DA OPERAÇÃO — gerado no relógio de parede de CADA organização.
 *
 * ═══ POR QUE DE QUINZE EM QUINZE MINUTOS ═══
 *
 * "21h" é a hora local de cada organização (`settings.operacao_do_dia.relatorio.hora`,
 * padrão 21), no fuso dela (`organizations.timezone`). Cada rodada pergunta a
 * `decisaoDoCron`, por organização, três coisas:
 *
 *   - ONTEM ficou sem relatório? (a instalação estava parada na hora, ou a
 *     rodada falhou) — gera agora o dia de ontem, já fechado: DIA INTEIRO, sem
 *     o estado do momento. Não espera a hora de hoje: o dia perdido sai na
 *     primeira rodada em que a instalação estiver de pé.
 *   - Hoje já passou da hora e não tem linha? — gera o de hoje.
 *   - Hoje (ou ontem) tem linha, mas do botão "Gerar agora" ANTES da hora
 *     marcada daquele dia? — regera uma vez por cima (a linha passa a
 *     `gerado_por = 'cron'`, e a condição deixa de valer: sem laço). O manual
 *     não cancela o automático, nem quando a instalação parou entre o clique
 *     e a hora marcada.
 *
 * ═══ IDEMPOTENTE ═══
 *
 * Criar é `insert ... on conflict (organization_id, dia) do nothing`; regerar
 * por cima do manual é um `update` condicionado à linha AINDA ser manual e de
 * antes da hora. Duas rodadas sobrepostas, uma réplica a mais ou um reenvio
 * gravam UMA vez — quem chega depois volta `gravou: false` e não audita.
 *
 * ═══ AUDITORIA SÓ QUANDO HOUVE EFEITO ═══
 *
 * A rodada que não gerou nada não escreve linha. Cada relatório GRAVADO deixa
 * uma `operacao.relatorio_gerado`, com o dia, o motivo e as contagens — nunca
 * nome de contato.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { decisaoDoCron, diaAnterior, diaNoFuso, lerConfiguracao, type RelatorioExistente } from "@/lib/operacao/regras";
import { gerarRelatorioDiario, TABELA_DOS_RELATORIOS } from "@/lib/operacao/relatorio-diario";
import { ehOperante, STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

/** Quantas organizações uma rodada lê. */
const TETO_DE_ORGANIZACOES = 1000;
/** Quantos relatórios uma rodada gera. O resto fica para a de daqui a 15 min. */
const TETO_DE_GERACOES = 20;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("id, status, timezone, locale, settings, created_at")
    .eq("status", STATUS_OPERANTE)
    .order("id", { ascending: true })
    .limit(TETO_DE_ORGANIZACOES);
  if (error) {
    logger.error("[relatorio-operacao-diario] organizações não lidas", { error: error.message, requestId });
    return fail("internal_error", "Falha ao ler organizações.", 500, { requestId });
  }

  const agora = new Date();
  // Organização parada (suspensa, redigida, arquivada) não gera nada.
  const orgs = ((data ?? []) as Array<{
    id: string;
    status: string | null;
    timezone: string | null;
    locale: string | null;
    settings: unknown;
    created_at: string | null;
  }>)
    .filter((o) => ehOperante(o.status))
    .map((o) => {
      const fuso = fusoUtilizavel(o.timezone);
      const hoje = diaNoFuso(agora, fuso);
      return {
        id: o.id,
        criadaEm: o.created_at,
        contexto: { fuso, idioma: normalizarIdioma(o.locale), config: lerConfiguracao(o.settings) },
        dias: [hoje, diaAnterior(hoje)],
      };
    });

  // Os relatórios que já existem para HOJE e ONTEM (dias locais) de cada organização.
  const existentes = new Map<string, Map<string, RelatorioExistente>>();
  const ligadas = orgs.filter((o) => o.contexto.config.relatorio.ligado);
  for (let i = 0; i < ligadas.length; i += 200) {
    const lote = ligadas.slice(i, i + 200);
    const dias = [...new Set(lote.flatMap((o) => o.dias))];
    const { data: linhas, error: erroExistentes } = await admin
      .from(TABELA_DOS_RELATORIOS)
      .select("organization_id, dia, gerado_por, gerado_em")
      .in("organization_id", lote.map((o) => o.id))
      .in("dia", dias);
    if (erroExistentes) {
      logger.error("[relatorio-operacao-diario] relatórios existentes não lidos", {
        error: erroExistentes.message,
        requestId,
      });
      return fail("internal_error", "Falha ao ler relatórios.", 500, { requestId });
    }
    for (const r of (linhas ?? []) as Array<{ organization_id: string; dia: string } & RelatorioExistente>) {
      const porDia = existentes.get(r.organization_id) ?? new Map<string, RelatorioExistente>();
      porDia.set(r.dia, { gerado_por: r.gerado_por, gerado_em: r.gerado_em });
      existentes.set(r.organization_id, porDia);
    }
  }

  let gravados = 0;
  let tentativas = 0;
  const desfechos: Record<string, number> = {};
  const contar = (chave: string) => {
    desfechos[chave] = (desfechos[chave] ?? 0) + 1;
  };

  for (const org of orgs) {
    const decisao = decisaoDoCron({
      agora,
      fuso: org.contexto.fuso,
      config: org.contexto.config.relatorio,
      existentes: existentes.get(org.id) ?? new Map(),
      criadaEm: org.criadaEm,
    });
    if (decisao.motivo) {
      contar(decisao.motivo);
      continue;
    }
    for (const acao of decisao.acoes) {
      if (tentativas >= TETO_DE_GERACOES) {
        contar("adiado_pelo_teto");
        continue;
      }
      tentativas += 1;
      try {
        const r = await gerarRelatorioDiario({
          admin,
          orgId: org.id,
          dia: acao.dia,
          geradoPor: "cron",
          substituir: false,
          ...(acao.substituirManualAntesDe ? { substituirManualAntesDe: acao.substituirManualAntesDe } : {}),
          contexto: org.contexto,
          agora,
        });
        if (r.gravou) {
          gravados += 1;
          contar(acao.motivo);
          void audit({
            action: "operacao.relatorio_gerado",
            organizationId: org.id,
            actorUserId: null,
            bypassedRls: true,
            resourceType: "relatorio_operacao_diario",
            resourceId: r.id,
            requestId,
            metadata: {
              dia: acao.dia,
              gerado_por: "cron",
              motivo: acao.motivo,
              novas: r.conteudo.contadores.novas.total,
              com_entrada: r.conteudo.contadores.com_entrada.total,
              aguardando: r.conteudo.aguardando.length,
            },
          });
        } else {
          contar(`${acao.motivo}:ja_gravado_por_outra_rodada`);
        }
      } catch (err) {
        // Uma organização com defeito não pode derrubar o relatório das outras.
        contar("erro");
        logger.error("[relatorio-operacao-diario] geração falhou", {
          organization_id: org.id,
          dia: acao.dia,
          motivo: acao.motivo,
          error: err instanceof Error ? err.message : String(err),
          requestId,
        });
      }
    }
  }

  return ok({ organizacoes: orgs.length, gravados, desfechos }, { requestId });
}

export const GET = handle;
export const POST = handle;

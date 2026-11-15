/**
 * O RELATÓRIO DIÁRIO DA OPERAÇÃO — gerado no relógio de parede de CADA organização.
 *
 * ═══ POR QUE DE QUINZE EM QUINZE MINUTOS ═══
 *
 * "21h" é a hora local de cada organização (`settings.operacao_do_dia.relatorio.hora`,
 * padrão 21), no fuso dela (`organizations.timezone`). A rodada gera para quem
 * já passou da hora e ainda não tem linha para o dia LOCAL de hoje
 * (`decisaoDoCron`). Se a instalação estava parada às 21h, o relatório sai na
 * primeira rodada depois — e não amanhã.
 *
 * ═══ IDEMPOTENTE ═══
 *
 * `insert ... on conflict (organization_id, dia) do nothing`: duas rodadas
 * sobrepostas, uma réplica a mais ou um reenvio geram UMA linha. Quem chegou
 * depois volta `gravou: false` e não audita.
 *
 * ═══ AUDITORIA SÓ QUANDO HOUVE EFEITO ═══
 *
 * A rodada que não gerou nada (a maioria: 95 de cada 96 batidas do dia) não
 * escreve linha. Cada relatório CRIADO deixa uma `operacao.relatorio_gerado`,
 * com o dia e as contagens — nunca nome de contato.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { decisaoDoCron, diaNoFuso, lerConfiguracao } from "@/lib/operacao/regras";
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
    .select("id, status, timezone, locale, settings")
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
  }>)
    .filter((o) => ehOperante(o.status))
    .map((o) => {
      const fuso = fusoUtilizavel(o.timezone);
      return {
        id: o.id,
        contexto: { fuso, idioma: normalizarIdioma(o.locale), config: lerConfiguracao(o.settings) },
        diaLocal: diaNoFuso(agora, fuso),
      };
    });

  // Os relatórios que já existem para o dia local de cada organização.
  const jaGerados = new Map<string, Set<string>>();
  const ligadas = orgs.filter((o) => o.contexto.config.relatorio.ligado);
  for (let i = 0; i < ligadas.length; i += 200) {
    const lote = ligadas.slice(i, i + 200);
    const dias = [...new Set(lote.map((o) => o.diaLocal))];
    const { data: existentes, error: erroExistentes } = await admin
      .from(TABELA_DOS_RELATORIOS)
      .select("organization_id, dia")
      .in("organization_id", lote.map((o) => o.id))
      .in("dia", dias);
    if (erroExistentes) {
      logger.error("[relatorio-operacao-diario] relatórios existentes não lidos", {
        error: erroExistentes.message,
        requestId,
      });
      return fail("internal_error", "Falha ao ler relatórios.", 500, { requestId });
    }
    for (const r of (existentes ?? []) as Array<{ organization_id: string; dia: string }>) {
      const set = jaGerados.get(r.organization_id) ?? new Set<string>();
      set.add(r.dia);
      jaGerados.set(r.organization_id, set);
    }
  }

  let criados = 0;
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
      diasJaGerados: jaGerados.get(org.id) ?? new Set(),
    });
    if (!decisao.gerar) {
      contar(decisao.motivo);
      continue;
    }
    if (tentativas >= TETO_DE_GERACOES) {
      contar("adiado_pelo_teto");
      continue;
    }
    tentativas += 1;
    try {
      const r = await gerarRelatorioDiario({
        admin,
        orgId: org.id,
        dia: decisao.dia,
        geradoPor: "cron",
        substituir: false,
        contexto: org.contexto,
        agora,
      });
      if (r.gravou) {
        criados += 1;
        contar("criado");
        void audit({
          action: "operacao.relatorio_gerado",
          organizationId: org.id,
          actorUserId: null,
          bypassedRls: true,
          resourceType: "relatorio_operacao_diario",
          resourceId: r.id,
          requestId,
          metadata: {
            dia: decisao.dia,
            gerado_por: "cron",
            novas: r.conteudo.contadores.novas.total,
            com_entrada: r.conteudo.contadores.com_entrada.total,
            aguardando: r.conteudo.aguardando.length,
          },
        });
      } else {
        contar("ja_gravado_por_outra_rodada");
      }
    } catch (err) {
      // Uma organização com defeito não pode derrubar o relatório das outras.
      contar("erro");
      logger.error("[relatorio-operacao-diario] geração falhou", {
        organization_id: org.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok({ organizacoes: orgs.length, criados, desfechos }, { requestId });
}

export const GET = handle;
export const POST = handle;

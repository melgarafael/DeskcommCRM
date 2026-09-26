/**
 * A DATA DO FUNIL AVISA QUANDO FALTAM N DIAS (issue #989) — a varredura.
 *
 * O gatilho "quando faltarem N dias para uma data do funil" não tem
 * acontecimento: a data mora no `custom_fields` do negócio e o dia em que ela
 * chega passa em silêncio. Quem percebe é o relógio — este cron. Ele existe
 * para transformar a data em ACONTECIMENTO (`lead.date_field_due` no
 * `event_log`), e quem decide o que fazer com ele é a automação que a
 * organização configurar: as ações (etiqueta, WhatsApp, mover o card) já vivem
 * no motor de regras.
 *
 * ═══ SÓ AS ORGANIZAÇÕES QUE PEDIRAM ═══
 *
 * A varredura começa pelas REGRAS, não pelos negócios. Sem isso, toda
 * instalação pagaria a varredura do `custom_fields` todo dia para ninguém
 * ouvir — evento sem consumer é linha no `event_log` de quem não usa a
 * automação. O recorte é o MESMO do aniversário (`contact-birthdays`): só
 * entram as organizações com regra ATIVA deste gatilho.
 *
 * ═══ A HORA É LOCAL ═══
 *
 * "Hoje" depende do fuso da organização. Um cron que decidisse pelo UTC
 * avisaria no dia errado metade do mundo. A varredura roda de hora em hora e só
 * age na organização cujo relógio de parede marca `HORA_DA_VARREDURA` — uma
 * regra só resolve o dia certo e uma hora decente para mandar mensagem.
 *
 * ═══ UMA VEZ POR NEGÓCIO, POR REGRA ═══
 *
 * A trava vive no `event_log` (o par `regra:negócio`, em `payload.rule_id` +
 * `entity_id`), e NÃO tem janela de tempo — de propósito. O dia inteiro é o
 * mesmo dia, e sem trava a mensagem do ateliê sairia tantas vezes quantas a
 * varredura rodasse; com uma janela de horas, a segunda cobrança de um negócio
 * antigo (a de 60 dias DEPOIS do casamento) ficaria de fora. A consequência
 * mudou na #1540: a chave passou a levar o VALOR da data
 * (`regra:negócio:valor`), então **mudar a data rearma o aviso** — remarcou o
 * casamento, a cobrança de 60 dias depois dele volta a existir. O que NÃO
 * rearma é trocar só o formato do campo (`01/05/2026` → `2026-05-01` é a mesma
 * data) e voltar à data já avisada: por aquele valor a regra já cumpriu o papel.
 *
 * ═══ O EVENTO É DIRIGIDO A UMA REGRA ═══
 *
 * Duas regras do mesmo gatilho com `dias` diferentes são o caso que manda no
 * desenho (240 dias antes do casamento, 60 depois dele). O motor casa regra por
 * `event_type`, então um evento que não dissesse PARA QUAL regra vale acordaria
 * as duas: a confirmação de entrega sairia junto com o aviso de 240 dias. Por
 * isso o payload leva `rule_id` — e `lib/automation/engine.ts` o respeita.
 *
 * ═══ O QUE NÃO FOI MEDIDO ═══
 *
 * O custo de varrer o `custom_fields` numa base grande. Não há índice para o
 * caminho `custom_fields->>campo` (nenhum campo do funil tem), e o recorte por
 * `pipeline_id` é o que segura o trabalho. O `or` do PostgREST estreita o
 * conjunto pelas duas formas que o produto grava (ISO e `dd/mm/aaaa`) e o
 * filtro de verdade é o TypeScript (`casaNaData`), mas o plano de execução numa
 * tabela de milhões de linhas não foi exercitado.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  TAMANHO_DO_LOTE,
  TETO_POR_ORGANIZACAO,
  diaLocal,
  eHoraDaVarredura,
  fusoDaOrganizacao,
} from "@/lib/automation/cron-de-data";
import {
  GATILHO_DE_DATA_DO_FUNIL,
  casaNaData,
  chaveDeDisparo,
  chaveDeDisparoComValor,
  configDoGatilhoDeData,
  diaAlvo,
  diaBrasileiro,
} from "@/lib/automation/gatilho-de-data-do-funil";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** A forma crua de `crm_leads.custom_fields` — jsonb sem esquema declarado. */
type CamposDoNegocio = Record<string, unknown> | null;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  const { data: regras, error: erroRegras } = await admin
    .from("automation_rules")
    .select("id, organization_id, trigger_config")
    .eq("trigger_event", GATILHO_DE_DATA_DO_FUNIL)
    .eq("is_active", true);

  if (erroRegras) {
    logger.error("[lead-date-field-due] consulta de regras falhou", {
      error: erroRegras.message,
      requestId,
    });
    return fail("internal_error", "Falha ao buscar regras.", 500, { requestId });
  }

  const todasAsRegras = regras ?? [];
  if (todasAsRegras.length === 0) {
    return ok(
      { organizacoes: 0, regras: 0, examinados: 0, emitidos: 0, pulados: {} },
      { requestId },
    );
  }

  const orgsComRegra = [...new Set(todasAsRegras.map((r) => r.organization_id as string))];
  const { data: organizacoes } = await admin
    .from("organizations")
    .select("id, timezone")
    .in("id", orgsComRegra.slice(0, TAMANHO_DO_LOTE));

  let emitidos = 0;
  let examinados = 0;
  const pulados: Record<string, number> = {};
  const pular = (motivo: string, quantos = 1) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + quantos;
  };

  for (const organizacao of organizacoes ?? []) {
    const org = organizacao.id as string;
    const fuso = fusoDaOrganizacao(organizacao.timezone as string | null);

    let hojeLocal: string;
    try {
      // `partesNoFuso` lança em fuso inexistente, de propósito: uma organização
      // com o campo digitado errado não pode derrubar a varredura das outras.
      if (!eHoraDaVarredura(agora, fuso)) continue;
      hojeLocal = diaLocal(agora, fuso);
    } catch {
      pular("fuso_invalido");
      continue;
    }

    for (const regra of todasAsRegras) {
      if (regra.organization_id !== org) continue;

      const config = configDoGatilhoDeData(regra.trigger_config);
      if (!config) {
        // Linha torta (preenchida à mão, ou de antes de a tela existir) não
        // casa com nada, e não impede as irmãs de rodar.
        pular("config_invalida");
        continue;
      }

      const alvo = diaAlvo(hojeLocal, config.dias);
      if (!alvo) {
        pular("config_invalida");
        continue;
      }

      const { data: candidatos, error } = await admin
        .from("crm_leads")
        .select("id, custom_fields")
        .eq("organization_id", org)
        .eq("pipeline_id", config.pipeline_id)
        // Só NEGÓCIOS ABERTOS (#1540): avançar uma data de um ganho ou perdido
        // mandava o time cobrar quem já saiu do funil. É o padrão — quem quiser
        // avisar sobre fechados escreve uma regra nova quando isso existir.
        .eq("status", "open")
        // O SQL ESTREITA; o TypeScript DECIDE. As duas formas que o produto
        // grava — o ISO do formulário (e o timestamp de quem entrou por API) e
        // o `dd/mm/aaaa` da importação — viram um superconjunto aqui, e
        // `casaNaData` (a mesma função que os testes da parte pura exercitam)
        // é quem diz sim ou não. Sem o `or`, toda a carteira do funil viria
        // para a memória a cada rodada; com ele, o teto abaixo conta o que
        // interessa.
        .or(
          `custom_fields->>${config.campo}.like.*${alvo}*,custom_fields->>${config.campo}.like.*${diaBrasileiro(alvo)}*`,
        )
        // Ordem determinística: o teto corta os mais antigos por ÚLTIMO, e não
        // em ordem que o banco escolher.
        .order("created_at", { ascending: true })
        .limit(TETO_POR_ORGANIZACAO);

      if (error) {
        logger.error("[lead-date-field-due] consulta de negócios falhou", {
          organization_id: org,
          rule_id: regra.id,
          error: error.message,
          requestId,
        });
        pular("consulta_falhou");
        continue;
      }

      const casam = (candidatos ?? []).filter((lead) =>
        casaNaData(
          (lead.custom_fields as CamposDoNegocio)?.[config.campo],
          hojeLocal,
          config.dias,
        ),
      );
      if (casam.length === 0) continue;
      examinados += casam.length;

      // Quem já disparou ESTA regra COM ESTE VALOR não dispara de novo (#1540):
      // a mesma data continua valendo um aviso, e uma data MOVIDA rearma o
      // par (regra, negócio). Sem o valor na chave a trava era para sempre —
      // remarcou o casamento, a cobrança de 60 dias depois dele nunca saía.
      const jaEmitidos = new Set<string>();
      for (let i = 0; i < casam.length; i += TAMANHO_DO_LOTE) {
        const lote = casam.slice(i, i + TAMANHO_DO_LOTE).map((l) => l.id as string);
        const { data: anteriores } = await admin
          .from("event_log")
          .select("entity_id, payload")
          .eq("organization_id", org)
          .eq("event_type", GATILHO_DE_DATA_DO_FUNIL)
          .eq("payload->>rule_id", regra.id)
          .in("entity_id", lote);
        for (const anterior of anteriores ?? []) {
          const valor = (anterior.payload as { valor?: unknown } | null)?.valor;
          const leadId = anterior.entity_id as string;
          if (valor === undefined || valor === null) {
            // Linha anterior à #1540: sem valor não há como rearmar, e DESERDIR
            // a trava antiga reemitiria o aviso de todo par já avisado no
            // primeiro deploy. A regra antiga continua valendo para quem já
            // disparou; o rearme vale para o que disparar daqui pra frente.
            jaEmitidos.add(chaveDeDisparo(regra.id, leadId));
            continue;
          }
          jaEmitidos.add(chaveDeDisparoComValor(regra.id, leadId, valor));
        }
      }

      const novos = casam
        .filter(
          (lead) =>
            !jaEmitidos.has(
              chaveDeDisparoComValor(
                regra.id,
                lead.id as string,
                (lead.custom_fields as CamposDoNegocio)?.[config.campo],
              ),
            ) &&
            !jaEmitidos.has(chaveDeDisparo(regra.id, lead.id as string)),
        )
        .map((lead) => ({
          id: lead.id as string,
          valor: (lead.custom_fields as CamposDoNegocio)?.[config.campo] ?? null,
        }));
      if (novos.length < casam.length) pular("ja_emitido", casam.length - novos.length);

      for (const candidato of novos) {
        const { error: erroEvento } = await admin.rpc("emit_event" as never, {
          p_event_type: GATILHO_DE_DATA_DO_FUNIL,
          p_entity_kind: "crm_lead",
          p_entity_id: candidato.id,
          // `rule_id` é o que faz o evento valer só para a regra que o pediu:
          // sem ele, a regra irmã de `dias` diferente rodaria junto.
          p_payload: {
            rule_id: regra.id,
            pipeline_id: config.pipeline_id,
            campo: config.campo,
            dias: config.dias,
            local_date: hojeLocal,
            date: alvo,
            // O VALOR que casou — é ele quem entra na trava e permite o rearme
            // quando a data muda (#1540).
            valor: candidato.valor,
          },
          p_metadata: { actor_kind: "system", source: "cron/lead-date-field-due" },
          p_organization_id: org,
        });
        if (erroEvento) {
          logger.error("[lead-date-field-due] emit_event falhou", {
            organization_id: org,
            rule_id: regra.id,
            lead_id: candidato.id,
            error: erroEvento.message,
            requestId,
          });
          pular("emissao_falhou");
          continue;
        }
        emitidos += 1;
      }
    }
  }

  // Rodada que não emitiu nada NÃO é mutação, e não audita — a lei está no
  // CLAUDE.md §Audit log, e `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
  // varre o AST de toda rota deste diretório atrás de `audit` incondicional.
  if (emitidos > 0) {
    await audit({
      action: "lead.data_do_funil_emitida",
      resourceType: "automation_rule",
      metadata: { emitidos, examinados, pulados },
      requestId,
    });
  }

  return ok(
    {
      organizacoes: (organizacoes ?? []).length,
      regras: todasAsRegras.length,
      examinados,
      emitidos,
      pulados,
    },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;

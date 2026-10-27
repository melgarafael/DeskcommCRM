/**
 * GET /api/v1/agenda/datas-dos-negocios?pipeline_id=&campo=&campo_fim=&de=&ate=
 *
 * A camada "Datas dos negócios" da Agenda (#3221): os negócios de UM funil que
 * têm data no campo escolhido, no recorte de dias que a grade está desenhando.
 *
 * ─── SÓ LEITURA, e é o desenho, não uma promessa ────────────────────────────
 *
 * Não há POST, PATCH nem DELETE neste caminho, e não há nenhum aqui de
 * propósito: a camada não ocupa horário livre, não entra em
 * `crm_find_free_slots` e não manda lembrete. Quem muda a data muda o campo do
 * negócio, na ficha. O que esta rota faz é o que o Calendário do funil já faz
 * dentro do funil — mostrar —, só que para a Agenda.
 *
 * ─── A permissão é a do funil, reusada ─────────────────────────────────────
 *
 * Piso de papel: `viewer` em `crm_leads`, o MESMO da leitura do quadro
 * (`app/api/v1/pipelines/[id]/leads/route.ts`). Por linha, nada é reimplementado:
 * a consulta sai pelo cliente de sessão (`createClient`), então a policy
 * `crm_leads_select` chama `fn_can_view_lead` e aplica "O que cada atendente
 * enxerga" (own / own_and_unassigned / all) — quem não vê o funil não vê a data,
 * sem uma segunda régua para discordar da primeira. `organization_id` vem do
 * cookie validado e é filtrado explicitamente além da RLS, como em toda consulta
 * desta base.
 *
 * ─── Por que o campo escolhido é conferido no SERVIDOR ─────────────────────
 *
 * `campo` tem de estar declarado no funil como campo de data do negócio
 * (`camposDeDataDoNegocio`). Duas razões: um campo do CONTATO tem o valor em
 * `contacts.custom_fields` e a leitura sairia vazia para sempre; e um campo que
 * foi renomeado/apagado (decisão (c) da issue) precisa de uma resposta explícita
 * — 422 `campo_nao_e_data` — para a tela esquecer a escolha em vez de mostrar
 * uma grade vazia sem motivo.
 *
 * ─── O custo é limitado pelo dia, não pelo funil ───────────────────────────
 *
 * O filtro de data vai no `where` (`custom_fields->>campo` entre `de - 366` e
 * `ate`), e não na memória: um funil migrado tem milhares de negócios, e varrer
 * todos para desenhar uma semana é exatamente o que a #3172 mediu em 19 s. O
 * piso de `de - 366` é o teto do intervalo do Calendário do funil: uma viagem
 * que começou antes da janela e termina dentro dela continua aparecendo. O
 * `limit` fecha o pior caso e a resposta diz quando ele foi atingido
 * (`truncado`), em vez de fingir que a lista está completa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { itensDaCamada, type NegocioComDatas } from "@/lib/agenda/datas-dos-negocios";
import { traduzir } from "@/lib/i18n/dicionario";
import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";
import { LIMITE_DO_INTERVALO } from "@/lib/kanban/calendario-do-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Quantos negócios a camada lê por vez.
 *
 * Não é paginação: é o teto de um desenho. A janela de uma semana numa agência
 * de viagens não chega perto disto; quando chegar, `truncado: true` diz na tela
 * que falta coisa — e a resposta honesta é dividir o funil ou estreitar o
 * período, não carregar o funil inteiro para descobrir.
 */
export const NEGOCIOS_POR_LEITURA = 500;

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` menos N dias, no calendário puro (sem fuso: é dia, não instante). */
function diasAntes(dia: string, dias: number): string {
  const [ano, mes, d] = dia.split("-").map(Number);
  const data = new Date(ano!, mes! - 1, d!);
  data.setDate(data.getDate() - dias);
  const mm = String(data.getMonth() + 1).padStart(2, "0");
  const dd = String(data.getDate()).padStart(2, "0");
  return `${data.getFullYear()}-${mm}-${dd}`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const orgId = authz.org.orgId;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const params = req.nextUrl.searchParams;
  const pipelineId = (params.get("pipeline_id") ?? "").trim();
  const campo = (params.get("campo") ?? "").trim();
  const campoFim = (params.get("campo_fim") ?? "").trim();
  const de = (params.get("de") ?? "").trim();
  const ate = (params.get("ate") ?? "").trim();

  if (!pipelineId || !campo) {
    return fail("validation_error", t("Informe o funil e o campo de data."), 422, { requestId });
  }
  if (!RE_DIA.test(de) || !RE_DIA.test(ate) || de > ate) {
    return fail("validation_error", t("Período inválido."), 422, { requestId });
  }

  const supabase = await createClient();

  // O funil é conferido ANTES: id de outro tenant devolve 404, e não uma lista
  // vazia — "não existe" e "não tem negócio" são respostas diferentes, e a
  // segunda mente.
  const { data: funil, error: funilErr } = await supabase
    .from("crm_pipelines")
    .select("id, name, settings")
    .eq("organization_id", orgId)
    .eq("id", pipelineId)
    .maybeSingle();
  if (funilErr) return fail("internal_error", funilErr.message, 500, { requestId });
  if (!funil) return fail("resource_not_found", t("Funil não encontrado."), 404, { requestId });

  const camposDeData = camposDeDataDoNegocio(funil.settings);
  const inicial = camposDeData.find((c) => c.key === campo);
  if (!inicial) {
    return fail("campo_nao_e_data", t("Este campo de data não existe mais neste funil."), 422, {
      requestId,
    });
  }
  const final = campoFim && campoFim !== campo ? camposDeData.find((c) => c.key === campoFim) : undefined;
  if (campoFim && campoFim !== campo && !final) {
    return fail("campo_nao_e_data", t("Este campo de data não existe mais neste funil."), 422, {
      requestId,
    });
  }

  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId);
  const nomeDaEtapa = new Map(
    ((etapas ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]),
  );

  /**
   * A consulta dos negócios.
   *
   * `neq("status", "archived")` pela mesma razão do quadro: negócio arquivado não
   * é operação viva, e a Agenda é sobre o que acontece. O `not` deixa de fora
   * quem não preencheu o campo — é o caso que a tela tem de NÃO mostrar, e
   * filtrar aqui evita trazer linha que a camada jogaria fora.
   */
  const { data: linhas, error: leadsErr } = await supabase
    .from("crm_leads")
    .select("id, title, pipeline_id, stage_id, custom_fields")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .neq("status", "archived")
    .not(`custom_fields->>${campo}`, "is", null)
    .gte(`custom_fields->>${campo}`, diasAntes(de, LIMITE_DO_INTERVALO))
    .lte(`custom_fields->>${campo}`, ate)
    .limit(NEGOCIOS_POR_LEITURA);
  if (leadsErr) return fail("internal_error", leadsErr.message, 500, { requestId });

  const negocios: NegocioComDatas[] = (
    (linhas ?? []) as Array<{
      id: string;
      title: string;
      pipeline_id: string;
      stage_id: string | null;
      custom_fields: Record<string, unknown> | null;
    }>
  ).map((linha) => ({
    id: linha.id,
    titulo: linha.title,
    funilId: linha.pipeline_id,
    funilNome: funil.name,
    etapaNome: linha.stage_id ? (nomeDaEtapa.get(linha.stage_id) ?? null) : null,
    campos: linha.custom_fields ?? {},
  }));

  const itens = itensDaCamada(
    negocios,
    {
      campo,
      rotulo: inicial.label,
      campoFim: final ? final.key : null,
      rotuloFim: final ? final.label : null,
    },
    { de, ate },
  );

  return ok(
    { itens, truncado: negocios.length >= NEGOCIOS_POR_LEITURA },
    { requestId },
  );
}

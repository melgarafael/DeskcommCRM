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
 * ─── A querystring é validada pelo schema canônico, e as duas recusas ───────
 *
 * Os parâmetros passam por `datasDosNegociosQuerySchema`
 * (`lib/schemas/agenda.ts`), e não por leitura manual: a chave do campo vai
 * INTERPOLADA num caminho jsonb do PostgREST (`custom_fields->>campo`), e uma
 * chave com vírgula ou ponto seria sintaxe de filtro. `pipeline_id` é UUID, e o
 * dia é `YYYY-MM-DD` — as duas coisas que o PostgREST recusaria tarde, com um
 * 400 que a tela não sabe explicar.
 *
 * A forma inválida é `validation_error`; a data que NÃO EXISTE no calendário
 * (`2026-02-31`) é `data_de_calendario_invalida`. Antes, as duas caiam no
 * `RE_DIA`, que só confere a FORMA: o filtro ia para o banco, voltava vazio, e
 * a grade dizia que não havia negócio neste período para um dia que ninguém
 * digitou — o oposto da resposta explícita que esta rota promete.
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
 * O filtro de data vai no `where`, e não na memória: um funil migrado tem
 * milhares de negócios, e varrer todos para desenhar uma semana é exatamente o
 * que a #3172 mediu em 19 s. E o `limit` só serve à janela se o `where` for
 * justo: com um piso folgado e sem ordem, 3.000 negócios antigos ocupavam as 500
 * vagas e a semana visível voltava VAZIA (medido em Postgres: 0 de 20).
 *
 *  - **Um campo:** o piso é o próprio `de`.
 *  - **Dois campos:** o negócio também entra pelo segundo campo. O piso recua
 *    `LIMITE_DO_INTERVALO` (o teto do intervalo do Calendário do funil), para
 *    alcançar quem começou antes da janela, e o `or` deixa só quem tem uma das
 *    duas datas dentro dela.
 *  - **O fim é exclusivo** (`< ate + 1 dia`): a comparação é de TEXTO, e
 *    `'2026-11-15T14:00:00Z' <= '2026-11-15'` é falso. Data com hora no último
 *    dia ficaria de fora.
 *  - **A ordem é explícita** (data, id): sem ela, quem decide a fatia é a ordem
 *    física do banco. Quando a janela passa do teto, a resposta diz
 *    (`truncado`), em vez de fingir que a lista está completa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { itensDaCamada, type NegocioComDatas } from "@/lib/agenda/datas-dos-negocios";
import { traduzir } from "@/lib/i18n/dicionario";
import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";
import { LIMITE_DO_INTERVALO } from "@/lib/kanban/calendario-do-funil";
import {
  CODIGO_DATA_DE_CALENDARIO_INVALIDA,
  datasDosNegociosQuerySchema,
  recusaDeCalendario,
} from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Quantos negócios a camada lê por vez.
 *
 * Não é paginação: é o teto de um desenho, e vale para os negócios com data
 * DENTRO da janela (ver o cabeçalho). Quando a janela passa dele, `truncado: true`
 * diz na tela que falta coisa — e a resposta honesta é dividir o funil ou
 * estreitar o período, não carregar o funil inteiro para descobrir.
 */
export const NEGOCIOS_POR_LEITURA = 500;

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
  const consulta = datasDosNegociosQuerySchema.safeParse({
    pipeline_id: params.get("pipeline_id") ?? undefined,
    campo: params.get("campo") ?? undefined,
    campo_fim: params.get("campo_fim") ?? undefined,
    de: params.get("de") ?? undefined,
    ate: params.get("ate") ?? undefined,
  });
  if (!consulta.success) {
    // O dia que não existe no calendário é recusa PRÓPRIA, e não
    // `validation_error`: a tela precisa do motivo para esquecer a escolha em
    // vez de mostrar grade vazia. As duas acontecem antes de qualquer consulta.
    if (recusaDeCalendario(consulta.error)) {
      return fail(CODIGO_DATA_DE_CALENDARIO_INVALIDA, t("Data de calendário inválida."), 422, {
        requestId,
        details: consulta.error.flatten().fieldErrors as Record<string, unknown>,
      });
    }
    // Funil/campo ausentes mantêm a frase de sempre; o resto é "período
    // inválido" — a mesma distinção de mensagem que a leitura manual fazia.
    const faltaEscolha = consulta.error.issues.some(
      (issue) => issue.path[0] === "pipeline_id" || issue.path[0] === "campo",
    );
    return fail(
      "validation_error",
      t(faltaEscolha ? "Informe o funil e o campo de data." : "Período inválido."),
      422,
      { requestId, details: consulta.error.flatten().fieldErrors as Record<string, unknown> },
    );
  }
  const { pipeline_id: pipelineId, campo, campo_fim: campoFim, de, ate } = consulta.data;

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

  const colunaInicio = `custom_fields->>${campo}`;
  const fimExclusivo = diasAntes(ate, -1);

  /**
   * A consulta dos negócios.
   *
   * `neq("status", "archived")` pela mesma razão do quadro: negócio arquivado não
   * é operação viva, e a Agenda é sobre o que acontece. O `not` deixa de fora
   * quem não preencheu o campo — é o caso que a tela tem de NÃO mostrar, e
   * filtrar aqui evita trazer linha que a camada jogaria fora.
   */
  const baseDaConsulta = supabase
    .from("crm_leads")
    .select("id, title, pipeline_id, stage_id, custom_fields")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .neq("status", "archived")
    .not(colunaInicio, "is", null)
    .lt(colunaInicio, fimExclusivo);

  // A chave interpolada no `or` já passou pelo schema e foi conferida no funil.
  const colunaFim = final ? `custom_fields->>${final.key}` : null;
  const naJanela = colunaFim
    ? baseDaConsulta
        .gte(colunaInicio, diasAntes(de, LIMITE_DO_INTERVALO))
        .or(`${colunaInicio}.gte.${de},and(${colunaFim}.gte.${de},${colunaFim}.lt.${fimExclusivo})`)
    : baseDaConsulta.gte(colunaInicio, de);

  const { data: linhas, error: leadsErr } = await naJanela
    .order(colunaInicio)
    .order("id")
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

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  MINIMO_DE_CASOS,
  calcularTaxas,
  type AtividadeDaEtapa,
  type Janela,
} from "@/lib/metrics/taxa-da-etapa";
import {
  agregarPorEtapa,
  type EtapaMedida,
  type LeadEmMedicao,
} from "@/lib/metrics/tempo-da-etapa";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/v1/pipelines/[id]/stages/win-rates — a taxa histórica de ganho de
 * CADA etapa, com a amostra junto (issue #1753).
 *
 * Só LEITURA, e isso é o ponto da proposta: `crm_stages.win_probability` nasce
 * vazio e o gestor precisa chutar «em Proposta fechamos 40%», quando o sistema
 * já sabe a resposta — é contar quantos dos que passaram por aquela etapa foram
 * ganhos. Aqui a conta chega à tela; quem ACEITA o número é quem opera, pelo
 * caminho de edição de etapa que já existe (`PATCH …/stages/{stageId}`). Nada
 * grava sozinho, nada toca `crm_lead_scores` — o mesmo «gate humano nas
 * decisões que importam» de `VISION.md`, e o mesmo argumento de
 * `lib/leads/score-formula.ts` (fórmula que um humano pode contestar parcela a
 * parcela, não um oráculo).
 *
 * Auth: sessão por cookie, papel manager+ (é configuração do funil). O
 * `organization_id` sai do JWT, nunca da query string, e viaja nos DOIS SELECT
 * — o filtro explícito é a convenção do repo e a rede que sobra se a policy
 * mudar.
 *
 * A janela é declarada NA RESPOSTA (`inicio`, `fim`, `dias`): a doutrina do
 * sistema vivo não publica medida sem a amostra, e sem o período o «39%» seria
 * um número que ninguém consegue contestar.
 *
 * ─── O segundo bloco: a etapa ATUAL (#2032) ────────────────────────────────
 *
 * `taxas` mede quem PASSOU pela etapa na janela (passagens reconstruídas das
 * atividades `stage_changed`). `tempo_na_etapa` mede quem está NA etapa AGORA,
 * por `crm_leads.stage_changed_at` com `created_at` de reserva — nunca por
 * `last_activity_at`, que é tempo sem resposta (a mesma escolha do card no
 * #1908). São populações diferentes e o payload diz qual é qual (`medida`,
 * `base`): a segunda não preenche o critério da primeira, e é publicada ao
 * lado justamente para o gestor não ler «mediana de 40 h» sem saber de que
 * pergunta ela responde.
 */
export const dynamic = "force-dynamic";

/** Padrão da issue: «nos últimos 12 meses». */
const PADRAO_DIAS = 365;
const DIAS_MAXIMOS = 3650;

/**
 * Teto da leitura: até 10 páginas de 1000. `crm_lead_activities` é a tabela
 * mais quente do produto e a janela pode ter mais linhas que isto num funil
 * ativo — daí a resposta trazer `truncado`, para a tela avisar que a contagem é
 * uma AMOSTRA e não o histórico inteiro. Medida pela metade e silenciosa seria
 * pior que medida nenhuma.
 *
 * ⚠️ PAGINADO, não `.limit(10000)`: o PostgREST corta toda resposta em
 * `max_rows` (1000, `supabase/config.toml`) sem erro nenhum — um `.limit` maior
 * que isso devolve 1000 linhas caladas e o `truncado` nunca liga.
 */
const TAMANHO_DA_PAGINA = 1000;
const PAGINAS_MAXIMAS = 10;

/**
 * Teto da leitura dos negócios que estão NA etapa agora (#2032). O PostgREST
 * corta resposta em `max_rows` (1000) sem erro, então o teto é o próprio
 * max_rows e o corte VIAJA NA RESPOSTA (`truncado`): mediana calculada sobre
 * recorte calado seria pior que mediana nenhuma — mesma régua do bloco
 * `truncado` de cima.
 */
const LIMITE_DE_NEGOCIOS = 1000;

/** Uma etapa medida na ETAPA ATUAL — a linha do bloco `tempo_na_etapa`. */
interface LinhaDeTempo {
  etapa_id: string;
  quantidade: number;
  /** Média de horas na etapa; `null` só se a etapa não tiver ninguém. */
  horas_media: number | null;
  /** Mediana de horas — a média puxada por um preso há meses não a substitui. */
  horas_mediana: number | null;
  /** Amostra à vista: quantos medem por carimbo e quantos por reserva. */
  com_carimbo: number;
  sem_carimbo: number;
}

/**
 * O bloco da resposta. `medida` e `base` viajam dentro dele de propósito:
 * publicar «mediana de 40 h» sem dizer que é a etapa ATUAL (fora da janela de
 * `dias`) convidaria o leitor a somar este número ao `taxas`, que é de outra
 * população.
 */
interface BlocoDeTempo {
  medida: "etapa atual";
  ancora: string;
  base: string;
  amostra: number;
  limite: number;
  truncado: boolean;
  etapas: LinhaDeTempo[];
}

function blocoVazio(): BlocoDeTempo {
  return {
    medida: "etapa atual",
    ancora: "crm_leads.stage_changed_at (created_at de reserva)",
    base: "negócios que estão na etapa AGORA — fora da janela de dias",
    amostra: 0,
    limite: LIMITE_DE_NEGOCIOS,
    truncado: false,
    etapas: [],
  };
}

/** Horas com uma casa decimal, como o resto das métricas — e `null` segue `null`. */
function redondo(valor: number | null): number | null {
  if (valor === null) return null;
  return Math.round(valor * 10) / 10;
}

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "pipeline_stages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const bruto = Number(req.nextUrl.searchParams.get("dias"));
  const dias = Number.isInteger(bruto) && bruto >= 1 && bruto <= DIAS_MAXIMOS ? bruto : PADRAO_DIAS;
  const agora = new Date();
  const inicio = new Date(agora.getTime() - dias * 86400000);
  const janela: Janela = { inicio: inicio.toISOString(), fim: agora.toISOString() };

  const supabase = await createClient();

  // As etapas do funil trazem os DOIS papéis: é sabendo qual é a de ganho e
  // qual é a de perda que a conta decide o que é «encerrado».
  const { data: etapas, error: erroEtapas } = await supabase
    .from("crm_stages")
    .select("id, is_won, is_lost, position")
    .eq("organization_id", authz.org.orgId)
    .eq("pipeline_id", id)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (erroEtapas) return fail("internal_error", t("Falha ao listar etapas."), 500, { requestId });

  // Funil sem etapa nenhuma (ou de outra org) não tem o que contar: não lê o
  // histórico à toa, nem os negócios de quem estaria em etapa nenhuma.
  if (!etapas?.length) {
    return ok(
      {
        inicio: janela.inicio,
        fim: janela.fim,
        dias,
        truncado: false,
        minimo_de_casos: MINIMO_DE_CASOS,
        taxas: [],
        tempo_na_etapa: blocoVazio(),
      },
      { requestId },
    );
  }

  // Indexada por `idx_lead_activities_org_type_perf` (organization_id, type,
  // performed_at). Nenhuma tabela nova, nenhum índice novo — a fatia desta issue
  // era exatamente não tocar no banco.
  //
  // Ordem DESCENDENTE: se o teto cortar, sobra o período mais RECENTE, que é
  // onde estão os encerramentos que decidem se um negócio está fechado (mesma
  // escolha de `reports/tags`). O próximo `range` parte do que CHEGOU, não do
  // tamanho pedido, e o fim é provado pelo `count` exato ou por página VAZIA —
  // nunca por página curta (`lib/agenda/protecao-followup.ts`): numa instalação
  // com `max_rows` menor que a página, página curta não é fim.
  const linhas: AtividadeDaEtapa[] = [];
  let totalNaJanela: number | null = null;
  let acabou = false;
  for (let pagina = 0; pagina < PAGINAS_MAXIMAS && !acabou; pagina++) {
    const inicioDaPagina = linhas.length;
    const { data, error, count } = await supabase
      .from("crm_lead_activities")
      .select("lead_id, payload, performed_at", pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", authz.org.orgId)
      .eq("type", "stage_changed")
      .gte("performed_at", janela.inicio)
      .lte("performed_at", janela.fim)
      .order("performed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(inicioDaPagina, inicioDaPagina + TAMANHO_DA_PAGINA - 1);
    if (error) {
      return fail("internal_error", t("Falha ao ler o histórico de etapas."), 500, { requestId });
    }
    if (pagina === 0) totalNaJanela = count;
    const lote = data ?? [];
    linhas.push(...lote);
    acabou = lote.length === 0 || (totalNaJanela !== null && linhas.length >= totalNaJanela);
  }

  // A ETAPA ATUAL (#2032) — leitura SEPARADA da de cima, porque é outra
  // população e outra pergunta: quem está na coluna AGORA pode ter entrado há
  // um ano, fora de qualquer janela de dias. O filtro de org e de funil é o
  // mesmo das irmãs, e a RLS de `crm_leads` (`fn_can_view_lead`) fecha o resto.
  // Só as colunas de espera: ganho e perda acumulam negócios para sempre e, sem
  // este recorte, consumiriam o teto de 1000 antes das etapas abertas. Funil sem
  // coluna de espera não tem o que ler (e `.in` vazio não vai ao PostgREST).
  const etapasDeEspera = etapas.filter((e) => !e.is_won && !e.is_lost).map((e) => e.id);
  const { data: negocios, error: erroNegocios } = etapasDeEspera.length
    ? await supabase
        .from("crm_leads")
        .select("stage_id, stage_changed_at, created_at")
        .eq("organization_id", authz.org.orgId)
        .eq("pipeline_id", id)
        .in("stage_id", etapasDeEspera)
        .limit(LIMITE_DE_NEGOCIOS)
    : { data: [], error: null };
  if (erroNegocios) {
    return fail("internal_error", t("Falha ao ler os negócios das etapas."), 500, { requestId });
  }

  const idsDasEtapas = new Set(etapasDeEspera);
  // `created_at` é NOT NULL na tabela e `stage_changed_at` tem default + backfill
  // desde a 0071; `last_activity_at` NÃO entra na projeção — a rota nem o pede,
  // então não existe caminho por onde a última atividade vire tempo de etapa.
  const emMedicao: LeadEmMedicao[] = ((negocios ?? []) as Array<{
    stage_id: string | null;
    stage_changed_at: string | null;
    created_at: string;
  }>)
    .filter((n) => typeof n.stage_id === "string" && idsDasEtapas.has(n.stage_id))
    .map((n) => ({
      stage_id: n.stage_id,
      stage_changed_at: n.stage_changed_at,
      created_at: n.created_at,
    }));

  // Um só relógio: `janela.fim` é o instante que a resposta já declara como
  // «agora», e duas chamadas de `new Date()` mediriam a mesma tela duas vezes.
  const medicoes: LinhaDeTempo[] = agregarPorEtapa(emMedicao, new Date(janela.fim))
    .filter((m): m is EtapaMedida => m.stageId !== null && idsDasEtapas.has(m.stageId))
    .map((m) => ({
      etapa_id: m.stageId as string,
      quantidade: m.quantidade,
      horas_media: redondo(m.horasMedia),
      horas_mediana: redondo(m.horasMediana),
      com_carimbo: m.comCarimbo,
      sem_carimbo: m.semCarimbo,
    }));

  const tempo: BlocoDeTempo = {
    ...blocoVazio(),
    amostra: emMedicao.length,
    truncado: (negocios ?? []).length >= LIMITE_DE_NEGOCIOS,
    etapas: medicoes,
  };

  return ok(
    {
      inicio: janela.inicio,
      fim: janela.fim,
      dias,
      truncado: !acabou,
      minimo_de_casos: MINIMO_DE_CASOS,
      taxas: calcularTaxas(linhas, etapas, janela),
      tempo_na_etapa: tempo,
    },
    { requestId },
  );
}

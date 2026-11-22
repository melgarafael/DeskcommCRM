/**
 * GET /api/v1/metrics/serie — a evolução dos ganhos no tempo (issue #3024, fatia 1).
 *
 * A tela `/app/metrics` só mostrava número e tabela. Esta rota entrega a
 * TENDÊNCIA: quantos negócios foram ganhos em cada balde de tempo (dia, semana
 * ou mês), para o gráfico de linha e a tabela de baixo. A conta é
 * `agregarGanhos` (`lib/metrics/serie-temporal.ts`); aqui só se lê e se monta.
 *
 * Escopo = a PRÓPRIA RLS, igual às rotas irmãs de métricas: leitura com o client
 * de sessão, então `crm_leads` (`fn_can_view_lead`) filtra sozinho — agent vê os
 * próprios negócios, manager+ a organização (spec 13, decisão G1-06e). A org vem
 * do cookie validado, NUNCA do query. Piso de rota = agent. Read-only ⇒ sem audit.
 *
 * Nenhuma tabela nova, nenhuma migration, nenhuma RPC: a agregação sai de dados
 * que já existem (`closed_at` dos negócios ganhos), a mesma doutrina de
 * `funil/route.ts` e `lost/route.ts`. A janela é SEMIABERTA e o default de 30
 * dias é o mesmo da tabela por atendente.
 *
 * ⚠️ O total NÃO é o `won` somado da tabela por atendente: aquela conta só
 * negócio com responsável (`fn_attendant_metrics`) e segue o filtro de
 * atendente da tela; esta série conta todo ganho visível, com ou sem dono.
 *
 * Os baldes viram no fuso da organização (`organizations.timezone`, via
 * `fusoUtilizavel`): em UTC, o ganho das 23h30 de São Paulo cairia no dia seguinte.
 *
 * ## O recorte por funil (#4918)
 *
 * A conta era o `won` da ORGANIZAÇÃO — e isso mentia num tenant com mais de um
 * funil: todo funil precisa de uma etapa de ganho, então o funil de suporte usa
 * «Resolvido» como ganho e o card somava 7 tickets resolvidos com zero vendas,
 * tudo sob o título «Ganhos por período». O `?pipeline_id=` recorta o MESMO
 * cálculo para um funil; sem ele, os NÚMEROS são exatamente os de antes — a
 * resposta só ganha o campo `funil: null` dizendo que o escopo é a organização.
 *
 * Filtrar por `pipeline_id` do NEGÓCIO já É «ganhos daquele funil»: o `status`
 * é do trigger `fn_crm_lead_close_on_stage` (migration 0426), que o deriva do
 * `is_won` da etapa em que o card está — e a troca de funil só move card
 * `open` (`recusaTrocaDeFunil`, `lib/leads/transfere-para-o-funil.ts`), então
 * nenhum `won` sobrevive num funil de onde não saiu. Ler a etapa de ganho e
 * recortar por `stage_id` daria o mesmo número hoje e mentiria no dia em que o
 * dono mudasse a etapa de ganho do funil: os ganhos antigos, que ficaram na
 * etapa anterior, sumiriam da série.
 *
 * O nome do parâmetro é o `pipeline_id` que o produto já usa — é a coluna de
 * `crm_leads`, o campo da resposta de `metrics/metas` e o filtro do quadro
 * (`useBoard`); nenhuma rota de métrica tinha parâmetro de funil para reusar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import {
  agregarGanhos,
  totalDeGanhos,
  type FechamentoDeGanho,
  type Granularidade,
} from "@/lib/metrics/serie-temporal";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Teto da leitura: até 5 páginas de 1000, acima disso a resposta diz `truncado`.
 * PAGINADO, não `.limit(5000)`: o PostgREST corta toda resposta em `max_rows`
 * (1000, `supabase/config.toml`) sem erro nenhum — um `.limit` maior devolveria
 * 1000 linhas caladas, sem `.order()` ainda por cima de um pedaço arbitrário.
 * Mesma régua de `funil/route.ts` e `lost/route.ts`.
 */
const TAMANHO_DA_PAGINA = 1000;
const PAGINAS_MAXIMAS = 5;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  // Granularidade fora da lista é RECUSADA (422) — nunca tratada como "dia".
  granularidade: z.enum(["dia", "semana", "mes"]).optional(),
  // Recorte por funil (#4918). UUID inválido é 422 na validação, nunca um
  // filtro que "não achou nada" e devolveria zero com cara de resposta.
  pipeline_id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso agent (vê as próprias); a RLS é quem garante o escopo de cada linha.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "metrics",
    role: "agent",
    scope: "mcp:read",
    // O token lê a organização inteira; na sessão um agent vê só os negócios dele.
    tokenRole: "manager",
  });
  if (!authz.ok) return authz.response;
  // Está em PUBLIC_PATHS: o teto do token é a única contagem das chamadas dele.
  const teto = await tetoDeEscritaDoToken(authz, "metrics", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    granularidade: url.searchParams.get("granularidade") ?? undefined,
    pipeline_id: url.searchParams.get("pipeline_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }
  const de = from.toISOString();
  const ate = to.toISOString();
  const granularidade: Granularidade = parsed.data.granularidade ?? "dia";
  const funilId = parsed.data.pipeline_id ?? null;

  // Token: cliente de serviço; o filtro de organização abaixo é a barreira.
  const supabase = authz.supabase;

  // O funil do recorte é conferido NA ORGANIZAÇÃO do chamador: id de outro
  // tenant não vira filtro silencioso (daria zero com cara de "funil sem
  // ganho"), vira 422 com a frase que o produto já usa. `is_archived` NÃO é
  // filtro — ganho de funil arquivado continua sendo ganho do período.
  let funil: { id: string; name: string } | null = null;
  if (funilId) {
    const { data: encontrado, error: funilErr } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", authz.organizationId)
      .eq("id", funilId)
      .maybeSingle();
    if (funilErr) return fail("internal_error", funilErr.message, 500, { requestId });
    if (!encontrado) return fail("validation_failed", t("Funil não encontrado."), 422, { requestId });
    // Só id e nome saem na resposta: o resto da linha do funil não é do card.
    funil = { id: (encontrado as { id: string }).id, name: (encontrado as { name: string }).name };
  }

  // Falha ABERTA no fuso, como `fusoDaOrganizacao`: leitura que falha ou valor
  // que o `Intl` recusa caem no padrão do produto — um dia de diferença na
  // borda é melhor que o card não abrir.
  const { data: organizacao } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", authz.organizationId)
    .maybeSingle();
  const fuso = fusoUtilizavel((organizacao as { timezone?: string | null } | null)?.timezone);

  // Ordem DESCENDENTE: se o teto cortar, sobra o período mais RECENTE. O fim é
  // provado pelo `count` exato ou por página VAZIA — nunca por página curta
  // (`max_rows` pode ser menor que a página).
  const ganhos: FechamentoDeGanho[] = [];
  let totalNaJanela: number | null = null;
  let acabou = false;
  for (let pagina = 0; pagina < PAGINAS_MAXIMAS && !acabou; pagina++) {
    const inicio = ganhos.length;
    const naOrganizacao = supabase
      .from("crm_leads")
      .select("closed_at", pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", authz.organizationId)
      .eq("status", "won");
    // O recorte por funil entra AQUI, no mesmo pedido: a janela, a ordem e o
    // `count` exato valem para o conjunto recortado, então `truncado` continua
    // dizendo a verdade sobre o que a série mostra.
    const { data, error, count } = await (funilId
      ? naOrganizacao.eq("pipeline_id", funilId)
      : naOrganizacao
    )
      .gte("closed_at", de)
      .lt("closed_at", ate)
      .order("closed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(inicio, inicio + TAMANHO_DA_PAGINA - 1);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if (pagina === 0) totalNaJanela = count;
    const lote = (data ?? []) as FechamentoDeGanho[];
    ganhos.push(...lote);
    acabou = lote.length === 0 || (totalNaJanela !== null && ganhos.length >= totalNaJanela);
  }

  const baldes = agregarGanhos(ganhos, { from: de, to: ate }, granularidade, fuso);

  return ok(
    {
      window: { from: de, to: ate },
      granularidade,
      baldes,
      // O total é a SOMA dos baldes: o título do card e a tabela de baldes
      // mostram os dois, então eles não podem divergir.
      total: totalDeGanhos(baldes),
      truncado: !acabou,
      // O ESCOPO do número (#4918): o funil recortado, com o nome que a tela
      // mostra no card; `null` = organização inteira, o comportamento de antes.
      funil,
    },
    { requestId },
  );
}

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
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  agregarGanhos,
  totalDeGanhos,
  type FechamentoDeGanho,
  type Granularidade,
} from "@/lib/metrics/serie-temporal";
import { createClient } from "@/lib/supabase/server";
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
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso agent (vê as próprias); a RLS é quem garante o escopo de cada linha.
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    granularidade: url.searchParams.get("granularidade") ?? undefined,
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

  const supabase = await createClient();

  // Falha ABERTA no fuso, como `fusoDaOrganizacao`: leitura que falha ou valor
  // que o `Intl` recusa caem no padrão do produto — um dia de diferença na
  // borda é melhor que o card não abrir.
  const { data: organizacao } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", activeOrg.orgId)
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
    const { data, error, count } = await supabase
      .from("crm_leads")
      .select("closed_at", pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "won")
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
    },
    { requestId },
  );
}

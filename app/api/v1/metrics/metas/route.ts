/**
 * GET /api/v1/metrics/metas — a meta do mês e o progresso contra ela
 * (issue #3025, fatia 1).
 *
 * ─── A pergunta que a tela não sabia responder ──────────────────────────────
 * O Desempenho mostrava só o realizado. "Estamos em quantos por cento da meta?"
 * não tinha resposta porque não havia DENOMINADOR: o alvo vivia na cabeça de
 * quem cobra o time. Esta rota lê o alvo cadastrado (`crm_metas`, migration
 * 0756) e conta o realizado na MESMA janela — nunca em janelas diferentes, que
 * fechariam a conta errado na virada do mês.
 *
 * ─── O realizado é "negócio GANHO fechado dentro da janela" ─────────────────
 * `status = 'won'` e `closed_at` em `[from, to)` — o par que a tela chama de
 * venda. Não é `created_at` (o negócio pode ter nascido em julho e fechado em
 * setembro; a venda é de setembro). A leitura é com o client de sessão, então a
 * RLS escopa a organização por si.
 *
 * ─── A META EM VALOR (fatia 2, issue #4796) ─────────────────────────────────
 * Uma meta com `indicador = 'valor_vendido'` tem `alvo` em CENTAVOS da moeda da
 * organização, e o realizado é a soma de `value_cents` dos MESMOS ganhos da
 * MESMA janela — a régua de `lib/metrics/meta-em-valor.ts`, nunca uma segunda.
 * Meta antiga, sem indicador, continua valendo por QUANTIDADE: o indicador
 * desconhecido normaliza para `vendas_ganhas`, que era o único que existia.
 *
 * Valor nulo/zero não vira "venda de R$ 0" (o módulo conta esses cards como
 * ignorados) e ganho em outra moeda não entra na soma — o alvo está na moeda da
 * organização, e câmbio inventado produziria um número que não existe.
 *
 * ─── Contagem por `count` exato, não por linhas ─────────────────────────────
 * `.select("id", { count: "exact", head: true })`: o PostgREST conta no banco e
 * devolve só o número. Trazer as linhas para contar daria 1000 no teto do
 * `max_rows` (`supabase/config.toml`) e um mês com 1.200 vendas apareceria como
 * 1.000 — o truncamento silencioso que a rota de funil documenta em `lerPaginado`.
 *
 * ─── Sem meta NÃO é zero ────────────────────────────────────────────────────
 * Sem linha em `crm_metas`, a resposta sai com `metas: []`, `motivo:
 * "sem_meta"` e uma `explicacao`. Zero significaria "realizou nada", que é uma
 * afirmação FALSA — a empresa pode ter vendido 30 e simplesmente não ter alvo.
 * A explicação sai no idioma de quem pediu (o `t` de sempre), porque quem a
 * escreveu foi o servidor.
 *
 * ─── As duas parcelas do período (fatia 2, item 1, da #3602) ────────────────
 * A meta continua contando VENDAS GANHAS, e valor não entra no percentual. Ao
 * lado dela a rota passa a devolver `valores_do_periodo`: "vendido único"
 * (`value_cents`) e "recorrência nova mensal" (`recurring_value_cents` dos
 * ganhos com `recurring_period = 'monthly'`), SEPARADOS, mais a contagem de
 * negócios com recorrência. Nada é somado entre as duas parcelas — a régua é
 * `lib/metrics/valores-do-periodo.ts`, a mesma que o funil usa. Aditivo e
 * retrocompatível: quem não preenche recorrência recebe zero nos dois números e
 * o resto da resposta é o de antes. Sai mesmo sem meta cadastrada: "não há
 * alvo" não é motivo para esconder quanto entrou no mês.
 *
 * A org vem do cookie validado (`requireRole`) ou da LINHA do token, NUNCA do
 * query. Read-only ⇒ sem audit.
 *
 * Sessão OU token de servidor `dsk_…` com `mcp:read` (Spec 33, R3). A meta é da
 * empresa/funil, mas o realizado vem de `crm_leads`, que na sessão a RLS recorta
 * por atendente; o token lê a organização inteira, então exige `manager`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import {
  INDICADORES_DE_META,
  normalizarIndicador,
  progressoDaMeta,
  projetarFimDaJanela,
  somarValorRealizado,
} from "@/lib/metrics/meta-em-valor";
import { moedaDaOrganizacao } from "@/lib/metrics/moeda-da-organizacao";
import { type NegocioComValor, separarValoresDoPeriodo } from "@/lib/metrics/valores-do-periodo";
import { lerPaginado } from "@/lib/supabase/pagina";

export const dynamic = "force-dynamic";

/** O negócio como a soma em valor precisa dele, além do que as parcelas usam. */
type NegocioDaLeitura = NegocioComValor & {
  pipeline_id?: string | null;
  owner_user_id?: string | null;
};

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

interface MetaCrua {
  id: string;
  periodo: string;
  indicador: string;
  pipeline_id: string | null;
  vendedor_id: string | null;
  alvo: number | string;
}

interface LinhaCrua {
  id: string;
  name: string;
}

/**
 * O 1º dia do mês da janela pedida, como `YYYY-MM-01`.
 *
 * Sai do TEXTO da ISO, não do instante convertido para UTC: a string carrega o
 * fuso de quem pediu (`2026-09-01T00:00:00-03:00`), e é o mês DELE que a meta
 * precisa casar. Converter para UTC faria quem está em UTC+13 pedir setembro e
 * receber a meta de agosto.
 */
function primeiroDiaDoMes(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso agent: o atendente vê a meta da empresa — é o número que a tela dele
  // mostra. A escrita é que exige manager (policy da tabela + Server Action).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "metrics",
    role: "agent",
    scope: "mcp:read",
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
    : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }
  const de = from.toISOString();
  const ate = to.toISOString();
  // O mês vem do TEXTO da janela quando ela foi pedida (a string carrega o fuso
  // de quem pediu); sem `from`, cai no mês corrente do servidor.
  const periodo = parsed.data.from
    ? primeiroDiaDoMes(parsed.data.from)
    : `${de.slice(0, 7)}-01`;

  const supabase = authz.supabase;
  const orgId = authz.organizationId;

  // As metas do MÊS (o da janela) na organização ativa. `pipeline_id is null` é
  // a meta da empresa e vem primeiro; metas por funil (fatia seguinte) também
  // são lidas se existirem — mostrar o que está gravado é mais honesto do que
  // esconder por causa do recorte da fatia.
  const { data: metasCruas, error: erroMetas } = await supabase
    .from("crm_metas")
    .select("id, periodo, indicador, pipeline_id, vendedor_id, alvo")
    .eq("organization_id", orgId)
    .eq("periodo", periodo)
    .in("indicador", [...INDICADORES_DE_META]);
  if (erroMetas) {
    return fail("internal_error", `crm_metas: ${erroMetas.message}`, 500, { requestId });
  }
  const metas = (metasCruas ?? []) as MetaCrua[];

  const funisComMeta = metas.map((m) => m.pipeline_id).filter((p): p is string => Boolean(p));
  let nomesDeFunil = new Map<string, string>();
  if (funisComMeta.length > 0) {
    const { data: funis, error } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", orgId);
    if (error) return fail("internal_error", `crm_pipelines: ${error.message}`, 500, { requestId });
    nomesDeFunil = new Map(((funis ?? []) as LinhaCrua[]).map((f) => [f.id, f.name]));
  }

  // ─── Os ganhos da janela, em LINHAS, para VALOR e para as duas parcelas ──
  //
  // A contagem por `head: true` não traz linha nenhuma e por isso não serve
  // para somar valor. Esta leitura é própria e é PAGINADA: sem `.range()` o
  // PostgREST corta a resposta em `max_rows` (1000) sem erro nenhum, e um mês
  // com 1.200 vendas apareceria como se fossem 1.000. `truncado` viaja na
  // resposta para ninguém ler um piso como se fosse o total — e uma meta em
  // valor soma exatamente estas linhas, não outras.
  const moeda = await moedaDaOrganizacao(orgId);
  const leituraDeValores = await lerPaginado<NegocioDaLeitura>((inicio, fim, contar) =>
    supabase
      .from("crm_leads")
      .select(
        "status, closed_at, pipeline_id, owner_user_id, currency, value_cents, recurring_value_cents, recurring_period",
        contar ? { count: "exact" } : undefined,
      )
      .eq("organization_id", orgId)
      .eq("status", "won")
      .gte("closed_at", de)
      .lt("closed_at", ate)
      .order("closed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(inicio, fim),
  );
  if (leituraDeValores.erro) {
    return fail("internal_error", `crm_leads: valores do período: ${leituraDeValores.erro}`, 500, {
      requestId,
    });
  }

  const janela = { from: de, to: ate };
  const agora = new Date();

  const saida: Array<Record<string, unknown>> = [];
  for (const meta of metas) {
    const alvo = Number(meta.alvo);
    const indicador = normalizarIndicador(meta.indicador);
    // Linha impossível pelo schema (`crm_metas_alvo_positivo`, `alvo > 0`):
    // se chegar aqui, NÃO se inventa percentual nem se mostra 0% — a resposta
    // é uma falha de dados, não uma medida.
    if (!Number.isInteger(alvo) || alvo <= 0) {
      return fail(
        "internal_error",
        `crm_metas: alvo inválido (${String(meta.alvo)}) na meta ${meta.id}`,
        500,
        { requestId },
      );
    }

    let realizado: number;
    if (indicador === "valor_vendido") {
      // A MESMA régua de janela da contagem, aplicada de novo sobre as linhas:
      // `won` + `closed_at` em `[from, to)`. O recorte por vendedor e por funil
      // é o da meta — nada de janela própria.
      realizado = somarValorRealizado({
        negocios: leituraDeValores.linhas,
        janela,
        moeda,
        pipelineId: meta.pipeline_id,
        vendedorId: meta.vendedor_id,
      }).centavos;
    } else {
      let consulta = supabase
        .from("crm_leads")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "won")
        .gte("closed_at", de)
        .lt("closed_at", ate);
      if (meta.pipeline_id) consulta = consulta.eq("pipeline_id", meta.pipeline_id);
      if (meta.vendedor_id) consulta = consulta.eq("owner_user_id", meta.vendedor_id);

      const { count, error } = await consulta;
      if (error) return fail("internal_error", `crm_leads: ${error.message}`, 500, { requestId });
      realizado = count ?? 0;
    }

    const progresso = progressoDaMeta({ alvo, realizado });

    saida.push({
      id: meta.id,
      // O vendedor manda no rótulo: a meta dele é a mais estreita das três.
      escopo: meta.vendedor_id ? "vendedor" : meta.pipeline_id ? "funil" : "empresa",
      indicador,
      pipeline_id: meta.pipeline_id,
      pipeline_nome: meta.pipeline_id ? (nomesDeFunil.get(meta.pipeline_id) ?? null) : null,
      vendedor_id: meta.vendedor_id,
      // Em valor, o número está em CENTAVOS da moeda da organização; em
      // quantidade, `moeda` não se aplica (null).
      moeda: indicador === "valor_vendido" ? moeda : null,
      alvo,
      realizado,
      percentual: progresso.percentual,
      // "Quanto falta" nunca é negativo: passar da meta não vira dívida.
      falta: progresso.falta,
      atingida: progresso.atingida,
      // Projeção até o fim da janela no ritmo medido. `null` quando não há o
      // que projetar (janela passada ou futura) — nada de número inventado.
      projecao: projetarFimDaJanela({ realizado, janela, agora }),
      // Em quantidade a contagem é `count` exato do banco (nunca piso); em
      // valor a soma vem das linhas lidas, e o piso é declarado.
      realizado_truncado: indicador === "valor_vendido" ? leituraDeValores.truncado : false,
    });
  }

  const valoresDoPeriodo = separarValoresDoPeriodo({
    negocios: leituraDeValores.linhas,
    janela,
    moedaDaOrganizacao: moeda,
    truncado: leituraDeValores.truncado,
  });

  const semMeta = saida.length === 0;
  // O indicador no topo só existe quando as metas do mês são todas do mesmo
  // tipo; com quantidade e valor no mesmo mês, o campo sai `null` e a verdade
  // está em cada meta. (Antes da #4796 havia um valor só, fixo.)
  const indicadores = Array.from(
    new Set(saida.map((m) => String(m.indicador))),
  ) as string[];

  return ok(
    {
      window: { from: de, to: ate },
      periodo,
      indicador: indicadores.length === 1 ? indicadores[0] : null,
      indicadores,
      metas: saida,
      // Duas parcelas SEPARADAS (nunca um total): o painel mostra as duas lado
      // a lado, e a org sem recorrência recebe zero nos dois sem nada mudar.
      valores_do_periodo: valoresDoPeriodo,
      motivo: semMeta ? "sem_meta" : null,
      explicacao: semMeta
        ? t(
            "A empresa ainda não definiu a meta deste mês. Quem administra pode cadastrá-la em Configurações › Meta de vendas — a partir daí esta tela mostra o quanto já foi feito e o quanto falta.",
          )
        : null,
    },
    { requestId },
  );
}

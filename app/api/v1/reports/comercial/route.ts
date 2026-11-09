/**
 * GET /api/v1/reports/comercial — o painel de RELATÓRIOS COMERCIAIS da #4280.
 *
 * ─── O que esta rota responde, e o que ela NÃO responde ─────────────────────
 *
 * Os três números escritos no corpo da issue: quanto vendemos no período
 * (`faturamento_centavos`), quais tags representam mais vendas (`tags`) e quais
 * clientes estão comprando (`clientes`). A definição de cada um — coluna, quais
 * estados contam, qual data, desempate, limite e o que fica de fora — está em
 * `lib/relatorios/comercial.ts`, no cabeçalho, e é o contrato desta rota.
 *
 * Não há funil, conversão, meta nem ticket médio aqui: são outras perguntas, com
 * outras rotas (`/metrics/funil`, `/metrics/metas`).
 *
 * ─── SÓ LEITURA ─────────────────────────────────────────────────────────────
 *
 * Um `GET` com client de SESSÃO: a RLS de `crm_leads` (`fn_can_view_lead`) e de
 * `contacts` recorta o que cada pessoa vê — atendente vê os próprios negócios,
 * gestor vê a organização. O `organization_id` vai explícito em toda consulta
 * (a doutrina manda o inquilino dito em voz alta), e a org vem do cookie
 * validado em `requireRole`, NUNCA da query. Read-only ⇒ sem audit.
 *
 * ─── QUANTAS CONSULTAS A TELA FAZ: DUAS ─────────────────────────────────────
 *
 *   1. os negócios GANHOS da janela — uma consulta paginada (`lerPaginado`):
 *      no pior caso são 5 páginas da MESMA consulta, e o `truncado` avisa;
 *      o nome do contato vem EMBUTIDO no mesmo pedido
 *      (`contacts!crm_leads_contact_id_fkey`), então não existe uma segunda
 *      leitura por cliente;
 *   2. a contagem de ganhos SEM `closed_at` (`head: true`), que é o dado
 *      ausente declarado em `excluidos.sem_data_de_ganho`.
 *
 * Nenhuma das duas cresce com o número de tags ou de clientes: somar por tag e
 * por contato é feito UMA vez, em memória, sobre as linhas já lidas. N+1 aqui
 * seria uma consulta por tag — não existe.
 *
 * ─── Sem migration, sem RPC ─────────────────────────────────────────────────
 *
 * A fatia proíbe tabela e migration; logo não há `fn_relatorio_comercial`. A
 * agregação é feita no módulo puro sobre TODAS as linhas da janela (paginadas,
 * com `count` exato e `truncado` declarado) — a mesma doutrina que
 * `/reports/tags` registrou: sem função no banco, a conta mora na aplicação e o
 * corte é DITO, nunca silencioso. `sum()` no banco seria melhor; exige a
 * migration que esta fatia não pode criar.
 *
 * ─── Período no fuso da ORGANIZAÇÃO ─────────────────────────────────────────
 *
 * `de`/`ate` são dias CIVIS no fuso de `organizations.timezone`, e o intervalo
 * no banco é `[início de 'de', início do dia seguinte a 'ate')` — o `ate` entra
 * inteiro e a virada da meia-noite não conta duas vezes. Sem `de`/`ate` o
 * período é o mês corrente até hoje, e a resposta marca `padrao: true`. Teto:
 * `DIAS_MAXIMOS` (366) — acima disso é 422, não um relatório que varre a
 * história inteira.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  DIAS_MAXIMOS,
  diasDeJanela,
  janelaDoRelatorio,
  periodoPadrao,
} from "@/lib/relatorios/janela";
import {
  montarRelatorioComercial,
  type ContatoDoRelatorio,
  type NegocioBruto,
  type RespostaDoRelatorioComercial,
} from "@/lib/relatorios/comercial";
import { lerPaginado } from "@/lib/supabase/pagina";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Moeda de reserva quando a organização não declara a própria. */
const MOEDA_PADRAO = "BRL";

/**
 * O nome do contato vem no MESMO pedido (recurso embutido pelo FK). É o que
 * dispensa a segunda consulta por cliente — e o motivo de o número de consultas
 * da tela ser fixo.
 */
const SELECT_DE_NEGOCIOS =
  "id, status, value_cents, currency, contact_id, tags, closed_at, contacts!crm_leads_contact_id_fkey(id, display_name, name, phone_number)";

/**
 * A linha como o recurso embutido do contato chega. O PostgREST tipa o lado
 * "muitos" como lista mesmo com `contact_id` único; a leitura aceita as duas
 * formas e normaliza (uma linha com contato sempre traz exatamente um).
 */
interface NegocioComContato extends NegocioBruto {
  contacts: ContatoDoRelatorio | ContatoDoRelatorio[] | null;
}

const querySchema = z.object({
  // `iso.date` confere o CALENDÁRIO, não só o formato: `2026-99-99` passava no
  // regex e virava `NaN` dias, furando o teto de 366.
  de: z.iso.date({ message: "Data inicial inválida." }).optional(),
  ate: z.iso.date({ message: "Data final inválida." }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso `viewer`: é leitura, e quem restringe por pessoa é a RLS.
  const authz = await requireRole("viewer", {
    requestId,
    resource: "reports",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    de: url.searchParams.get("de") ?? undefined,
    ate: url.searchParams.get("ate") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: t(i.message),
      })),
      requestId,
    });
  }

  // O fuso é o da ORGANIZAÇÃO: duas pessoas da mesma empresa têm de ver o mesmo
  // mês, e o mês é o da parede da empresa.
  const tz = org.timezone ?? "UTC";
  const padraoSemParametro = !parsed.data.de && !parsed.data.ate;
  const padrao = periodoPadrao(new Date(), tz);
  const deTexto = parsed.data.de ?? padrao.de;
  const ateTexto = parsed.data.ate ?? padrao.ate;

  if (deTexto > ateTexto) {
    // Invertido devolveria zero em tudo, e zero lê como "não vendemos nada" — a
    // resposta errada mais convincente que este relatório pode dar.
    return fail("validation_failed", t("A data inicial é depois da final."), 422, { requestId });
  }

  const dias = diasDeJanela(deTexto, ateTexto);
  if (dias > DIAS_MAXIMOS) {
    // A frase não carrega o número (template em `t()` não tem tradução): o
    // teto vai em `details`, que é dado, e a mensagem é literal traduzível.
    return fail("validation_failed", t("O período é maior do que este relatório cobre."), 422, {
      details: { maximo_dias: DIAS_MAXIMOS },
      requestId,
    });
  }

  const janela = janelaDoRelatorio(deTexto, ateTexto, tz);
  const supabase = await createClient();

  // ─── CONSULTA 1: os ganhos da janela (com o contato embutido) ─────────────
  const leitura = await lerPaginado<NegocioComContato>(async (inicio, fim, contar) => {
    const { data, error, count } = await supabase
      .from("crm_leads")
      .select(SELECT_DE_NEGOCIOS, contar ? { count: "exact" } : undefined)
      .eq("organization_id", org.orgId)
      .eq("status", "won")
      .gte("closed_at", janela.from)
      .lt("closed_at", janela.to)
      .order("closed_at", { ascending: false })
      .order("id", { ascending: true })
      .range(inicio, fim);
    return {
      data: (data ?? []) as unknown as NegocioComContato[],
      error,
      count: count ?? null,
    };
  });
  if (leitura.erro) {
    // O erro SOBE: engolir transformaria falha de leitura em "não houve venda".
    return fail("internal_error", leitura.erro, 500, { requestId });
  }

  // ─── CONSULTA 2: quantos ganhos não têm data (o ausente, declarado) ───────
  const semData = await supabase
    .from("crm_leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("status", "won")
    .is("closed_at", null);
  if (semData.error) return fail("internal_error", semData.error.message, 500, { requestId });

  const negocios = leitura.linhas;
  const contatos: Record<string, ContatoDoRelatorio | null> = {};
  for (const negocio of negocios) {
    if (!negocio.contact_id) continue;
    const embutido = negocio.contacts;
    contatos[negocio.contact_id] = Array.isArray(embutido) ? (embutido[0] ?? null) : (embutido ?? null);
  }

  const relatorio = montarRelatorioComercial({
    negocios,
    moedaDaOrganizacao: org.currency?.trim() || MOEDA_PADRAO,
    janela,
    padrao: padraoSemParametro,
    semDataDeGanho: semData.count ?? 0,
    truncado: leitura.truncado,
  });

  const corpo: RespostaDoRelatorioComercial = { ...relatorio, contatos };
  return ok(corpo, { requestId });
}

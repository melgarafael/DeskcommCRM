/**
 * O VALOR DO NEGÓCIO NO PUSH — quanto entrou agora, e quanto entrou hoje.
 *
 * ─── O que havia ────────────────────────────────────────────────────────────
 *
 * O push da etapa que avisa chegava como «Negócio entrou em «Pago»» com uma
 * frase fixa no corpo; o do ganho, como «Lead ganho» com o título do negócio.
 * Nenhum dos dois dizia o VALOR — que é a primeira pergunta de quem recebe um
 * aviso de venda com o CRM fechado no bolso, e que o negócio já guarda
 * (`crm_leads.value_cents` + `currency`).
 *
 * ─── O que passa a chegar ───────────────────────────────────────────────────
 *
 *     Negócio entrou em «Pago» · R$ 1.250,00
 *     Hoje nesta etapa: 3 (R$ 3.750,00)
 *
 * O valor vai no TÍTULO, porque é o que se lê na tela bloqueada sem abrir
 * nada; a soma do dia vai no corpo. A moeda é a do negócio, nunca uma fixa: a
 * soma conta só os negócios na MESMA moeda deste (somar real com dólar daria
 * um número que não existe), e "hoje" começa à meia-noite do fuso da
 * organização — o push sai sem ninguém logado.
 *
 * ─── O que NÃO entra ────────────────────────────────────────────────────────
 *
 * Nenhum dado de cliente além do que cada push já levava: o da etapa segue sem
 * nome (`./push-dos-avisos.ts`), e o do ganho segue com o título do negócio,
 * como antes. Leitura que falha nunca derruba o push: ele sai sem o resumo.
 *
 * Nenhum número de negócio que quem recebe não veria na tela. As leituras são
 * do service role, que não passa pela RLS: o escopo de `fn_can_view_lead` (o
 * papel e o `visibility_mode` da organização) é reaplicado aqui, em
 * `escopoDoPapel`. Quem não vê a organização inteira soma só o que é dele (e o
 * sem dono, no modo padrão).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { DEFAULT_VISIBILITY_MODE, VISIBILITY_MODES, type VisibilityMode } from "@/lib/auth/types";
import { formatValorDoNegocio } from "@/lib/money";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export type ValorDoNegocio = { readonly cents: number; readonly moeda: string };

export type ResumoDoDia = { readonly quantidade: number; readonly totalCents: number };

type LinhaDeValor = { value_cents?: number | string | null; currency?: string | null };

/**
 * Os negócios que alguém enxerga: `null` é a organização inteira; senão, os
 * dele e, com `semDono`, os sem dono.
 */
export type EscopoDosNegocios = { readonly dono: string; readonly semDono: boolean } | null;

/**
 * O `visibility_mode` gravado, lido como `fn_can_view_lead` lê: ausente é o
 * padrão, e um valor que ela não conhece restringe ao próprio (`'own'`).
 */
export function modoDeVisibilidade(settings: unknown): VisibilityMode {
  const modo = (settings as { visibility_mode?: unknown } | null)?.visibility_mode;
  if (modo === null || modo === undefined) return DEFAULT_VISIBILITY_MODE;
  return (VISIBILITY_MODES as readonly unknown[]).includes(modo) ? (modo as VisibilityMode) : "own";
}

/** A régua de `fn_can_view_lead`, para quem recebe o push. */
export function escopoDoPapel(papel: string | null, modo: VisibilityMode, userId: string): EscopoDosNegocios {
  if (papel === "viewer" || papel === "manager" || papel === "admin" || modo === "all") return null;
  return { dono: userId, semDono: modo === "own_and_unassigned" };
}

/**
 * O escopo de `userId` na organização. Leitura do papel que falha restringe ao
 * próprio: na dúvida, o push diz menos, nunca mais.
 */
export async function escopoDeQuemRecebe(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  modo: VisibilityMode,
): Promise<EscopoDosNegocios> {
  if (modo === "all") return null;
  try {
    const { data, error } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle();
    const papel = error ? null : ((data as { role?: string | null } | null)?.role ?? null);
    return escopoDoPapel(papel, modo, userId);
  } catch {
    return escopoDoPapel(null, modo, userId);
  }
}

/** O valor do negócio, ou `null` quando ele não tem valor (ou não tem moeda). */
export function valorDoNegocio(linha: LinhaDeValor | null | undefined): ValorDoNegocio | null {
  const cents = Number(linha?.value_cents ?? 0);
  const moeda = linha?.currency?.trim();
  if (!Number.isFinite(cents) || cents <= 0 || !moeda) return null;
  return { cents, moeda };
}

/** `Negócio entrou em «Pago» · R$ 1.250,00` — sem valor, o título fica como era. */
export function tituloComValor(titulo: string, valor: ValorDoNegocio | null): string {
  return valor ? `${titulo} · ${formatValorDoNegocio(valor.cents, valor.moeda)}` : titulo;
}

/**
 * A linha do dia: `Hoje nesta etapa: 3 (R$ 3.750,00)`. `frase` chega JÁ
 * traduzida por quem chama, com `{quantidade}` no lugar do número: a frase
 * inteira é a chave de tradução (a ordem das palavras muda entre idiomas), e o
 * literal fica no ramo de quem chama, onde a cerca de i18n o enxerga. Sem
 * resumo, ou com zero, não há linha.
 */
export function linhaDoDia(frase: string, hoje: ResumoDoDia | null, moeda: string | null): string | null {
  if (!hoje || hoje.quantidade <= 0) return null;
  const contagem = frase.replace("{quantidade}", String(hoje.quantidade));
  if (!moeda || hoje.totalCents <= 0) return contagem;
  return `${contagem} (${formatValorDoNegocio(hoje.totalCents, moeda)})`;
}

/** Meia-noite de hoje, no fuso da organização (fuso inválido cai no padrão). */
export function inicioDoDia(agora: Date, fuso: string | null | undefined): Date {
  const tz = fusoUtilizavel(fuso);
  const p = partesNoFuso(agora, tz);
  return instanteDe({ ano: p.ano, mes: p.mes, dia: p.dia, hora: 0, minuto: 0, segundo: 0 }, tz);
}

function somarNaMoeda(linhas: LinhaDeValor[], moeda: string | null): number {
  if (!moeda) return 0;
  return linhas.reduce((soma, l) => (l.currency === moeda ? soma + (Number(l.value_cents) || 0) : soma), 0);
}

/**
 * Os negócios que entraram HOJE nesta etapa: os avisos com o mesmo título
 * abertos desde a meia-noite, um por negócio (o handler da etapa não empilha
 * iguais, e o mesmo negócio que volta conta uma vez). Soma só a moeda deste.
 *
 * ⚠️ Service role: a organização vai junto em TODA leitura.
 */
export async function entradasDeHoje(
  admin: SupabaseClient,
  orgId: string,
  tituloDoAviso: string,
  moeda: string | null,
  desde: Date,
): Promise<ResumoDoDia | null> {
  try {
    const { data, error } = await admin
      .from("agent_inbox_items")
      .select("ref_id")
      .eq("organization_id", orgId)
      .eq("kind", "other")
      .eq("ref_kind", "lead")
      .eq("title", tituloDoAviso)
      .gte("created_at", desde.toISOString())
      .limit(1000);
    if (error || !data) return null;
    const ids = [
      ...new Set((data as Array<{ ref_id: string | null }>).map((d) => d.ref_id).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return null;
    const { data: leads, error: erroDosNegocios } = await admin
      .from("crm_leads")
      .select("value_cents, currency")
      .eq("organization_id", orgId)
      .in("id", ids);
    if (erroDosNegocios) return { quantidade: ids.length, totalCents: 0 };
    return { quantidade: ids.length, totalCents: somarNaMoeda((leads ?? []) as LinhaDeValor[], moeda) };
  } catch {
    return null;
  }
}

/** Os negócios GANHOS hoje, desde a meia-noite da organização, que `escopo` enxerga. */
export async function ganhosDeHoje(
  admin: SupabaseClient,
  orgId: string,
  moeda: string | null,
  desde: Date,
  escopo: EscopoDosNegocios,
): Promise<ResumoDoDia | null> {
  try {
    let consulta = admin
      .from("crm_leads")
      .select("value_cents, currency")
      .eq("organization_id", orgId)
      .eq("status", "won")
      .gte("closed_at", desde.toISOString());
    if (escopo) {
      consulta = escopo.semDono
        ? consulta.or(`owner_user_id.eq.${escopo.dono},owner_user_id.is.null`)
        : consulta.eq("owner_user_id", escopo.dono);
    }
    const { data, error } = await consulta.limit(1000);
    if (error || !data) return null;
    const linhas = data as LinhaDeValor[];
    if (linhas.length === 0) return null;
    return { quantidade: linhas.length, totalCents: somarNaMoeda(linhas, moeda) };
  } catch {
    return null;
  }
}

/**
 * O IDIOMA EM QUE UM AVISO DA CENTRAL NASCE.
 *
 * A Central mostra `agent_inbox_items.title`/`body` como foram gravados — nunca
 * passam por `t()` na tela —, então quem grava o aviso traduz no instante do
 * insert, pelo `organizations.locale` (o mesmo padrão de
 * `lib/automation/parada-no-assistido.ts` e do `case-stale-watcher`).
 *
 * NUNCA lança: ler o idioma é enfeite comparado ao aviso sair. Banco fora,
 * coluna nula, dublê de teste sem a tabela — tudo cai em `pt-BR`, que é
 * exatamente o texto que o aviso tinha antes.
 */
import { normalizarIdioma, IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

/** O mínimo do cliente Supabase que a leitura usa — aceita o admin real e os dublês. */
interface ClienteComFrom {
  from(tabela: string): unknown;
}

export async function idiomaDoAviso(
  admin: ClienteComFrom,
  organizationId: string | null | undefined,
  cache?: Map<string, Idioma>,
): Promise<Idioma> {
  if (!organizationId) return IDIOMA_PADRAO;
  const guardado = cache?.get(organizationId);
  if (guardado !== undefined) return guardado;
  let idioma: Idioma = IDIOMA_PADRAO;
  try {
    const consulta = admin.from("organizations") as {
      select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => unknown } };
    };
    const resposta = (await consulta.select("locale").eq("id", organizationId).maybeSingle()) as
      | { data?: { locale?: unknown } | null }
      | null
      | undefined;
    const locale = resposta?.data?.locale;
    idioma = normalizarIdioma(typeof locale === "string" ? locale : null);
  } catch {
    idioma = IDIOMA_PADRAO;
  }
  cache?.set(organizationId, idioma);
  return idioma;
}

/**
 * Preenche os `{marcadores}` de uma frase JÁ traduzida, numa passada só.
 *
 * Uma passada, e não `.replace` encadeado, porque os valores são dado (nome de
 * regra, de fluxo, motivo de erro): um nome que contenha `{motivo}` não pode
 * ser trocado pelo `.replace` seguinte. A função de troca também desliga os
 * padrões especiais (`$&`, `$1`) que um valor com `$` ativaria.
 */
export function preencher(texto: string, valores: Readonly<Record<string, string | number>>): string {
  return texto.replace(/\{([A-Za-z_]+)\}/g, (marcador, nome: string) =>
    Object.hasOwn(valores, nome) ? String(valores[nome]) : marcador,
  );
}

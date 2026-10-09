/**
 * GET /api/v1/contacts/duplicates — quem é a MESMA pessoa cadastrada duas vezes.
 *
 * A detecção é PURA (`lib/contacts/duplicados.ts`) e roda aqui, no servidor,
 * sobre a página de contatos vivos que a RLS deixa o usuário ver. Não é um
 * `select` esperto: os três índices únicos parciais de `contacts` já impedem
 * duas linhas ativas com a MESMA string, então o que sobra para o produto é a
 * grafia diferente do mesmo número (o nono dígito) e o telefone que a ingestão
 * do WhatsApp parkou em `source_metadata.telefone_em_conflito`. Nenhum dos dois
 * é comparação de igualdade, e é por isso que a regra vive em TypeScript
 * testável em vez de virar SQL que ninguém relê.
 *
 * `viewer` pode LISTAR (é leitura de contato, que ele já enxerga na tabela);
 * quem funde é `manager`, e esse gate está na rota de POST /contacts/merge.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import {
  encontrarContatosDuplicados,
  principalSugerido,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Teto de linhas varridas.
 *
 * A varredura é O(n) e roda sobre contatos VIVOS — mas ela é uma tela de
 * limpeza, não um relatório: numa base grande, devolver "os 5.000 grupos" não
 * ajuda ninguém a decidir nada e custa memória do contêiner do self-hoster.
 * Quem passa daqui limpa em levas, e a resposta diz que truncou (`varreu_tudo`)
 * em vez de calar — silêncio aqui leria como "não há mais duplicata".
 */
const TETO_DE_VARREDURA = 2000;

/**
 * Tamanho de cada página da varredura.
 *
 * Igual ao `max_rows = 1000` do `supabase/config.toml` — o mesmo teto que o
 * `win-rates` e o relatório de Perdas (#2560) já respeitam. Um `.limit(2001)`
 * NÃO lê 2.001: o PostgREST corta a resposta em `max_rows` sem erro nenhum, e
 * o `varreu_tudo` respondia `true` com a base inteira cortada em 1.000 linhas.
 * Numa instalação com `max_rows` MENOR que esta página, a página curta também
 * não é tratada como fim: o fim é provado pelo `count` exato ou por página
 * VAZIA (`lib/agenda/protecao-followup.ts`).
 */
const TAMANHO_DA_PAGINA = 1000;

const COLUNAS_DO_CONTATO =
  "id, name, display_name, email, email_normalized, phone_number, is_merged_into, is_anonymized, source_metadata, created_at, last_activity_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const user = await loadAuthUser();
  if (!user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const ativa = await orgAtivaDaApi(user, requestId);
  if (!ativa.ok) return ativa.response;
  const org = ativa.org;
  if (!org) {
    const t = (texto: string) => traduzir(texto, user.idioma);
    return fail("forbidden_tenant", t("Organização ativa não resolvida."), 403, { requestId });
  }

  const supabase = await createClient();

  // Varredura PAGINADA por `range`, com ordem estável (`created_at`, `id`): o
  // fim é provado pelo `count` exato ou por página VAZIA. Página curta não é
  // fim — numa instalação com `max_rows` menor que a página, ela vem curta sem
  // ser o fim. O `+1` além do teto é o que prova que existia mais do que a
  // varredura alcança.
  const linhas: ContatoParaDeduplicar[] = [];
  let totalDeVivos: number | null = null;
  let acabou = false;
  for (let pagina = 0; linhas.length <= TETO_DE_VARREDURA && !acabou; pagina++) {
    const inicio = linhas.length;
    const pedaco = Math.min(TAMANHO_DA_PAGINA, TETO_DE_VARREDURA + 1 - linhas.length);
    const { data, error, count } = await supabase
      .from("contacts")
      .select(COLUNAS_DO_CONTATO, pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", org.orgId)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(inicio, inicio + pedaco - 1);
    if (error) {
      return fail("internal_error", error.message, 500, { requestId });
    }
    if (pagina === 0) totalDeVivos = count;
    const lote = (data ?? []) as unknown as ContatoParaDeduplicar[];
    linhas.push(...lote);
    acabou = lote.length === 0 || (totalDeVivos !== null && linhas.length >= totalDeVivos);
  }

  const varreuTudo =
    totalDeVivos !== null ? totalDeVivos <= TETO_DE_VARREDURA : linhas.length <= TETO_DE_VARREDURA;
  const grupos = encontrarContatosDuplicados(linhas.slice(0, TETO_DE_VARREDURA));

  return ok(
    grupos.map((grupo) => ({
      chave: grupo.chave,
      motivos: grupo.motivos,
      principal_sugerido: principalSugerido(grupo),
      contatos: grupo.contatos.map((c) => ({
        id: c.id,
        name: c.name,
        display_name: c.display_name,
        email: c.email,
        phone_number: c.phone_number,
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
      })),
    })),
    { requestId, meta: { varreu_tudo: varreuTudo, contatos_varridos: Math.min(linhas.length, TETO_DE_VARREDURA) } },
  );
}

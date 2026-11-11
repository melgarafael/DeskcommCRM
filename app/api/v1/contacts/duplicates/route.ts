/**
 * GET /api/v1/contacts/duplicates — quem é a MESMA pessoa cadastrada duas vezes.
 *
 * A detecção é PURA (`lib/contacts/duplicados.ts`) e roda aqui, no servidor,
 * sobre a página de contatos vivos que a RLS deixa o usuário ver. Não é um
 * `select` esperto: os índices únicos parciais de `contacts` — telefone, e-mail
 * normalizado e hash de CPF — já impedem duas linhas ativas com a MESMA string,
 * então o que sobra para o produto é a grafia diferente do mesmo número (o nono
 * dígito), o telefone que a ingestão do WhatsApp parkou em
 * `source_metadata.telefone_em_conflito` e a duplicata exata de CPF no clone em
 * que o índice não nasceu (`if not exists` num `update.sh` sem `ON_ERROR_STOP`).
 * Nenhuma dessas é comparação que o índice garante, e é por isso que a regra vive
 * em TypeScript testável em vez de virar SQL que ninguém relê.
 *
 * Há um segundo motivo, que NÃO é igualdade: `nome_parecido` (Spec 31). Ele vem
 * DEPOIS dos fortes, com o mesmo formato, e é sugestão para conferir — o nome
 * sozinho não prova nada. Os pares que a pessoa dispensou ("não são a mesma
 * empresa") saem da lista para todo papel, porque a leitura da dispensa usa o
 * cliente administrador, filtrado pela organização da sessão.
 *
 * ─── O que sai daqui e o que não sai ─────────────────────────────────────────
 * `cpf_hash` é lido pelo SERVIDOR (a comparação precisa dele), só para as fichas
 * que a sessão já viu, e NÃO é devolvido: é PII derivada, e a tela de conferência
 * mostra pessoa, telefone e e-mail — não hash de documento. O mesmo vale para `wa_identity`/`wa_lid`:
 * identificam a CONTA do WhatsApp, não a pessoa para quem se liga; a tela mostra
 * `phone_number`. O mapeamento do
 * `ok(...)` abaixo é a lista fechada do que o cliente recebe; campo novo em
 * `contacts` não vaza por acidente.
 *
 * `viewer` pode LISTAR (é leitura de contato, que ele já enxerga na tabela);
 * quem funde é `manager`, e esse gate está na rota de POST /contacts/merge.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import {
  encontrarContatosDuplicados,
  encontrarParecidosPorNome,
  principalSugerido,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { lerParesDispensados } from "@/lib/contacts/dispensar-par";
import { traduzir } from "@/lib/i18n/dicionario";
    const { data: organizacao, error: erroOrg } = await supabaseAdmin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (erroOrg) throw new Error(erroOrg.message);
    sugestaoPorNome = duplicadosPorNomeLigado(organizacao?.settings);
    dispensados = sugestaoPorNome ? await lerParesDispensados(supabaseAdmin, organizationId) : new Set<string>();
    varridos = await comHashDeCpf(supabaseAdmin, organizationId, linhas.slice(0, TETO_DE_VARREDURA));
contacts/duplicates — quem é a MESMA pessoa cadastrada duas vezes.
 *
 * A detecção é PURA (`lib/contacts/duplicados.ts`) e roda aqui, no servidor,
 * sobre a página de contatos vivos que a RLS deixa o usuário ver. Não é um
 * `select` esperto: os índices únicos parciais de `contacts` — telefone, e-mail
 * normalizado e hash de CPF — já impedem duas linhas ativas com a MESMA string,
 * então o que sobra para o produto é a grafia diferente do mesmo número (o nono
 * dígito), o telefone que a ingestão do WhatsApp parkou em
 * `source_metadata.telefone_em_conflito` e a duplicata exata de CPF no clone em
 * que o índice não nasceu (`if not exists` num `update.sh` sem `ON_ERROR_STOP`).
 * Nenhuma dessas é comparação que o índice garante, e é por isso que a regra vive
 * em TypeScript testável em vez de virar SQL que ninguém relê.
 *
 * Há um segundo motivo, que NÃO é igualdade: `nome_parecido` (Spec 31). Ele vem
 * DEPOIS dos fortes, com o mesmo formato, e é sugestão para conferir — o nome
 * sozinho não prova nada. Os pares que a pessoa dispensou ("não são a mesma
 * empresa") saem da lista para todo papel, porque a leitura da dispensa usa o
 * cliente administrador, filtrado pela organização da sessão.
 *
 * ─── O que sai daqui e o que não sai ─────────────────────────────────────────
 * `cpf_hash` é lido pelo SERVIDOR (a comparação precisa dele), só para as fichas
 * que a sessão já viu, e NÃO é devolvido: é PII derivada, e a tela de conferência
 * mostra pessoa, telefone e e-mail — não hash de documento. O mesmo vale para `wa_identity`/`wa_lid`:
 * identificam a CONTA do WhatsApp, não a pessoa para quem se liga; a tela mostra
 * `phone_number`. O mapeamento do
 * `ok(...)` abaixo é a lista fechada do que o cliente recebe; campo novo em
 * `contacts` não vaza por acidente.
 *
 * `viewer` pode LISTAR (é leitura de contato, que ele já enxerga na tabela);
 * quem funde é `manager`, e esse gate está na rota de POST /contacts/merge.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import {
  encontrarContatosDuplicados,
  encontrarParecidosPorNome,
  principalSugerido,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { lerParesDispensados } from "@/lib/contacts/dispensar-par";
import { traduzir } from "@/lib/i18n/dicionario";
<<<<<<< HEAD
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import type { Idioma } from "@/lib/i18n/idiomas";
=======
import { duplicadosPorNomeLigado } from "@/lib/schemas/settings";
>>>>>>> mc-r-s1
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  "id, name, display_name, address_book_name, email, email_normalized, phone_number, wa_identity, wa_lid, is_merged_into, is_anonymized, source_metadata, created_at, last_activity_at";

/** Cada id custa ~37 caracteres na URL do PostgREST; 100 ficam abaixo do limite comum de 8 KB de um proxy. */
const LOTE_DE_IDS = 100;

/** O CPF de cada ficha, para comparar. A leitura é do servidor, filtrada pela organização da sessão. */
async function comHashDeCpf(
  admin: SupabaseClient,
  orgId: string,
  linhas: Omit<ContatoParaDeduplicar, "cpf_hash">[],
): Promise<ContatoParaDeduplicar[]> {
  const hashPorId = new Map<string, string>();
  for (let inicio = 0; inicio < linhas.length; inicio += LOTE_DE_IDS) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, cpf_hash")
      .eq("organization_id", orgId)
      .in("id", linhas.slice(inicio, inicio + LOTE_DE_IDS).map((c) => c.id))
      .not("cpf_hash", "is", null);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { id: string; cpf_hash: string }[]) hashPorId.set(r.id, r.cpf_hash);
  }
  return linhas.map((c) => ({ ...c, cpf_hash: hashPorId.get(c.id) ?? null }));
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "contacts",
      role: "viewer",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
    if (teto) return teto;
    return responderDuplicates(authz.supabase, authz.organizationId, authz.idioma, requestId);
  }

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

  return responderDuplicates(await createClient(), org.orgId, user.idioma, requestId);
}

async function responderDuplicates(
  supabase: SupabaseClient,
  organizationId: string,
  idioma: Idioma | undefined,
  requestId: string,
): Promise<Response> {
  const t = (texto: string) => traduzir(texto, idioma ?? IDIOMA_PADRAO);

  const supabaseAdmin = createAdminClient();

  // Varredura PAGINADA por `range`, com ordem estável (`created_at`, `id`): o
  // fim é provado pelo `count` exato ou por página VAZIA. Página curta não é
  // fim — numa instalação com `max_rows` menor que a página, ela vem curta sem
  // ser o fim. O `+1` além do teto é o que prova que existia mais do que a
  // varredura alcança.
  const linhas: Omit<ContatoParaDeduplicar, "cpf_hash">[] = [];
  let totalDeVivos: number | null = null;
  let acabou = false;
  for (let pagina = 0; linhas.length <= TETO_DE_VARREDURA && !acabou; pagina++) {
    const inicio = linhas.length;
    const pedaco = Math.min(TAMANHO_DA_PAGINA, TETO_DE_VARREDURA + 1 - linhas.length);
    const { data, error, count } = await supabase
      .from("contacts")
      .select(COLUNAS_DO_CONTATO, pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", organizationId)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(inicio, inicio + pedaco - 1);
    if (error) {
      return fail("internal_error", error.message, 500, { requestId });
    }
    if (pagina === 0) totalDeVivos = count;
    const lote = (data ?? []) as unknown as Omit<ContatoParaDeduplicar, "cpf_hash">[];
    linhas.push(...lote);
    acabou = lote.length === 0 || (totalDeVivos !== null && linhas.length >= totalDeVivos);
  }

  const varreuTudo =
    totalDeVivos !== null ? totalDeVivos <= TETO_DE_VARREDURA : linhas.length <= TETO_DE_VARREDURA;

  // As dispensas e o CPF são lidos com o cliente administrador, filtrado pela
  // organização da SESSÃO (nunca do pedido): a policy de `merge_queue` só deixa gestor
  // ler, e o par dispensado tem de sumir para todo papel que vê esta lista. Se a leitura
  // falhar, a rota falha — mostrar a lista sem as dispensas faria um par tirado voltar
  // calado, e sem o CPF faria o par de mesmo documento sumir sem aviso.
  //
  // A OPÇÃO DA EMPRESA (#4138) é lida na MESMA ida ao banco: `settings.crm.
  // duplicados_por_nome`, desligada por padrão (`duplicadosPorNomeLigado` — só o
  // booleano `true` liga). Desligada, a varredura por nome não roda E as dispensas
  // nem são lidas: o par dispensado só existe para esconder uma sugestão que não
  // existe mais, e ler 5.000 linhas de `merge_queue` para nada é custo sem uso.
  let dispensados: Set<string>;
  let varridos: ContatoParaDeduplicar[];
  let sugestaoPorNome: boolean;
  try {
<<<<<<< HEAD
    dispensados = await lerParesDispensados(supabaseAdmin, organizationId);
    varridos = await comHashDeCpf(supabaseAdmin, organizationId, linhas.slice(0, TETO_DE_VARREDURA));
=======
    const admin = createAdminClient();
    const { data: organizacao, error: erroOrg } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", org.orgId)
      .maybeSingle();
    if (erroOrg) throw new Error(erroOrg.message);
    sugestaoPorNome = duplicadosPorNomeLigado(organizacao?.settings);
    dispensados = sugestaoPorNome ? await lerParesDispensados(admin, org.orgId) : new Set<string>();
    varridos = await comHashDeCpf(admin, org.orgId, linhas.slice(0, TETO_DE_VARREDURA));
>>>>>>> mc-r-s1
  } catch {
    // Sem o detalhe do erro na resposta: a mensagem do banco não é para quem opera a tela.
    return fail("internal_error", "Não foi possível ler os dados de duplicados.", 500, {
      requestId,
    });
  }

  // Os fortes vêm sempre, com o mesmo formato. O nome vem depois, em grupos de
  // dois — sugestão para conferir, não prova — e SÓ se a empresa ligou a opção.
  const grupos = [
    ...encontrarContatosDuplicados(varridos),
    ...(sugestaoPorNome ? encontrarParecidosPorNome(varridos, { dispensados }) : []),
  ];

  return ok(
    grupos.map((grupo) => ({
      chave: grupo.chave,
      motivos: grupo.motivos,
      principal_sugerido: principalSugerido(grupo),
      contatos: grupo.contatos.map((c) => ({
        id: c.id,
        name: c.name,
        display_name: c.display_name,
        address_book_name: c.address_book_name ?? null,
        email: c.email,
        phone_number: c.phone_number,
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
      })),
    })),
    { requestId, meta: { varreu_tudo: varreuTudo, contatos_varridos: Math.min(linhas.length, TETO_DE_VARREDURA), sugestao_por_nome: sugestaoPorNome } },
  );
}

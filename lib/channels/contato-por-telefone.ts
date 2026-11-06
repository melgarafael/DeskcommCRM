/**
 * Reencontra o cadastro pelas grafias do mesmo número (nono dígito BR).
 * Sem isto, captação e WhatsApp viram dois contatos e o follow-up não vê a resposta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR, phoneLookupVariants } from "./phone-variants";

/** O que toda busca por telefone precisa saber para escolher, e mais nada. */
export interface ContatoCandidato {
  id: string;
  phone_number: string | null;
}

/**
 * QUAL DAS GRAFIAS VENCE — a regra, separada da consulta de propósito.
 *
 * ## O defeito que ela fecha
 *
 * A busca era `.in("phone_number", variantes).limit(1)`, **sem `order by`**.
 * `+55 32 8479-3302` e `+55 32 98479-3302` são a mesma pessoa e são DUAS linhas
 * enquanto a fusão da migration `0198` não passou por elas — e sem ordenação o
 * Postgres devolve qualquer uma das duas. Não é hipótese de laboratório: a
 * própria `0198` chama o passo que trata o resto de "piso de segurança para o
 * unique", ou seja, ela já admite que pode sobrar par.
 *
 * O estrago, quando a linha errada volta: a resposta do cliente entra no
 * cadastro errado, o follow-up não a reconhece como resposta, e a mesma
 * pergunta é enviada de novo — exatamente o sintoma que a `0198` existe para
 * acabar.
 *
 * ## Por que a canônica, e por que ela sempre existe no par
 *
 * `canonicalPhoneBR` já define a forma que o CRM grava e mostra: celular BR
 * **com** o nono dígito. Para um par de grafias, `phoneLookupVariants` devolve
 * no máximo duas formas e **uma delas é sempre a canônica** — então preferi-la
 * decide o par inteiro, sem depender de ordenação nenhuma.
 *
 * Fixo e número estrangeiro têm variante única, e o índice parcial
 * `uniq_contacts_org_phone` garante no máximo uma linha ativa: ali não há o que
 * desempatar.
 *
 * ## O desempate final é arbitrário DE PROPÓSITO
 *
 * Se nenhuma candidata for a canônica — estado que não deveria existir —, vence
 * o menor `id`. Não é uma escolha com significado: é uma escolha **estável**.
 * Devolver "qualquer uma" é o defeito; devolver sempre a mesma é o conserto,
 * mesmo quando a regra de negócio não tem preferência.
 */
export function escolherContatoCanonico<T extends ContatoCandidato>(
  candidatos: readonly T[],
  rawPhone: string,
): T | null {
  if (candidatos.length === 0) return null;
  const canonica = canonicalPhoneBR(rawPhone);
  const exata = candidatos.filter((c) => c.phone_number === canonica);
  const pool = exata.length > 0 ? exata : candidatos;
  return [...pool].sort((a, b) => a.id.localeCompare(b.id))[0]!;
}

/**
 * Busca por todas as grafias e devolve UMA, sempre a mesma.
 *
 * `limit(4)` e não `limit(1)`: com `limit(1)` a escolha é do banco, e é ela que
 * era não-determinística. Quatro é folga sobre as duas grafias possíveis — se
 * aparecerem mais, é dado corrompido, e ainda assim a saída é estável.
 */
/**
 * Telefone EXTRA: a ficha guarda vários números (`contact_phones`), e a busca do
 * principal (`contacts.phone_number`) não os enxerga. Sem esta busca, a mensagem
 * que chega pelo segundo número abriria uma ficha nova — a duplicata que a
 * junção de fichas acabou de desfazer.
 *
 * Só ENTRA a ficha viva: a extra de uma ficha fundida não conta, pelo mesmo
 * motivo da busca do principal. O número é a forma canônica (a regra "um número,
 * uma ficha" grava assim), então não há variante a tentar.
 *
 * Devolve `null` quando nenhuma ficha viva tem o número como extra. Erro de
 * leitura vira `null` aqui — mesmo contrato do principal, que também engole.
 */
async function contatoDonoDoExtra(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
): Promise<{ contactId: string; numero: string } | null> {
  const numero = canonicalPhoneBR(rawPhone);
  if (!numero) return null;
  const { data: extra } = await admin
    .from("contact_phones")
    .select("contact_id")
    .eq("organization_id", orgId)
    .eq("phone_number", numero)
    .maybeSingle();
  const contactId = (extra as { contact_id: string } | null)?.contact_id;
  if (!contactId) return null;
  const { data: viva } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .is("is_merged_into", null)
    .maybeSingle();
  if (!viva) return null;
  return { contactId, numero };
}

/**
 * Lista dos números extras de fichas vivas da organização: forma canônica → id
 * da ficha dona. Usada pelos pontos que decidem "já existe" para uma pilha de
 * números (importação, agenda do celular) sem uma consulta por número.
 *
 * Erro de leitura LANÇA — quem chama já lança quando o principal falha, e
 * engolir aqui deixaria a importação criar duplicata sem aviso.
 */
export async function contatosDonosDosExtras(
  admin: SupabaseClient,
  orgId: string,
  numeros: readonly string[],
): Promise<Map<string, string>> {
  const canonicos = [...new Set(numeros.map((n) => canonicalPhoneBR(n)).filter((n) => n !== ""))];
  const achados = new Map<string, string>();
  if (canonicos.length === 0) return achados;
  const { data: extras, error } = await admin
    .from("contact_phones")
    .select("phone_number, contact_id")
    .eq("organization_id", orgId)
    .in("phone_number", canonicos);
  if (error) throw new Error(error.message);
  const linhas = extras ?? [];
  if (linhas.length === 0) return achados;
  const donas = [...new Set(linhas.map((r) => r.contact_id))];
  const { data: vivas, error: erroVivas } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .in("id", donas)
    .is("is_merged_into", null);
  if (erroVivas) throw new Error(erroVivas.message);
  const idsVivos = new Set((vivas ?? []).map((r) => r.id));
  for (const r of linhas) {
    if (idsVivos.has(r.contact_id)) achados.set(r.phone_number, r.contact_id);
  }
  return achados;
}

/**
 * A ficha dona do extra, com as MESMAS colunas que a busca do principal devolve.
 * `achado_pelo_extra` avisa quem chama que o número NÃO é principal da ficha: quem
 * grava telefone na ficha achada precisa saber, senão promoveria o extra a
 * principal (e o banco recusaria com 23505 — ver os ingestores de canal).
 */
async function buscarPeloExtra(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
  colunas: string,
): Promise<Record<string, unknown> | null> {
  const dona = await contatoDonoDoExtra(admin, orgId, rawPhone);
  if (!dona) return null;
  const { data } = await admin
    .from("contacts")
    .select(colunas)
    .eq("organization_id", orgId)
    .eq("id", dona.contactId)
    .is("is_merged_into", null)
    .maybeSingle();
  if (!data) return null;
  // `phone_number` é o número que a busca achou (o extra), não o principal da
  // ficha — que pode nem existir. Quem chama usa este número como a grafia do
  // contato que chegou.
  return {
    ...(data as unknown as Record<string, unknown>),
    phone_number: dona.numero,
    achado_pelo_extra: true,
  };
}

async function buscarPorVariantes(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
  colunas: string,
): Promise<Record<string, unknown> | null> {
  const variantes = phoneLookupVariants(rawPhone);
  if (variantes.length === 0) return null;
  const { data } = await admin
    .from("contacts")
    .select(colunas)
    .eq("organization_id", orgId)
    .in("phone_number", variantes)
    // Contato FUNDIDO não é alvo: ele aponta para o vencedor da fusão, e
    // escrever nele é escrever num cadastro que ninguém mais lê. Dois dos
    // quatro chamadores desta busca não filtravam isto — ver o cabeçalho do
    // conserto.
    .is("is_merged_into", null)
    .limit(4);
  const linhas = (data ?? []) as unknown as ContatoCandidato[];
  const principal = (escolherContatoCanonico(linhas, rawPhone) as Record<string, unknown> | null) ?? null;
  if (principal) return principal;
  // Só depois do principal: quem tem o número como principal ganha sempre.
  // Ficha sem extra nunca passa por aqui com resultado diferente de hoje.
  return buscarPeloExtra(admin, orgId, rawPhone, colunas);
}

export async function encontrarContatoPorTelefone(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
): Promise<{ id: string; phone_number: string; achado_pelo_extra?: boolean } | null> {
  const linha = await buscarPorVariantes(admin, orgId, rawPhone, "id, phone_number");
  return (linha as { id: string; phone_number: string; achado_pelo_extra?: boolean } | null) ?? null;
}

/**
 * Como `encontrarContatoPorTelefone`, mas trazendo `is_blocked` E `is_personal`
 * NA MESMA consulta (bloqueado e pessoal na ligação são recusados). Sem
 * consulta extra: só as colunas a mais no `select` de `buscarPorVariantes`.
 */
export async function encontrarContatoPorTelefoneComBloqueio(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
): Promise<{
  id: string;
  phone_number: string | null;
  is_blocked: boolean | null;
  /** Spec 21: pessoal na ligação é recusado como bloqueado (etapa 14). */
  is_personal: boolean | null;
  /** Verdadeiro quando a ficha foi achada pelo EXTRA (o número não é o principal dela). */
  achado_pelo_extra?: boolean;
} | null> {
  const linha = await buscarPorVariantes(admin, orgId, rawPhone, "id, phone_number, is_blocked, is_personal");
  return (
    (linha as {
      id: string;
      phone_number: string | null;
      is_blocked: boolean | null;
      is_personal: boolean | null;
    } | null) ?? null
  );
}

/** Como `encontrarContatoPorTelefone`, mas trazendo o nome de quem já existia. */
export async function encontrarContatoPorTelefoneComNome(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
): Promise<{ id: string; phone_number: string | null; name: string | null; achado_pelo_extra?: boolean } | null> {
  const linha = await buscarPorVariantes(admin, orgId, rawPhone, "id, phone_number, name");
  return (linha as { id: string; phone_number: string | null; name: string | null; achado_pelo_extra?: boolean } | null) ?? null;
}

/** O contato da mensagem e os gêmeos gravados com a outra grafia do número. */
export async function idsDoContatoEGemeos(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<string[]> {
  const ids = new Set<string>([contactId]);
  const { data: me } = await admin
    .from("contacts")
    .select("phone_number")
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .maybeSingle();
  const phone = typeof me?.phone_number === "string" ? me.phone_number : null;
  if (!phone) return [...ids];
  const variantes = phoneLookupVariants(phone);
  if (variantes.length === 0) return [...ids];
  // Aqui NÃO se escolhe uma: o objetivo é o conjunto inteiro dos gêmeos, e
  // `limit` nenhum entra. Esta busca nunca teve o defeito das outras.
  const { data: gemeos } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .in("phone_number", variantes)
    .is("is_merged_into", null);
  for (const row of gemeos ?? []) {
    if (typeof row.id === "string") ids.add(row.id);
  }
  // A ficha que tem este número como EXTRA também é gêmea: a mensagem que chega
  // por ele pertence a ela, e o follow-up precisa vê-la como o mesmo contato.
  const dona = await contatoDonoDoExtra(admin, orgId, phone);
  if (dona) ids.add(dona.contactId);
  return [...ids];
}

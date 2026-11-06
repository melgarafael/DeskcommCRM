/**
 * Quem JÁ tem o dado único que o INSERT/UPDATE de `contacts` tentou gravar (#3084).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * O CPF e o e-mail têm trava única na tabela (`uniq_contacts_org_cpf` sobre
 * `(organization_id, cpf_hash)`, `uniq_contacts_org_email` sobre
 * `(organization_id, email_normalized)`), mas só o TELEFONE sabia virar
 * `contact_exists`: o 23505 das outras duas caía no `internal_error` de sempre e
 * a tela mostrava "erro interno" para um simples duplicado. Agora os três
 * índices contam a mesma história — 409 `contact_exists` com o `contact_id` de
 * quem já tem o dado.
 *
 * ─── Por que a releitura passa por `organization_id` ───────────────────────
 *
 * O `contact_id` devolvido NUNCA vem do corpo da requisição: vem de uma
 * consulta que repete o filtro por `organization_id` (e por `is_merged_into`,
 * que tira da disputa o contato fundido). É o mesmo cuidado do caminho do
 * telefone — sem ele, um CPF de OUTRA organização seria oferecido como
 * duplicado daqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Nome do índice único de CPF dentro de uma organização. */
export const INDICE_CPF = "uniq_contacts_org_cpf";
/** Nome do índice único de e-mail dentro de uma organização. */
export const INDICE_EMAIL = "uniq_contacts_org_email";
/** O do telefone entra na varredura só para reconhecê-lo, não para decidir. */
export const INDICE_TELEFONE = "uniq_contacts_org_phone";

const INDICES_CONHECIDOS = [INDICE_CPF, INDICE_EMAIL, INDICE_TELEFONE] as const;

/** O mínimo do erro do driver que a leitura do índice precisa. */
export interface ErroDeDriver {
  code?: string;
  message?: string;
  details?: string | null;
  constraint?: string | null;
}

/**
 * QUAL índice único bateu, segundo o erro do Postgres — ou `null` se não for
 * nenhum dos conhecidos.
 *
 * O driver nomeia a constraint na `message` (`duplicate key value violates
 * unique constraint "uniq_contacts_org_cpf"`); o campo `constraint` é uma
 * segunda pista quando existir. A varredura concatena as pistas em vez de
 * exigir um formato único: o texto do Postgres já mudou de forma entre versões,
 * e o que importa é o NOME do índice aparecer.
 */
export function nomeDoIndiceUnico(erro: ErroDeDriver): string | null {
  const pistas = [erro.constraint, erro.message, erro.details].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (pistas.length === 0) return null;
  const texto = pistas.join(" ");
  for (const nome of INDICES_CONHECIDOS) {
    if (texto.includes(nome)) return nome;
  }
  return null;
}

/**
 * O contato vivo desta organização com este `cpf_hash` — e mais nada.
 *
 * A coluna é o HASH (é ele que o índice guarda), então o chamador passa o valor
 * que já ia para o `insertRow`/`patch`: nada de recalcular CPF aqui.
 */
export async function encontrarContatoPorCpfHash(
  admin: SupabaseClient,
  orgId: string,
  cpfHash: string,
): Promise<{ id: string } | null> {
  return primeiraLinha(admin, orgId, "cpf_hash", cpfHash);
}

/**
 * O contato vivo desta organização com este e-mail.
 *
 * A comparação é sobre `email_normalized` — coluna GENERATED
 * (`lower(trim(email))`) e é ELA que o índice único vigia. Comparar `email` cru
 * erraria por caixa e por espaço, exatamente o que o índice não erra.
 */
export async function encontrarContatoPorEmail(
  admin: SupabaseClient,
  orgId: string,
  email: string,
): Promise<{ id: string } | null> {
  const normalizado = email.trim().toLowerCase();
  if (!normalizado) return null;
  return primeiraLinha(admin, orgId, "email_normalized", normalizado);
}

/**
 * A consulta comum: uma linha da organização, viva (não fundida), com o valor
 * pedido. `limit(1)` porque o índice garante no máximo uma — se vierem duas, é
 * dado corrompido e ainda assim a resposta é estável.
 */
async function primeiraLinha(
  admin: SupabaseClient,
  orgId: string,
  coluna: "cpf_hash" | "email_normalized",
  valor: string,
): Promise<{ id: string } | null> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq(coluna, valor)
    .is("is_merged_into", null)
    .limit(1);
  const linha = ((data ?? []) as Array<{ id: string }>)[0];
  return linha ? { id: linha.id } : null;
}

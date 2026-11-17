import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { moduloLigado } from "@/lib/instalacao/modulos";

import type { Prospect } from "./schema";

/**
 * A EMPRESA DO MÓDULO "EMPRESAS E PESSOAS" QUE A PROSPECÇÃO CRIA — issue #3198,
 * fatia 2, com o desenho FECHADO pelo autor (@paulolimajr77) em 16/11:
 *
 * 1. o telefone do Google é da RECEPÇÃO, não de uma pessoa: o contato nasce
 *    apontando para a empresa (`contacts.company_id`), e NÃO existe pessoa
 *    sintética "Recepção" — ela sujaria a contagem e a deduplicação de pessoas;
 * 2. na Empresa mora só o que NÃO muda do Maps (`website`, `maps_url`,
 *    `place_id`). Nota, avaliações e categoria continuam em
 *    `prospecting_candidates.data`, porque são leitura do tempo, não cadastro;
 * 3. com o módulo DESLIGADO a prospecção segue exatamente como hoje. Este
 *    arquivo só é chamado com o módulo ligado, e a primeira coisa que ele faz é
 *    conferir a chave — desligado, devolve `null` sem uma escrita.
 *
 * ─── Por que `place_id` é a chave da deduplicação ───────────────────────────
 *
 * O módulo só sabia deduplicar empresa por CNPJ (`companies_org_place_id_uidx`
 * é o primeiro índice por NEGÓCIO). A prospecção não tem CNPJ: o `place_id` é a
 * identidade que o Maps dá ao negócio, e é ele que o candidato já guarda em
 * `place_id` e no `source_metadata` do contato. Dois candidatos do mesmo
 * negócio, na mesma organização, caem na MESMA empresa.
 *
 * ─── O que este arquivo NÃO faz (e por quê) ─────────────────────────────────
 *
 * - Não cria pessoa: decisão 1.
 * - Não grava nota, avaliações nem categoria: decisão 2.
 * - Não parseia o endereço do Maps em seis colunas: o dado é uma string única e
 *   a empresa tem `street/number/...`; inventar o parser erraria em silêncio, e
 *   a fatia 3 (o botão "Transformar em empresa") é o lugar de decidir isso.
 * - Não enriquece por CNPJ: a empresa do Google nasce sem CNPJ, e o
 *   enriquecimento só dispara com ele (`lib/crm-b2b/enrich.ts`).
 * - Não sobrescreve o que uma pessoa editou: no reaproveitamento só preenche
 *   campo VAZIO de site e Maps.
 */

/** O que a prospecção sabe do negócio — o bastante para a Empresa. */
export type NegocioDoMaps = Pick<
  Prospect,
  "key" | "name" | "phone" | "website" | "maps_url" | "emails"
>;

const COLUNAS = "id, website, maps_url";

/**
 * Cria ou reaproveita a Empresa do candidato, casando por `place_id` DENTRO da
 * organização. Devolve o id, ou `null` quando o módulo está desligado (nada é
 * escrito) ou o candidato não tem `place_id` (sem ele não há como deduplicar, e
 * criar empresa sem chave seria duplicar a cada envio).
 */
export async function empresaDoCandidato(
  admin: SupabaseClient,
  org: string,
  negocio: NegocioDoMaps,
): Promise<string | null> {
  if (!(await moduloLigado(admin, "crm_b2b"))) return null;

  const placeId = negocio.key?.trim();
  if (!placeId) return null;

  const { data: existente, error: erroDaLeitura } = await admin
    .from("companies")
    .select(COLUNAS)
    .eq("organization_id", org)
    .eq("place_id", placeId)
    .maybeSingle();

  if (erroDaLeitura) {
    logger.warn("[prospecting] empresa do candidato: leitura por place_id falhou", {
      organization_id: org,
      place_id: placeId,
      error: erroDaLeitura.message,
    });
  }

  if (existente) {
    const atual = existente as { id: string; website: string | null; maps_url: string | null };
    // Só o campo VAZIO é preenchido: o que a operação digitou na ficha manda.
    const patch: { website?: string; maps_url?: string } = {};
    if (!atual.website && negocio.website) patch.website = negocio.website;
    if (!atual.maps_url && negocio.maps_url) patch.maps_url = negocio.maps_url;
    if (Object.keys(patch).length > 0) {
      const { error } = await admin
        .from("companies")
        .update(patch)
        .eq("organization_id", org)
        .eq("id", atual.id);
      if (error) {
        logger.warn("[prospecting] empresa do candidato: completar site/Maps falhou", {
          organization_id: org,
          company_id: atual.id,
          error: error.message,
        });
      }
    }
    return atual.id;
  }

  const primeiroEmail = negocio.emails?.find((e) => e.trim().length > 0) ?? null;
  const insert = {
    organization_id: org,
    // O nome do Maps é o nome com que o negócio se apresenta: `trade_name`.
    // `legal_name` fica nulo — é a razão social, que o Maps não entrega.
    trade_name: negocio.name,
    phone: negocio.phone,
    email: primeiroEmail,
    website: negocio.website,
    maps_url: negocio.maps_url,
    place_id: placeId,
    // Nasce `pending` como qualquer empresa criada pelo módulo; sem CNPJ nada a
    // enriquece depois, e a tela de Empresas da fatia 1 não é tocada aqui.
    enrichment_status: "pending" as const,
    // Ator de sistema: a prospecção não tem usuário logado. `created_by` é
    // nullable e a importação de planilha também grava auditoria própria.
    created_by: null,
  };

  const { data: criada, error: erroDoInsert } = await admin
    .from("companies")
    .insert(insert)
    .select("id")
    .single();

  if (!erroDoInsert && criada) return (criada as { id: string }).id;

  // Corrida entre duas abordagens do MESMO negócio: o índice único
  // `companies_org_place_id_uidx` recusou a segunda — a primeira já existe, e
  // reaproveitá-la é exatamente o que o desenho pede.
  if (erroDoInsert?.code === "23505") {
    const { data: vencedora } = await admin
      .from("companies")
      .select("id")
      .eq("organization_id", org)
      .eq("place_id", placeId)
      .maybeSingle();
    if (vencedora) return (vencedora as { id: string }).id;
  }

  logger.warn("[prospecting] empresa do candidato: criação falhou", {
    organization_id: org,
    place_id: placeId,
    codigo: erroDoInsert?.code,
    error: erroDoInsert?.message,
  });
  return null;
}

/**
 * O vínculo do contato com a empresa. Chamado só para o contato que a
 * prospecção ACABOU de criar — contato que já existe não é tocado (spec 26
 * §7.1: ficha existente só muda pelo botão da tela).
 *
 * A mesma organização não é conferida aqui: quem confere é o gatilho
 * `trg_contacts_company_same_org` (migration 9406), porque `contacts` tem vários
 * escritores e uma checagem no nosso caminho protegeria só este.
 */
export async function ligarContatoAEmpresa(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  org: string,
  contactId: string,
  companyId: string,
): Promise<void> {
  await db.query(
    "update contacts set company_id=$3 where organization_id=$1 and id=$2 and company_id is null",
    [org, contactId, companyId],
  );
}

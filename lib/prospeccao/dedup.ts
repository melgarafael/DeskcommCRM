/**
 * A DEDUPLICAÇÃO — em camadas, na ordem do §8 do plano.
 *
 * Nível 1 (provider + id externo) é IDENTIDADE: mesma linha, atualiza.
 * Níveis 2–4 (telefone+nome, domínio, nome+endereço) são MATCH: reutiliza a
 * linha e vincula o resultado (primeira_vez=false).
 * Nível 5 (nome + proximidade geográfica) é SUGESTÃO: preenche
 * `candidato_duplicado_de` para revisão humana, nunca funde sozinho — duas
 * filiais lado a lado têm mesmo nome e quase mesmo GPS, e fundi-las seria
 * apagar uma loja real.
 *
 * Cadeia e matriz compartilham telefone e domínio entre lojas DISTINTAS: por
 * isso telefone e domínio sozinhos NÃO decidem — sempre com o nome junto.
 */

export type NivelDedup =
  | "provider_id"
  | "telefone_nome"
  | "dominio"
  | "nome_endereco"
  | "proximidade_sugestao"
  | "novo";

export interface ProspectExistente {
  id: string;
  provider: string;
  external_id: string | null;
  nome_normalizado: string;
  telefone_normalizado: string | null;
  dominio: string | null;
  endereco: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ProspectCandidato {
  provider: string;
  external_id: string | null;
  nome_normalizado: string;
  telefone_normalizado: string | null;
  dominio: string | null;
  endereco: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface DecisaoDedup {
  nivel: NivelDedup;
  /** Linha a reutilizar/atualizar (nulo quando `novo`). */
  comQuem: string | null;
}

function mesmoEndereco(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a).length > 8 && norm(a) === norm(b);
}

/** ~111m de tolerância: mesma quadra, possivelmente a mesma porta. */
function perto(
  aLat: number | null,
  aLng: number | null,
  bLat: number | null,
  bLng: number | null,
): boolean {
  if (aLat === null || aLng === null || bLat === null || bLng === null) return false;
  return Math.abs(aLat - bLat) < 0.001 && Math.abs(aLng - bLng) < 0.001;
}

export function decidirDedup(
  candidato: ProspectCandidato,
  existentes: ProspectExistente[],
): DecisaoDedup {
  // Nível 1 — identidade.
  if (candidato.external_id) {
    const igual = existentes.find(
      (e) => e.provider === candidato.provider && e.external_id === candidato.external_id,
    );
    if (igual) return { nivel: "provider_id", comQuem: igual.id };
  }
  for (const e of existentes) {
    // Nível 2 — telefone + nome (os dois juntos; sozinhos não decidem).
    if (
      candidato.telefone_normalizado &&
      e.telefone_normalizado === candidato.telefone_normalizado &&
      e.nome_normalizado === candidato.nome_normalizado
    ) {
      return { nivel: "telefone_nome", comQuem: e.id };
    }
    // Nível 3 — domínio + nome.
    if (
      candidato.dominio &&
      e.dominio === candidato.dominio &&
      e.nome_normalizado === candidato.nome_normalizado
    ) {
      return { nivel: "dominio", comQuem: e.id };
    }
    // Nível 4 — nome + endereço.
    if (
      e.nome_normalizado === candidato.nome_normalizado &&
      mesmoEndereco(e.endereco, candidato.endereco)
    ) {
      return { nivel: "nome_endereco", comQuem: e.id };
    }
  }
  // Nível 5 — sugestão (não funde).
  for (const e of existentes) {
    if (
      e.nome_normalizado === candidato.nome_normalizado &&
      perto(e.latitude, e.longitude, candidato.latitude, candidato.longitude)
    ) {
      return { nivel: "proximidade_sugestao", comQuem: e.id };
    }
  }
  return { nivel: "novo", comQuem: null };
}

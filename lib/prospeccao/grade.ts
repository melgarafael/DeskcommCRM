/**
 * A GRADE GEOGRÁFICA — como cobrir Joinville+40km sem estourar o limite por
 * consulta (§6 do plano).
 *
 * A região vira células quadradas de `tamanhoKm` com `overlapPct` de sobre-
 * posição; cada célula é uma consulta independente (centro + raio que cobre
 * os cantos). Overlap existe porque fronteira de célula perde empresa — e a
 * deduplicação (§8) remove as repetidas depois. Grade determinística: mesma
 * entrada, mesmas células, mesmo checkpoint.
 *
 * Matemática plana local (graus por km) — válida para raios de centenas de
 * km; prospecção municipal não precisa de geodésia esférica.
 */

export interface Celula {
  indice: number;
  latitude: number;
  longitude: number;
  /** Raio da consulta em metros (cobre os cantos da célula). */
  raioMetros: number;
}

const KM_POR_GRAU_LAT = 110.574;

export function gerarGrade(
  latitude: number,
  longitude: number,
  raioKm: number,
  tamanhoKm: number,
  overlapPct: number,
): Celula[] {
  const passo = tamanhoKm * (1 - overlapPct / 100);
  const passos = Math.max(1, Math.ceil((raioKm * 2) / passo));
  // Grade ímpar centrada: com número par, o centro cai na quina de 4 células
  // e o meio da região vira fronteira — justo onde mais há empresas.
  const n = passos % 2 === 0 ? passos + 1 : passos;
  const kmPorGrauLng = 111.32 * Math.cos((latitude * Math.PI) / 180);
  const raioMetros = Math.round(((passo / 2) * Math.SQRT2 * 1000));

  const celulas: Celula[] = [];
  const meio = (n - 1) / 2;
  let indice = 0;
  for (let linha = 0; linha < n; linha++) {
    for (let col = 0; col < n; col++) {
      const dyKm = (meio - linha) * passo;
      const dxKm = (col - meio) * passo;
      // Fora do círculo? A célula [i] cobre cantos — conta se o CENTRO está
      // dentro do raio + meia diagonal (célula de borda pega a franja).
      const distCentro = Math.sqrt(dxKm * dxKm + dyKm * dyKm);
      if (distCentro > raioKm + (passo / 2) * Math.SQRT2) continue;
      celulas.push({
        indice: indice++,
        latitude: latitude + dyKm / KM_POR_GRAU_LAT,
        longitude: longitude + dxKm / kmPorGrauLng,
        raioMetros,
      });
    }
  }
  return celulas;
}

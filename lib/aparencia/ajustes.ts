/**
 * A ESCOLHA DE APARÊNCIA de uma organização — de onde ela sai do jsonb e como
 * vira atributo no marcador de `/app`.
 *
 * Mora em `organizations.settings.aparencia`, ao lado (e não dentro) de
 * `settings.branding`: a identidade da empresa (nome, cor principal, logo) tem
 * escritor próprio (`fn_definir_marca_da_organizacao`), e trocar de template
 * não pode apagar nada dela. Quem grava esta chave é
 * `fn_definir_aparencia_da_organizacao`.
 *
 * ── Nunca lança ─────────────────────────────────────────────────────────────
 *
 * `aparenciaDeSettings` roda no layout que embrulha `/app` inteiro. `settings`
 * é jsonb livre — escrita manual, versão futura, migração pela metade —, e
 * qualquer forma estranha vira o padrão do produto, CAMPO POR CAMPO: um raio
 * inválido não leva junto o template que era válido.
 */

import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";

import { templatePorId } from "./catalogo";
import { ehChaveDeFonte, type ChaveDeFonte } from "./fontes";

export const RAIOS = ["compacto", "medio", "arredondado"] as const;
export const DENSIDADES = ["confortavel", "compacta"] as const;
export const EFEITOS = ["completo", "sutil", "desligado"] as const;

export type Raio = (typeof RAIOS)[number];
export type Densidade = (typeof DENSIDADES)[number];
export type Efeitos = (typeof EFEITOS)[number];

export type Aparencia = {
  /** Id do catálogo, ou `null` = a aparência de fábrica do produto. */
  readonly template: string | null;
  /** `null` = a fonte do template. */
  readonly fonte: ChaveDeFonte | null;
  /** `null` = os raios do template. */
  readonly raio: Raio | null;
  readonly densidade: Densidade;
  readonly efeitos: Efeitos;
  /** Hex normalizado, ou `null` = a segunda cor do template. */
  readonly cor_secundaria: string | null;
};

export const AJUSTES_PADRAO: Aparencia = {
  template: null,
  fonte: null,
  raio: null,
  densidade: "confortavel",
  efeitos: "completo",
  cor_secundaria: null,
};

function umDe<T extends string>(lista: readonly T[], valor: unknown): T | null {
  return typeof valor === "string" && (lista as readonly string[]).includes(valor) ? (valor as T) : null;
}

export function aparenciaDeSettings(settings: unknown): Aparencia {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return AJUSTES_PADRAO;
  const bruto = (settings as Record<string, unknown>).aparencia;
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return AJUSTES_PADRAO;
  const a = bruto as Record<string, unknown>;
  const hex = typeof a.cor_secundaria === "string" ? a.cor_secundaria.trim() : "";
  return {
    template: templatePorId(a.template)?.id ?? null,
    fonte: ehChaveDeFonte(a.fonte) ? a.fonte : null,
    raio: umDe(RAIOS, a.raio),
    densidade: umDe(DENSIDADES, a.densidade) ?? AJUSTES_PADRAO.densidade,
    efeitos: umDe(EFEITOS, a.efeitos) ?? AJUSTES_PADRAO.efeitos,
    cor_secundaria: ehHexValido(hex) ? normalizarHex(hex) : null,
  };
}

export type AtributosDaAparencia = Partial<
  Record<
    | "data-aparencia"
    | "data-aparencia-fonte"
    | "data-aparencia-raio"
    | "data-aparencia-densidade"
    | "data-aparencia-efeitos",
    string
  >
>;

/**
 * Os atributos do marcador `[data-marca-org]`. Valor PADRÃO não vira atributo:
 * a organização que não mexeu em nada recebe `{}`, e o `/app` dela é
 * exatamente o de hoje — nenhuma regra de `app/app/aparencia.css` casa.
 */
export function atributosDaAparencia(a: Aparencia): AtributosDaAparencia {
  return {
    ...(a.template ? { "data-aparencia": a.template } : {}),
    ...(a.fonte ? { "data-aparencia-fonte": a.fonte } : {}),
    ...(a.raio ? { "data-aparencia-raio": a.raio } : {}),
    ...(a.densidade !== AJUSTES_PADRAO.densidade ? { "data-aparencia-densidade": a.densidade } : {}),
    ...(a.efeitos !== AJUSTES_PADRAO.efeitos ? { "data-aparencia-efeitos": a.efeitos } : {}),
  };
}

/**
 * A segunda cor como UMA custom property no escopo da organização. O valor só
 * passa se for hex — é o único texto livre da aparência que chega a um
 * `<style>`, e a régua é a mesma do resto da marca (`ehHexValido`).
 */
export function cssDaCorSecundaria(hex: string | null): string | null {
  if (!hex || !ehHexValido(hex.trim())) return null;
  return `body:has([data-marca-org]) {\n  --aparencia-secundaria: ${normalizarHex(hex.trim())};\n}`;
}

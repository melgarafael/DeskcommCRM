/**
 * Com que idioma, fuso, moeda e país uma empresa nasce no cadastro aberto.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Quem abria `/signup` em espanhol (o `Accept-Language` do navegador decide a
 * tela pública), confirmava o e-mail — e caía num onboarding inteiro em
 * português. `signUp` não guardava o idioma de quem se cadastrava, e a
 * organização nascia com os DEFAULTS da coluna: `pt-BR`, `America/Sao_Paulo`,
 * `BRL`, sem país. Como a interface de quem não escolheu idioma próprio segue o
 * da organização ativa (`lib/auth/server.ts`), a pessoa que se cadastrou numa
 * tela em espanhol passava a ver o produto em português.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * O idioma é o da tela em que a pessoa se cadastrou (o que ela leu e aceitou),
 * com o `Accept-Language` como segunda pista. Em `pt-BR`, NADA muda: a empresa
 * nasce com os defaults da coluna, exatamente como antes. Fora do `pt-BR`, o
 * país sai do fuso do NAVEGADOR (o sinal mais fiel de onde a pessoa está) e, na
 * falta dele, da região do `Accept-Language` (`es-MX` → `MX`); do país saem o
 * fuso padrão e a moeda.
 *
 * ─── Por que o país pode NÃO ser gravado ───────────────────────────────────
 *
 * `organizations.country` é a régua do documento do contato, da lei citada no
 * PDF de acesso do titular e do calendário de prazos (`lib/legal/perfil-do-pais`).
 * Só entra país com perfil REVISADO (`paisesOferecidos`): Configurações ›
 * Empresa recusa salvar país sem perfil, e gravá-lo no nascimento deixaria a
 * empresa sem conseguir salvar a própria tela de cadastro. O resto (idioma,
 * fuso, moeda) não depende disso. Quando um perfil novo for revisado, ele passa
 * a ser gravado sem mudar esta função.
 *
 * Pura de propósito: quem a chama decide de onde vêm as pistas (metadados do
 * cadastro, URL de volta do Google, cabeçalho), e o teste a mede sem banco.
 */
import { paisesOferecidos } from "@/lib/legal/perfil-do-pais";
import { normalizarIdioma, parseAcceptLanguage, type Idioma } from "@/lib/i18n/idiomas";
import { MOEDAS_SERVIDAS, type MoedaServida } from "@/lib/money";
import { FUSOS_OFERECIDOS, fusoValido } from "@/lib/tempo/fusos";

/** As pistas que o cadastro tem de quem está chegando. Todas não confiáveis. */
export interface PistasDoCadastro {
  /** O idioma em que a tela de cadastro foi desenhada (`es`, `pt-BR`). */
  idioma?: string | null;
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone` do navegador. */
  fuso?: string | null;
  /** O cabeçalho `Accept-Language` cru. */
  acceptLanguage?: string | null;
}

/** As colunas de `organizations` que o nascimento grava. Ausente = default da coluna. */
export interface PerfilDaEmpresaNova {
  locale: Idioma;
  timezone?: string;
  currency?: MoedaServida;
  country?: string;
}

/**
 * O país de cada fuso oferecido em Configurações (`FUSOS_OFERECIDOS`) fora do
 * Brasil. Fuso fora daqui (UTC, os do Brasil) não indica país nenhum.
 */
const PAIS_DO_FUSO: Record<string, string> = {
  "America/Asuncion": "PY",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Montevideo": "UY",
  "America/Santiago": "CL",
  "America/La_Paz": "BO",
  "America/Lima": "PE",
  "America/Bogota": "CO",
  "America/Guayaquil": "EC",
  "America/Mexico_City": "MX",
  "Africa/Luanda": "AO",
  "Europe/Lisbon": "PT",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "America/New_York": "US",
  "America/Los_Angeles": "US",
};

/** O fuso de quem só disse o país (pela região do `Accept-Language`). Um por país. */
const FUSO_DO_PAIS: Record<string, string> = {
  PY: "America/Asuncion",
  AR: "America/Argentina/Buenos_Aires",
  UY: "America/Montevideo",
  CL: "America/Santiago",
  BO: "America/La_Paz",
  PE: "America/Lima",
  CO: "America/Bogota",
  EC: "America/Guayaquil",
  MX: "America/Mexico_City",
  AO: "Africa/Luanda",
  PT: "Europe/Lisbon",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
};

/**
 * A moeda do país — só as que o produto serve (`MOEDAS_SERVIDAS`). País cuja
 * moeda não é servida fica no default da coluna: trocar por uma moeda que o
 * país não usa seria inventar.
 */
const MOEDA_DO_PAIS: Record<string, MoedaServida> = {
  MX: "MXN",
  EC: "USD",
  US: "USD",
  AO: "AOA",
  PT: "EUR",
  ES: "EUR",
  IT: "EUR",
};

/** `es-MX` → `MX`. Só a PRIMEIRA etiqueta com região, na ordem do navegador. */
function regiaoDoAcceptLanguage(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const parte of header.split(",")) {
    const tag = parte.trim().split(";")[0]?.trim() ?? "";
    const regiao = tag.split("-")[1];
    if (regiao && /^[A-Za-z]{2}$/.test(regiao)) return regiao.toUpperCase();
  }
  return null;
}

export function perfilDaEmpresaNova(pistas: PistasDoCadastro): PerfilDaEmpresaNova {
  // A tela vence o cabeçalho: é o idioma que a pessoa LEU ao aceitar os termos.
  const daTela = pistasParaGuardar({ idioma: pistas.idioma }).idioma ?? null;
  const locale = normalizarIdioma(daTela ?? parseAcceptLanguage(pistas.acceptLanguage));

  // Em pt-BR a empresa nasce como sempre nasceu: só o idioma, que é o default.
  if (locale === "pt-BR") return { locale };

  const fusoBruto = pistas.fuso?.trim() ?? "";
  // Só um fuso que as telas de configuração conseguem MOSTRAR: fora da lista, o
  // <select> de Configurações exibiria São Paulo enquanto a coluna guarda outro.
  const fusoDoNavegador =
    fusoBruto !== "" && fusoValido(fusoBruto) && FUSOS_OFERECIDOS.some((f) => f.codigo === fusoBruto)
      ? fusoBruto
      : null;

  const pais =
    (fusoDoNavegador ? PAIS_DO_FUSO[fusoDoNavegador] : undefined) ??
    regiaoDoAcceptLanguage(pistas.acceptLanguage) ??
    null;

  const timezone = fusoDoNavegador ?? (pais ? FUSO_DO_PAIS[pais] : undefined);
  const moeda = pais ? MOEDA_DO_PAIS[pais] : undefined;
  const currency = moeda && (MOEDAS_SERVIDAS as readonly string[]).includes(moeda) ? moeda : undefined;
  const country = pais && paisesOferecidos().some((p) => p.codigo === pais) ? pais : undefined;

  return {
    locale,
    ...(timezone ? { timezone } : {}),
    ...(currency ? { currency } : {}),
    ...(country ? { country } : {}),
  };
}

/**
 * As pistas que o `signUp` guarda no `user_metadata` para o provisionamento ler
 * no `/auth/confirm`. Chaves PRÓPRIAS, e não `locale`/`timezone`: essas duas são
 * a preferência PESSOAL da pessoa (`lib/auth/server.ts`), e gravá-las no cadastro
 * faria uma troca posterior do idioma da empresa não alcançar quem a criou.
 */
export const CHAVE_IDIOMA_DO_CADASTRO = "idioma_do_cadastro";
export const CHAVE_FUSO_DO_CADASTRO = "fuso_do_cadastro";

/** Saneia as pistas antes de irem para o `user_metadata` (ou para a URL do Google). */
export function pistasParaGuardar(bruto: { idioma?: unknown; fuso?: unknown }): {
  idioma?: Idioma;
  fuso?: string;
} {
  const idioma =
    typeof bruto.idioma === "string" && normalizarIdioma(bruto.idioma) === bruto.idioma
      ? (bruto.idioma as Idioma)
      : undefined;
  const fuso =
    typeof bruto.fuso === "string" && bruto.fuso.length <= 64 && fusoValido(bruto.fuso) ? bruto.fuso : undefined;
  return { ...(idioma ? { idioma } : {}), ...(fuso ? { fuso } : {}) };
}

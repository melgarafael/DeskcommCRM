import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";

/**
 * O idioma de quem ainda não tem sessão (ou cujo perfil não tem `locale`
 * salvo) — as telas públicas (login, signup, convite, legal) ficam fora de
 * `app/app/layout.tsx`: sem `IdiomaProvider`, sem membership, sem
 * organização de quem consultar.
 *
 * Instalação Holospace (fork `holospace-saas/deskcomm-crm`): um único
 * tenant, espanhol rioplatense sempre — regra de ouro 6 do projeto
 * `holospace-universe`. Não negocia pelo `Accept-Language` do navegador:
 * qualquer visitante sem conta aqui é cliente ou prospect de língua
 * espanhola, nunca outra. O upstream usava o header como sinal antes de
 * cair no padrão `pt-BR` (`IDIOMA_PADRAO`); aqui cai direto em `"es"`.
 *
 * `preferência salva → "es"` continua sendo a cadeia: uma preferência já
 * salva no perfil (inclusive uma desconhecida, que `normalizarIdioma`
 * degrada) sempre vence sobre este padrão.
 */
export async function idiomaDoVisitante(
  localeBruto: string | null | undefined,
): Promise<Idioma> {
  return normalizarIdioma(localeBruto ?? "es");
}

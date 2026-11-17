/**
 * O IDIOMA DO E-MAIL DO SISTEMA — uma resposta só, para todos os moldes.
 *
 * ─── O defeito que isto conserta (#4302) ───────────────────────────────────
 *
 * A tela já trocava de idioma; o e-mail não. Quem opera em espanhol lia
 * « Confirme seu e-mail » numa caixa que só tem espanhol no resto — e concluía
 * que a tradução do produto era fachada. Cada molde resolvia (ou não resolvia)
 * idioma por conta própria: os de acesso e o alarme de orçamento tinham texto
 * fixo em português, e o convite de time também.
 *
 * ─── A PRECEDÊNCIA, e por que ela é esta ──────────────────────────────────
 *
 *   1. a preferência do DESTINATÁRIO (`user_metadata.locale`) — quem recebe é
 *      quem lê; é o mesmo precedente de `aviso-de-troca-de-email.ts`;
 *   2. o idioma da ORGANIZAÇÃO (`organizations.locale`) — quem ainda não tem
 *      preferência própria entra no idioma da empresa que o convidou;
 *   3. o `APP_LOCALE` da INSTALAÇÃO — o que o instalador perguntou e gravou;
 *   4. `pt-BR`.
 *
 * ─── Por que uma função PURA, e não a leitura do banco aqui ───────────────
 *
 * A leitura de `organizations.locale` mora em `idioma-da-organizacao.ts`, que
 * fala com o Postgres. Este arquivo não importa banco, `next/headers` nem
 * env de runtime: recebe as três fontes já lidas e devolve um `Idioma`. Assim
 * a precedência inteira é testável sem infraestrutura — que é a única forma de
 * ela não voltar a ser "cada tela resolve do seu jeito".
 *
 * ─── Nunca lança, nunca devolve chave crua ────────────────────────────────
 *
 * Locale ausente, vazio, desconhecido ou de um tipo que não devia estar aqui
 * (`42`, `{}`) cai para o próximo da fila e, no fim, para `pt-BR`. Um endereço
 * de e-mail não pode deixar de sair porque o campo de idioma tinha lixo, e
 * `traduzir` já garante que texto sem tradução sai em português.
 */
import { parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

/** As três fontes, da mais específica para a mais geral. Todas opcionais. */
export interface FontesDoIdioma {
  /** `user_metadata.locale` de quem RECEBE. */
  destinatario?: string | null;
  /** `organizations.locale` da organização dona do envio. */
  organizacao?: string | null;
  /** `APP_LOCALE`, o idioma escolhido no instalador. */
  instalacao?: string | null;
}

/**
 * Um valor solto vira um idioma que o produto serve — ou `null`, e aí a fila
 * continua.
 *
 * Reusa `parseAcceptLanguage` em vez de `normalizarIdioma` de propósito: aqui o
 * valor pode ser uma etiqueta regional que o seletor de idioma não oferece
 * (`es-MX`, `es-419`, `pt-PT`), e `parseAcceptLanguage` casa pelo primário. É a
 * mesma degradação de `idiomaDoTexto`, no mesmo lugar do código.
 */
function idiomaServido(bruto: string | null | undefined): Idioma | null {
  if (typeof bruto !== "string") return null;
  const valor = bruto.trim();
  if (valor === "") return null;
  return parseAcceptLanguage(valor);
}

/**
 * O idioma do e-mail, pela precedência do #4302.
 *
 * Puro: mesmo objeto de entrada, mesmo `Idioma` de saída, sem I/O.
 */
export function idiomaDoEmail(fontes: FontesDoIdioma = {}): Idioma {
  return (
    idiomaServido(fontes.destinatario) ??
    idiomaServido(fontes.organizacao) ??
    idiomaServido(fontes.instalacao) ??
    IDIOMA_PADRAO
  );
}

/**
 * O `APP_LOCALE` da instalação, já normalizado.
 *
 * Lido direto do ambiente, como `APP_NAME` em `lib/branding.ts`: é config de
 * instalação, não segredo, e não passa pelo esquema do `lib/env.ts` — um valor
 * inválido aqui não pode derrubar o app no boot (a regra do #2741), ele só cai
 * no padrão.
 */
export function idiomaDaInstalacao(): Idioma {
  return idiomaServido(process.env.APP_LOCALE) ?? IDIOMA_PADRAO;
}

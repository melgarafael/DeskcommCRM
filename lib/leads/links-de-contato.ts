/**
 * Links do CONTATO (Instagram, site, Google Meu Negócio…) — o que o funil
 * mostra ao lado de telefone e e-mail.
 *
 * ── Onde ficam guardados ──────────────────────────────────────────────────────
 *
 * Em `contacts.custom_fields`, sob chaves `link_<tipo>`. Sem coluna nova de
 * propósito: coluna exige migration + apêndice no baseline, e o baseline é o
 * arquivo que mais muda a cada atualização do produto. O `custom_fields` já é
 * lido e gravado pela API de contatos (`PATCH` troca o objeto inteiro — por isso
 * `aplicarLinks` devolve o objeto COMPLETO, preservando o que não é link).
 *
 * ── Por que só http/https ────────────────────────────────────────────────────
 *
 * O valor vira `<a href>`. `javascript:` e `data:` num href são execução de
 * código a um clique de distância, e o campo é preenchido por gente e por
 * agentes (MCP, webhook). A regra mora AQUI, na leitura, e não só no formulário:
 * um valor gravado por outro caminho passa pelo mesmo funil antes de virar link.
 */

export const TIPOS_DE_LINK = [
  { id: "instagram", rotulo: "Instagram", curto: "IG" },
  { id: "site", rotulo: "Site", curto: "Site" },
  { id: "google_meu_negocio", rotulo: "Google Meu Negócio", curto: "Google" },
  { id: "facebook", rotulo: "Facebook", curto: "FB" },
  { id: "linkedin", rotulo: "LinkedIn", curto: "In" },
  { id: "tiktok", rotulo: "TikTok", curto: "TikTok" },
  { id: "youtube", rotulo: "YouTube", curto: "YT" },
  { id: "outro", rotulo: "Outro", curto: "Link" },
] as const;

export type TipoDeLink = (typeof TIPOS_DE_LINK)[number]["id"];

/**
 * Um único exemplo, sem nome de rede nenhuma: o código que embarca na imagem do
 * cliente não hardcoda host de terceiro (`tests/unit/branding.test.ts`), e o
 * exemplo por rede seria exatamente isso. Quem cola o link cola o endereço todo.
 */
export const EXEMPLO_DE_LINK = "https://…";

export const PREFIXO_DA_CHAVE = "link_";
export const TAMANHO_MAXIMO_DO_LINK = 1000;

export type LinksDoContato = Partial<Record<TipoDeLink, string>>;

/** Um link já validado, pronto para virar `<a>`. */
export interface LinkExibivel {
  tipo: TipoDeLink;
  href: string;
}

export function chaveDoLink(tipo: TipoDeLink): string {
  return `${PREFIXO_DA_CHAVE}${tipo}`;
}

/**
 * O que o usuário digitou → uma URL http(s) segura, ou `null`.
 *
 * `@usuario` NÃO é aceito: transformá-lo em endereço exigiria hardcodar o host
 * de cada rede aqui, e o código que embarca não nomeia host de terceiro. Pior
 * que recusar seria aceitar por engano — `@loja.exemplo` casaria como o
 * domínio `loja.exemplo` — por isso o `@` é recusado ANTES do resto.
 */
export function normalizarLink(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? "").trim();
  if (!texto || texto.length > TAMANHO_MAXIMO_DO_LINK) return null;
  if (texto.startsWith("@")) return null;

  // Sem esquema → https. Com QUALQUER esquema, ele é examinado abaixo: é o que
  // faz `javascript:…` cair no protocolo em vez de virar "https://javascript:…".
  const comEsquema = /^[a-z][a-z0-9+.-]*:/i.test(texto) ? texto : `https://${texto}`;
  let url: URL;
  try {
    url = new URL(comEsquema);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // "loja" sozinho não é endereço: exige ao menos um ponto no host.
  if (!url.hostname.includes(".")) return null;
  return url.href;
}

/** Os valores CRUS gravados (o que a pessoa digitou), por tipo. */
export function lerLinks(customFields: Record<string, unknown> | null | undefined): LinksDoContato {
  const links: LinksDoContato = {};
  for (const { id } of TIPOS_DE_LINK) {
    const valor = customFields?.[chaveDoLink(id)];
    if (typeof valor === "string" && valor.trim()) links[id] = valor.trim();
  }
  return links;
}

/** Só o que é exibível: valor gravado E válido, na ordem do catálogo. */
export function linksParaExibir(
  customFields: Record<string, unknown> | null | undefined,
): LinkExibivel[] {
  const links = lerLinks(customFields);
  const saida: LinkExibivel[] = [];
  for (const { id } of TIPOS_DE_LINK) {
    const href = normalizarLink(links[id]);
    if (href) saida.push({ tipo: id, href });
  }
  return saida;
}

/** Tipos cujo texto está preenchido mas NÃO vira link — para o formulário avisar. */
export function tiposInvalidos(links: LinksDoContato): TipoDeLink[] {
  return TIPOS_DE_LINK.filter(({ id }) => {
    const valor = (links[id] ?? "").trim();
    return valor !== "" && normalizarLink(valor) === null;
  }).map(({ id }) => id);
}

/**
 * O `custom_fields` NOVO: tudo o que não é link fica como estava; os links vêm
 * de `links`. Vazio apaga a chave (não grava string vazia — o payload do
 * quadro não deve engordar, e "sem link" tem que ser ausência).
 *
 * Só as chaves `link_<tipo>` DO CATÁLOGO são tocadas: um campo personalizado
 * da organização que por acaso comece com `link_` e não seja um tipo nosso
 * continua intacto.
 */
export function aplicarLinks(
  customFields: Record<string, unknown> | null | undefined,
  links: LinksDoContato,
): Record<string, unknown> {
  const chavesNossas = new Set<string>(TIPOS_DE_LINK.map(({ id }) => chaveDoLink(id)));
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(customFields ?? {})) {
    if (!chavesNossas.has(chave)) saida[chave] = valor;
  }
  for (const { id } of TIPOS_DE_LINK) {
    const valor = (links[id] ?? "").trim();
    if (valor) saida[chaveDoLink(id)] = valor;
  }
  return saida;
}

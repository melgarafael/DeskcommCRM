/**
 * Classificação determinística de site de candidato da prospecção.
 *
 * Papel: transformar o `website` cru (campo que vem poluído da busca — medido:
 * 40% são Instagram/linktree/forms/WhatsApp, não site) em fatos baratos e
 * reproduzíveis: mesmo HTML de entrada, mesma saída, sempre. Nenhuma chamada
 * de modelo acontece aqui — por isso não existe ponto novo em
 * `lib/ai/pontos/registro.ts` para este módulo.
 *
 * Client-safe de propósito (sem `node:*`): a tela importa daqui
 * (`descreverProblema`, checklist, estratégia). O que precisa de rede ou de
 * classificar IP (`recusarSSRF`, `enderecoInterno`) mora em `site-fetch.ts`
 * (server-only) — nunca importar aquele de componente client.
 */
import { conteudoDoTitulo, temDescricaoLonga } from "@/lib/prospecting/leitura-do-html";


/**
 * ─── A REGRA DO #3723: "NÃO MEDIDO" NÃO É "MEDIDO E RUIM" ────────────────────
 *
 * A auditoria já disse à empresa duas coisas diferentes como se fossem uma só:
 *
 *   MEDIDO      — abrimos o site e ele respondeu com 200 e conteúdo. O que está
 *                 ruim está ruim: sem cadeado, quebrado no celular, quase vazio.
 *                 Só isto vira argumento de venda.
 *   NÃO MEDIDO  — não conseguimos olhar. `401/403/406/429/451/503` e o desafio
 *                 anti-robô são o IP de datacenter desta VPS sendo barrado
 *                 (medido no #3723: o mesmo site abre com 200 de rede
 *                 residencial); timeout e conexão resetada são a rede do
 *                 servidor. `nao-medido` é isso — e NUNCA vira argumento:
 *                 dizer "seu site não abre" a quem tem site no ar é a pior
 *                 primeira impressão possível numa abordagem fria.
 *
 * Duas consequências que valem para todo o módulo:
 *   1. `falta-*` (item do checklist) é MELHORIA, não defeito medido: não
 *      classifica o site nem entra no gancho da primeira mensagem.
 *   2. Nunca citar como falta o que o próprio checklist marca como presente —
 *      site com `wa.me` TEM telefone de contato (ver `montarChecklist`).
 */

/** Classes de auditoria. `dns-morto` é problema, não classe: a classe é `fora-do-ar`. */
export const CLASSES_DE_SITE = [
  "agregador",
  "sem-site",
  "site-ok",
  "site-ruim",
  "ssl-invalido",
  "fora-do-ar",
  "nao-medido",
] as const;
export type ClasseDeSite = (typeof CLASSES_DE_SITE)[number];

/**
 * Status HTTP em que quem responde é o FIREWALL do site, não o site: o nosso IP
 * de datacenter sendo barrado. O visitante de rede residencial vê 200 no mesmo
 * endereço (caso B do #3723). Tratar isso como "o site responde com erro" é
 * afirmar um defeito que só existe para o nosso robô.
 */
export const STATUS_DE_MEDICAO_BLOQUEADA: ReadonlySet<number> = new Set([401, 403, 406, 429, 451, 503]);

export function statusBloqueiaMedicao(status: number): boolean {
  return STATUS_DE_MEDICAO_BLOQUEADA.has(status);
}

/** `falta-*` = o que o checklist não achou na página: melhoria, não defeito. */
export function ehMelhoria(codigo: string): boolean {
  return codigo.startsWith("falta-");
}

/** Os problemas que a MEDIÇÃO sustenta — o resto é melhoria e não classifica. */
export function problemasMedidos(problemas: readonly string[]): string[] {
  return problemas.filter((p) => !ehMelhoria(p));
}

/**
 * Citável no argumento de venda? Regra única, usada pela tela, pela prévia e
 * pelo envio: só o que foi MEDIDO e está DEFINITIVO. Provisório é dúvida;
 * `nao-medido` é ausência de medida — os dois calados.
 */
export function citavelNoArgumento(site: { classe: ClasseDeSite; provisorio: boolean }): boolean {
  return !site.provisorio && site.classe !== "nao-medido";
}

/** Domínios que NÃO são site próprio (rede social, agregador, formulário, chat).
 * Medido na VPS em 2026-10-10: 8 de 20 `website` caíram aqui, zero fetch. */
export const DOMINIOS_AGREGADORES = [
  "instagram.com",
  "facebook.com",
  "linktr.ee",
  "linkr.bio",
  "linkbio.co",
  "bio.link",
  "beacons.ai",
  "allmylinks.com",
  "solo.to",
  "campsite.bio",
  "carrd.co",
  "forms.gle",
  "api.whatsapp.com",
  "wa.me",
] as const;

/**
 * Redes sociais reconhecidas pelo host, com o tipo de link que lhes cabe na ficha
 * (Spec 26). Separada de `DOMINIOS_AGREGADORES` de propósito: o LinkedIn não é
 * agregador, e pô-lo ali mudaria `ehAgregador` para quem já o usa (a prévia e o
 * veredito do site). Instagram e Facebook seguem nas duas listas, como antes.
 */
export const DOMINIOS_DE_REDE = [
  ["instagram.com", "instagram"],
  ["facebook.com", "facebook"],
  ["linkedin.com", "linkedin"],
] as const;

/** Assinatura de construtor pronto por URL final → rótulo único. */
const CONSTRUTORES_POR_URL: ReadonlyArray<readonly [string, string]> = [
  [".wixsite.com", "Wix"],
  ["sites.google.com", "Google Sites"],
  [".negocio.site", "Google Meu Negócio"],
  [".webnode.page", "Webnode"],
  [".webnode.com.br", "Webnode"],
  ["canva.site", "Canva"],
  [".my.canva.site", "Canva"],
  [".wordpress.com", "WordPress.com gratuito"],
  [".site123.me", "SITE123"],
  [".lojaintegrada.com.br", "Loja Integrada"],
  [".comercioplus.com.br", "Comércio Plus"],
  [".goomer.app", "Goomer"],
  // Medido na amostra real da VPS em 2026-10-10 (redirect de agendamento morto).
  ["automatizo.dev.br", "Automatizo"],
];

/** Assinatura de construtor pronto por conteúdo do HTML → rótulo único. */
const CONSTRUTORES_POR_HTML: ReadonlyArray<readonly [string, string]> = [
  ["static.wixstatic.com", "Wix"],
  ["static.parastorage.com", "Wix"],
  ['generator" content="wix', "Wix"],
  ['generator" content="site123', "SITE123"],
  ['generator" content="webnode', "Webnode"],
  ["cdn.usite.pro", "uSite"],
  ["websitebuilder", "construtor de site"],
];

/** Códigos do raio-X. Vocabulário fechado: nada fora disto chega à tela nem ao prompt. */
export const ITENS_DO_RAIO_X = [
  "whatsapp",
  "tel",
  "mailto",
  "social",
  "mapa",
  "fotos",
  "titulo",
  "description",
  "favicon",
] as const;
export type ItemDoRaioX = (typeof ITENS_DO_RAIO_X)[number];

export interface RaioXDoSite {
  tem: ItemDoRaioX[];
  falta: ItemDoRaioX[];
  /**
   * Verdadeiro quando a página foi montada por JavaScript (construtor pronto) e
   * o HTML baixado não traz o conteúdo: aí "não achamos" NÃO é "não tem" — o
   * checklist fica vazio em vez de listar faltas inventadas (caso D do #3723).
   */
  inconclusivo?: boolean;
}

/** Host canônico para comparação (`www.` fora, minúsculo) ou null se não for http(s). */
export function hostDeSite(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** True quando o `website` não é site próprio (ou nem URL é). Barato: sem rede. */
export function ehAgregador(url: string | null | undefined): boolean {
  const host = hostDeSite(url);
  if (!host) return true;
  return DOMINIOS_AGREGADORES.some((d) => host === d || host.endsWith(`.${d}`));
}

/** True quando não há o que buscar (nulo, vazio, só espaço). */
export function ehSemSite(url: string | null | undefined): boolean {
  return !url || url.trim() === "";
}

/**
 * Detecta construtor pronto pela URL final + HTML. Retorna UM rótulo mesmo
 * quando várias assinaturas casam (medido: `wix.com` triga 3 de uma vez).
 */
export function detectarConstrutor(urlFinal: string, html: string): string | null {
  const urlMinuscula = (urlFinal || "").toLowerCase();
  for (const [assinatura, nome] of CONSTRUTORES_POR_URL) {
    if (urlMinuscula.includes(assinatura)) return nome;
  }
  const htmlMinusculo = (html || "").toLowerCase();
  for (const [assinatura, nome] of CONSTRUTORES_POR_HTML) {
    if (htmlMinusculo.includes(assinatura)) return nome;
  }
  return null;
}

const TITULOS_VAZIOS = new Set(["home", "index", "início", "inicio", "untitled"]);

/**
 * Raio-X do HTML: o que o site TEM e o que FALTA para transformar visita em
 * contato. Tudo derivado da página baixada — nada aqui é chute.
 *
 * `inconclusivo` existe porque "não achei no HTML" e "o site não tem" são coisas
 * diferentes quando o construtor monta a página por JavaScript: o HTML baixado
 * vem quase vazio e o checklist acusava `falta-whatsapp`, `falta-fotos`,
 * `falta-mapa` num site que tem os três (caso D do #3723). Nesse caso o
 * checklist sai VAZIO — sem `tem` e sem `falta` — e a tela diz que não deu para
 * medir, em vez de listar faltas que o visitante desmentiria.
 */
export function montarChecklist(
  html: string,
  opcoes: { inconclusivo?: boolean } = {},
): RaioXDoSite {
  if (opcoes.inconclusivo) return { tem: [], falta: [], inconclusivo: true };
  const fonte = html || "";
  const minusculo = fonte.toLowerCase();
  // O link de WhatsApp é contato clicável: `wa.me/55…` e `api.whatsapp.com/send`
  // abrem a conversa com o número da empresa. Exigir `href="tel:` dava
  // `falta-tel` a site que tem WhatsApp no rodapé (caso A do #3723) — a mesma
  // falta que o checklist, duas linhas acima, marcava como `whatsapp` presente.
  const temWhatsapp =
    minusculo.includes("wa.me/") || minusculo.includes("api.whatsapp.com");
  const presente: Array<[ItemDoRaioX, boolean]> = [
    [
      "whatsapp",
      temWhatsapp || minusculo.includes("whatsapp"),
    ],
    ["tel", minusculo.includes('href="tel:') || minusculo.includes("href='tel:") || temWhatsapp],
    ["mailto", minusculo.includes("mailto:")],
    ["social", minusculo.includes("instagram.com") || minusculo.includes("facebook.com")],
    [
      "mapa",
      minusculo.includes("google.com/maps") ||
        minusculo.includes("maps.google") ||
        minusculo.includes("<address") ||
        /\b\d{5}-\d{3}\b/.test(fonte),
    ],
    ["fotos", (minusculo.match(/<img\b/g) ?? []).length >= 3],
    [
      "titulo",
      // Título curto é título: basta não ser vazio nem genérico. O mínimo de 8
      // caracteres reprovava marca de 7 letras ("VittaSP"), que é o nome que a
      // empresa escolheu — e a falta ia citada na primeira mensagem (caso A).
      (() => {
        const texto = (conteudoDoTitulo(fonte) ?? "").replace(/\s+/g, " ").trim();
        return texto.length > 0 && !TITULOS_VAZIOS.has(texto.toLowerCase());
      })(),
    ],
    ["description", temDescricaoLonga(fonte)],
    ["favicon", /rel=["'](?:shortcut )?icon/i.test(minusculo)],
  ];
  return {
    tem: presente.filter(([, ok]) => ok).map(([nome]) => nome),
    falta: presente.filter(([, ok]) => !ok).map(([nome]) => nome),
  };
}

/** Página "quase vazia": existe mas não apresenta nada. Limiar pinado por teste. */
export const MINIMO_CHARS_PAGINA_REAL = 800;

/** Erros de rede classificados sem adivinhação. `ssl` carrega o código (ex: CERT_HAS_EXPIRED). */
export type ErroDeRede =
  | { tipo: "dns" }
  | { tipo: "ssl"; codigo: string }
  | { tipo: "transitoria" }
  | { tipo: "http"; status: number };

export interface EntradaDaClasse {
  agregador: boolean;
  semSite: boolean;
  erro?: ErroDeRede;
  urlFinal: string;
  problemas: string[];
}

/**
 * Ordem determinística (função pura): agregador > sem-site > nao-medido >
 * fora-do-ar > ssl-invalido > http>=400 > demais problemas medidos →
 * site-ruim > site-ok.
 *
 * Dúvida nunca é veredito: transitória (timeout, conexão resetada) e status de
 * medição bloqueada (401/403/406/429/451/503) saem `nao-medido` — não é defeito
 * do site, é a nossa medição que não passou. E `falta-*` é melhoria: sozinha
 * não faz de um site bom um site ruim.
 */
export function derivarClasse(entrada: EntradaDaClasse): ClasseDeSite {
  if (entrada.agregador) return "agregador";
  if (entrada.semSite) return "sem-site";
  if (entrada.erro) {
    // Domínio que não resolve é prova (NXDOMAIN julgado antes, no fetch).
    if (entrada.erro.tipo === "dns") return "fora-do-ar";
    if (entrada.erro.tipo === "transitoria") return "nao-medido";
    if (entrada.erro.tipo === "ssl") return "ssl-invalido";
    if (entrada.erro.tipo === "http" && statusBloqueiaMedicao(entrada.erro.status)) return "nao-medido";
    if (entrada.erro.tipo === "http" && entrada.erro.status >= 400) return "site-ruim";
  }
  if (entrada.urlFinal.toLowerCase().startsWith("http://")) return "site-ruim";
  return problemasMedidos(entrada.problemas).length > 0 ? "site-ruim" : "site-ok";
}

/** Problema → frase leiga para a tela e para a copy. PT-BR; a UI usa `t()` à parte. */
const DESCRICOES: Record<string, string> = {
  "sem-https": "sem cadeado de segurança (aparece como 'não seguro' no navegador)",
  "http-sem-redirecionar": "o endereço do Google abre sem cadeado (o site tem versão segura, mas não leva para ela)",
  "ssl-invalido": "certificado de segurança inválido ou vencido (o navegador mostra alerta antes de abrir)",
  "fora-do-ar": "o site não abre",
  "nao-medido": "não deu para abrir o site daqui (bloqueio ao nosso acesso ou rede instável) — não é defeito do site",
  "medicao-bloqueada": "o servidor do site barrou o nosso acesso automático (proteção anti-robô) — para quem visita, o site abre",
  "medicao-instavel": "a nossa rede não conseguiu abrir o site a tempo — não é prova de que ele esteja fora do ar",
  "dns-morto": "o endereço do site não existe mais (domínio pode ter expirado)",
  "nao-mobile": "não abre direito no celular",
  lento: "muito lento para carregar",
  "quase-vazia": "página praticamente vazia (não apresenta serviços nem contato)",
  "sem-atualizacao": "sem sinal de atualização há anos",
  "conteudo-misto": "página segura puxando itens inseguros (partes podem nem carregar)",
  whatsapp: "sem botão de WhatsApp",
  tel: "sem telefone clicável",
  mailto: "sem e-mail de contato",
  social: "sem link para redes sociais",
  mapa: "sem endereço ou mapa",
  fotos: "sem fotos do negócio",
  titulo: "sem título descritivo na aba",
  description: "sem descrição para aparecer no Google",
  favicon: "sem ícone na aba do navegador",
};

/** Tradutor da tela (o `t()` do idioma). Ausente = português, o texto que vai ao agente. */
export type TradutorDeTexto = (texto: string) => string;
const SEM_TRADUCAO: TradutorDeTexto = (texto) => texto;

/**
 * Troca os marcadores `{nome}` de um texto JÁ traduzido — o padrão do
 * dicionário: `t("Nota {nota} ...")` e só depois a troca. `split/join`, e não
 * `replace`, porque o valor pode trazer `$&`, que o `replace` interpretaria.
 */
export function trocarMarcadores(texto: string, valores: Record<string, string | number>): string {
  let saida = texto;
  for (const [nome, valor] of Object.entries(valores)) saida = saida.split(`{${nome}}`).join(String(valor));
  return saida;
}

/**
 * `t` é só da TELA. O prompt (estratégia, campo `Auditoria` dos dados) chama
 * sem ele e recebe o português de sempre, byte a byte.
 */
export function descreverProblema(codigo: string, t: TradutorDeTexto = SEM_TRADUCAO): string {
  if (codigo.startsWith("http-"))
    return trocarMarcadores(t("o site responde com erro ({codigo})"), { codigo: codigo.slice("http-".length) });
  if (codigo.startsWith("construtor-"))
    return trocarMarcadores(t("feito em construtor pronto ({nome}) — mesma cara de milhares de outros"), {
      nome: codigo.slice("construtor-".length),
    });
  if (codigo.startsWith("sem-atualizacao-desde-"))
    return trocarMarcadores(t("parado desde {data}"), { data: codigo.slice("sem-atualizacao-desde-".length) });
  if (codigo.startsWith("falta-")) {
    const item = codigo.slice("falta-".length);
    return Object.hasOwn(DESCRICOES, item)
      ? t(DESCRICOES[item] as string)
      : trocarMarcadores(t("sem {item}"), { item });
  }
  return Object.hasOwn(DESCRICOES, codigo) ? t(DESCRICOES[codigo] as string) : codigo;
}

/**
 * O veredito que viaja em `prospecting_candidates.data.site`.
 * Escrito pelo worker (fase pura no insert, fase rede no tick) e pela
 * reanálise manual; lido pela tela e pela abordagem fria. Ausência = pendente.
 */
export interface SiteEnrichment {
  ver: 1;
  classe: ClasseDeSite;
  problemas: string[];
  checklist: RaioXDoSite;
  final_url: string | null;
  http_status: number | null;
  /** Milissegundos do fetch (teto 8000). Fase pura grava 0: nunca houve rede. */
  tempo_ms: number;
  conteudo_resumo: string | null;
  /** Best-effort (§3.5 da spec 24). v1: sempre null; faixa lenta em fase posterior. */
  pagespeed: { nota: number; lcp: string | null; medida_em: string } | null;
  verificado_em: string;
  /**
   * Provisório = falha passageira (timeout, reset, DNS), NÃO citável e
   * reverificado pelo tick até `tentativas` esgotar. Definitivo = comprovado.
   */
  provisorio: boolean;
  tentativas: number;
}

/**
 * Veredito puro (sem rede) para o insert: agregador e sem-site já nascem
 * resolvidos — ~40% medidos escapam do fetch. Retorna null quando precisa
 * da fase de rede (o tick preenche depois).
 */
export function vereditoPuro(website: string | null | undefined, agoraIso: string): SiteEnrichment | null {
  const vazio: RaioXDoSite = { tem: [], falta: [] };
  if (ehSemSite(website)) {
    return {
      ver: 1, classe: "sem-site", problemas: [], checklist: vazio,
      final_url: null, http_status: null, tempo_ms: 0,
      conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
      provisorio: false, tentativas: 0,
    };
  }
  if (ehAgregador(website)) {
    return {
      ver: 1, classe: "agregador", problemas: [], checklist: vazio,
      final_url: null, http_status: null, tempo_ms: 0,
      conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
      provisorio: false, tentativas: 0,
    };
  }
  return null;
}

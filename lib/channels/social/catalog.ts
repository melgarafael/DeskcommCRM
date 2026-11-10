/**
 * As REDES que o produto conhece — e as PORTAS por onde cada uma é alcançável.
 *
 * ─── O que mudou aqui, e por quê (issue #1320) ──────────────────────────────
 *
 * Até esta fatia o catálogo dizia **quem** atende todas as redes: uma constante
 * única (`SOCIAL_PROVIDER`) e um adapter só para as quinze. O efeito não era
 * estético — era a razão de o Instagram (#965) não poder voltar. Uma rede só
 * existia como "conta no parceiro", e não havia onde declarar que a MESMA rede
 * também é alcançável por conexão direta com a plataforma. Sem esse lugar, a
 * decisão do dono ("o parceiro vira porta opcional") não tinha como virar
 * código: faltava o substantivo.
 *
 * Agora cada rede declara as `portas` por onde é alcançável. O campo é
 * OBRIGATÓRIO — não há default — porque a ausência de uma porta é uma AFIRMAÇÃO
 * ("esta rede ainda não tem conexão direta"), não um esquecimento. Rede nova não
 * entra sem decidir, e quem lê (`./porta.ts`) deriva tudo daqui em vez de
 * manter uma segunda lista.
 *
 * O vocabulário das portas e o que cada uma exige vivem em `./porta.ts`. Este
 * arquivo é a DECLARAÇÃO; lá é o MODELO.
 */

/**
 * As portas por onde uma rede social pode ser alcançada.
 *
 * `direta` — conexão com a plataforma da própria rede (Meta, Google), sem
 * intermediário.
 * `intermediada` — conexão por um parceiro homologado que fala com a plataforma
 * no lugar do CRM.
 *
 * Os nomes são de TOPOLOGIA, não de fornecedor: é o que permite a mesma rede ter
 * as duas portas sem que o resto do produto precise saber quem opera cada uma.
 */
export type PortaSocialId = "direta" | "intermediada";

export const SOCIAL_NETWORKS = [
  // O Instagram volta pelo modelo neutro: é a rede que o #965 espera, e a
  // conexão DIRETA vem primeiro porque a decisão do dono (15/set) é que o
  // parceiro seja porta OPCIONAL. Ela ainda não tem transporte — e é o modelo,
  // não um comentário, que diz isso (ver `PORTAS_SOCIAIS` em `./porta.ts`).
  { id: "instagram", label: "Instagram", inbox: true, portas: ["direta", "intermediada"] },
  { id: "facebook", label: "Facebook", inbox: true, portas: ["direta", "intermediada"] },
  { id: "linkedin", label: "LinkedIn", inbox: false, portas: ["intermediada"] },
  { id: "twitter", label: "X", inbox: false, portas: ["intermediada"] },
  { id: "tiktok", label: "TikTok", inbox: false, portas: ["intermediada"] },
  { id: "youtube", label: "YouTube", inbox: false, portas: ["intermediada"] },
  { id: "threads", label: "Threads", inbox: false, portas: ["intermediada"] },
  { id: "reddit", label: "Reddit", inbox: false, portas: ["intermediada"] },
  { id: "pinterest", label: "Pinterest", inbox: false, portas: ["intermediada"] },
  { id: "bluesky", label: "Bluesky", inbox: false, portas: ["intermediada"] },
  { id: "googlebusiness", label: "Google Business", inbox: false, portas: ["intermediada"] },
  { id: "telegram", label: "Telegram", inbox: false, portas: ["intermediada"] },
  { id: "snapchat", label: "Snapchat", inbox: false, portas: ["intermediada"] },
  { id: "discord", label: "Discord", inbox: false, portas: ["intermediada"] },
  { id: "slack", label: "Slack", inbox: false, portas: ["intermediada"] },
] as const satisfies readonly {
  id: string;
  label: string;
  inbox: boolean;
  portas: readonly PortaSocialId[];
}[];

export type SocialPlatform = (typeof SOCIAL_NETWORKS)[number]["id"];
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/**
 * Rede por id, sem inventar uma segunda tabela: é o mesmo array, indexado.
 *
 * O `undefined` do `find` é impossível para quem tem `SocialPlatform` na mão, mas
 * é o caso REAL de quem tem uma string vinda do banco — e quem decide o que
 * fazer com ela é quem pergunta (ver `portasDaRede`), não este acesso.
 */
export function redeSocial(plataforma: string): SocialNetwork | undefined {
  return SOCIAL_NETWORKS.find((rede) => rede.id === plataforma) as SocialNetwork | undefined;
}

/**
 * O valor que a porta INTERMEDIADA grava em `channel_sessions.provider`.
 *
 * Continua existindo porque é uma COLUNA do banco (`channel_sessions_provider_check`
 * em `supabase/baseline.sql`), não uma pergunta de feature: `store.ts` precisa do
 * literal para inserir a sessão. A novidade do #1320 é que ele deixou de ser a
 * identidade do canal social inteiro e passou a ser o valor de UMA das portas —
 * ver `PORTAS_SOCIAIS.intermediada.providerNoBanco`.
 */
export const SOCIAL_PROVIDER = "zernio_social" as const;

/**
 * O nome do parceiro que opera a porta intermediada, para a tela que já o
 * mostrava ("Zernio") — cópia visível, mantida nesta fatia para não mudar
 * comportamento observável de uma tela que ninguém pediu para mudar.
 *
 * NÃO é a identidade do canal: a fronteira neutra é `portasDaRede`, e o rótulo
 * neutro de cada porta é `PortaSocial.rotulo`. Tela nova usa aquele.
 */
export const SOCIAL_PROVIDER_LABEL = "Zernio";

export const inboxSupported = (platform: string): boolean =>
  SOCIAL_NETWORKS.some((network) => network.id === platform && network.inbox);

export function socialMessageId(account: string, id: string): string {
  return `social:${account}:${id}`;
}

/**
 * Regras puras das publicações (docs/agencia/SPEC-publicacoes.md). Sem banco e
 * sem rede: a tela, as ações e o relógio leem daqui.
 */

export const REDES = ["instagram", "facebook", "tiktok", "youtube", "outra"] as const;
export type Rede = (typeof REDES)[number];
export const ROTULO_DA_REDE: Record<Rede, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  outra: "Outra",
};

export const FORMATOS = ["feed", "reels", "story", "carrossel", "video"] as const;
export type Formato = (typeof FORMATOS)[number];
export const ROTULO_DO_FORMATO: Record<Formato, string> = {
  feed: "Feed",
  reels: "Reels",
  story: "Story",
  carrossel: "Carrossel",
  video: "Vídeo",
};

export const SITUACOES_DA_PUBLICACAO = ["rascunho", "em_aprovacao", "aprovada", "agendada", "publicando", "publicada", "falhou", "cancelada"] as const;
export type SituacaoDaPublicacao = (typeof SITUACOES_DA_PUBLICACAO)[number];
export const ROTULO_DA_SITUACAO_DA_PUBLICACAO: Record<SituacaoDaPublicacao, string> = {
  rascunho: "Rascunho",
  em_aprovacao: "Com o cliente",
  aprovada: "Aprovada",
  agendada: "Agendada",
  publicando: "Publicando",
  publicada: "Publicada",
  falhou: "Falhou",
  cancelada: "Cancelada",
};

/** P7: o que a central sabe publicar sozinha. O resto é só à mão. */
export function publicaSozinho(rede: Rede, formato: Formato): boolean {
  if (rede === "instagram") return formato === "feed" || formato === "reels" || formato === "story";
  if (rede === "facebook") return formato === "feed";
  return false;
}

const EXTENSOES_DE_VIDEO = /\.(mp4|mov|m4v)(\?|#|$)/i;
const EXTENSOES_DE_IMAGEM = /\.(jpe?g|png)(\?|#|$)/i;

export function ehVideo(url: string): boolean {
  return EXTENSOES_DE_VIDEO.test(url);
}

/**
 * Link de pasta, de página de visualização ou de serviço que exige login não é
 * mídia: a Meta precisa baixar o arquivo (P5).
 */
export function linkDeMidiaDireto(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  if (/drive\.google\.com|docs\.google\.com|dropbox\.com\/(s|scl)\/|wetransfer\.com|canva\.com\/design/i.test(url)) return false;
  return EXTENSOES_DE_VIDEO.test(url) || EXTENSOES_DE_IMAGEM.test(url);
}

export interface PublicacaoParaAgendar {
  situacao: SituacaoDaPublicacao;
  rede: Rede;
  formato: Formato;
  quando: string;
  midiaUrl: string | null;
  autoPublicar: boolean;
}

/**
 * Por que a publicação ainda não pode ser agendada — ou null quando pode. Só
 * aprovada (ou que falhou e vai tentar de novo) agenda (P8); publicar sozinho
 * pede formato aceito e mídia direta, com antecedência mínima de 5 minutos.
 */
export function problemaParaAgendar(p: PublicacaoParaAgendar, agora: Date): string | null {
  if (p.situacao !== "aprovada" && p.situacao !== "falhou") return "Só publicação aprovada pelo cliente pode ser agendada.";
  if (!p.autoPublicar) return null;
  if (!publicaSozinho(p.rede, p.formato)) return `A central ainda não publica sozinha ${ROTULO_DO_FORMATO[p.formato]} no ${ROTULO_DA_REDE[p.rede]}: marque como publicada quando postar.`;
  if (!p.midiaUrl) return "Falta o link da mídia.";
  if (!linkDeMidiaDireto(p.midiaUrl)) return "O link da mídia precisa ser do próprio arquivo (.jpg, .png, .mp4 ou .mov), público. Link de pasta do Drive não serve.";
  if (p.formato === "reels" && !ehVideo(p.midiaUrl)) return "Reels precisa de vídeo (.mp4 ou .mov).";
  if (p.formato === "feed" && ehVideo(p.midiaUrl)) return "O feed automático aceita imagem (.jpg ou .png); vídeo vai como Reels.";
  if (new Date(p.quando).getTime() < agora.getTime() + 5 * 60_000) return "Escolha um horário daqui a pelo menos 5 minutos.";
  return null;
}

/** Mudou o que o cliente aprovou? Então precisa aprovar de novo (volta a rascunho). */
export function mudouOConteudo(
  antes: { legenda: string | null; midiaUrl: string | null; formato: Formato; rede: Rede },
  depois: { legenda: string | null; midiaUrl: string | null; formato: Formato; rede: Rede },
): boolean {
  return (antes.legenda ?? "") !== (depois.legenda ?? "") || (antes.midiaUrl ?? "") !== (depois.midiaUrl ?? "") || antes.formato !== depois.formato || antes.rede !== depois.rede;
}

/** O mês `AAAA-MM` de um dia `AAAA-MM-DD`, e o primeiro dia de um mês. */
export function mesDe(dia: string): string {
  return dia.slice(0, 7);
}
export function primeiroDia(mes: string): string {
  return `${mes}-01`;
}
export function somarMeses(mes: string, n: number): string {
  const [a, m] = mes.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

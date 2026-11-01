/**
 * O que a tela "App no celular" mostra, decidido de fatos do aparelho.
 *
 * Função pura de propósito: quem lê o navegador é o componente, depois de
 * montar (o servidor não sabe nada disto), e a regra fica testável sem DOM.
 * A ordem importa — cada estado só vale se nenhum anterior valeu.
 */

export type EstadoDoApp =
  | "sem-https"
  | "instalado"
  | "iphone-embutido"
  | "android-embutido"
  | "sem-sw"
  | "iphone"
  | "iphone-outro-navegador"
  | "android-botao"
  | "android-menu"
  | "outro";

export interface AmbienteDoAparelho {
  /** `window.isSecureContext`: sem ele, nenhum navegador instala nem entrega push. */
  readonly seguro: boolean;
  /** Aberto pelo ícone da tela de início. */
  readonly standalone: boolean;
  /** O service worker registrou. Falha em https com certificado não reconhecido. */
  readonly swOk: boolean;
  readonly ua: string;
  readonly plataforma: string;
  readonly toques: number;
  /** `navigator.userAgentData.mobile`. */
  readonly celularPelaDica: boolean;
  /** `(pointer: coarse)`. */
  readonly dedo: boolean;
  /** O navegador ofereceu o pedido de instalação (`beforeinstallprompt`). */
  readonly temPedido: boolean;
}

// Navegador de dentro de outro aplicativo (Instagram, Facebook, Line) e a
// WebView do Android: nenhum tem "Instalar" nem "Adicionar à Tela de Início".
const EMBUTIDO = /\b(Instagram|FBAN|FBAV|Line)\b|\/(FBIOS|FB_IAB)|; wv\)/;
// Chrome, Firefox e Edge do iPhone: adicionam à tela de início desde o iOS
// 16.4, pelo Compartilhar deles, que não fica na "barra do Safari".
const OUTRO_NAVEGADOR_DO_IPHONE = /\b(CriOS|FxiOS|EdgiOS)\//;

export function estadoDoApp(a: AmbienteDoAparelho): EstadoDoApp {
  if (!a.seguro) return "sem-https";
  if (a.standalone) return "instalado";
  // iPad com iPadOS se apresenta como Mac; o toque é o que o entrega.
  const iphone = /iPhone|iPad|iPod/.test(a.ua) || (a.plataforma === "MacIntel" && a.toques > 1);
  const embutido = EMBUTIDO.test(a.ua);
  if (iphone && embutido) return "iphone-embutido";
  // O Chrome em "versão para computador" tira o Android do UA; a dica de
  // celular e o ponteiro de dedo continuam dizendo o que o aparelho é.
  const android = /Android/.test(a.ua) || a.celularPelaDica || (a.dedo && !iphone);
  if (android && embutido) return "android-embutido";
  if (!a.swOk) return "sem-sw";
  if (iphone) return OUTRO_NAVEGADOR_DO_IPHONE.test(a.ua) ? "iphone-outro-navegador" : "iphone";
  if (a.temPedido) return "android-botao";
  if (android) return "android-menu";
  return "outro";
}

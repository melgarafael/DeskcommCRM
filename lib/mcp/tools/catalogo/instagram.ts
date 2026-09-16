/**
 * Capacidades de INSTAGRAM — publicar no feed, reels ou stories do cliente
 * em nome dele.
 *
 * Três capacidades separadas de propósito: conectar (segura, só link),
 * preparar (grava rascunho, sem efeito público) e confirmar (a única que
 * publica de verdade — marcada `critico`, porque é pública, na conta de
 * outra pessoa, e irreversível).
 */
import { declararTools } from "./tipos";

export const TOOLS_INSTAGRAM = declararTools([
  {
    name: "crm_instagram_conectar",
    category: "read",
    rotulo: "Conectar o Instagram do cliente",
    explicacao:
      "Confere se o cliente já autorizou o Instagram dele e, se não, gera um link para o agente mandar pelo WhatsApp. Não muda nada sozinho.",
    oQueToca: "Instagram do cliente",
    risco: "seguro",
    pacotes: ["divulgar"],
  },
  {
    name: "crm_instagram_preparar_post",
    category: "write",
    rotulo: "Preparar um post do Instagram",
    explicacao:
      "A partir da foto ou vídeo que o cliente mandou, monta um rascunho de publicação para o feed, os reels ou os stories — com legenda e hashtags quando o destino permitir. Ainda sem publicar nada.",
    oQueToca: "Instagram do cliente",
    risco: "atencao",
    pacotes: ["divulgar"],
  },
  {
    name: "crm_instagram_confirmar_post",
    category: "write",
    rotulo: "Publicar no Instagram do cliente",
    explicacao:
      "Publica de verdade, na conta do cliente, o que foi preparado — feed, reels ou stories, visível para quem o segue. Não tem como desfazer por aqui.",
    oQueToca: "Instagram do cliente",
    risco: "critico",
    pacotes: ["divulgar"],
  },
]);

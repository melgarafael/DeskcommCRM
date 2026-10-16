/**
 * A prévia que a lista da Inbox mostra (`conversations.last_message_preview`).
 *
 * A régua é a mesma de sempre — texto até 280, ou um rótulo quando não há
 * texto — com UMA exceção, que é o motivo deste arquivo existir (issue #2742): o
 * corpo de um vCard É o cartão (`BEGIN:VCARD…`), e o payload do canal nem sempre
 * traz `body`. Mostrar o texto cru do cartão na lista é vocabulário técnico na
 * tela de quem atende; mostrar o literal `[contact]` é pior, porque some com o
 * nome do contato compartilhado. O nome sai do `FN:` via `parseVcard`
 * (`lib/messaging/contact-card.ts`, o parser que o #2712 já usa) e a prévia vira
 * `Contato: <nome>` — em português, como o resto do que esta coluna grava.
 *
 * Agnóstica de canal, pela MESMA doutrina de `contact-card.ts`: a conversa
 * individual e a de grupo escrevem a MESMA coluna e se autodescrevem como
 * "mesma prévia" — duas cópias desta regra divergiriam na primeira vez que
 * alguém mexesse numa só. Citar os dois caminhos pelo nome de arquivo aqui
 * reprovaria `lint:channels` (invariante 1: só a fronteira de canal nomeia o
 * transporte), então o caminho é o import logo abaixo.
 */
import { parseVcard } from "@/lib/messaging/contact-card";

/** Teto histórico da coluna — o valor que `previewFromMessage` já usava. */
const LIMITE = 280;

/**
 * O rótulo de cada tipo quando a mensagem não tem corpo (#2742, item 2 do
 * enunciado: "o mesmo cuidado para os outros tipos").
 *
 * Antes desta régua, toda mensagem sem `body` caía em `` `[${tipo}]` `` e a lista
 * mostrava `[image]`, `[audio]`, `[video]`… — o vocabulário do wire em inglês na
 * tela de quem atende. Aqui cada tipo ganha a MESMA palavra que o balão da
 * conversa já usa para ele (`components/inbox/media/MediaRenderer.tsx`,
 * `LocationCard`), e não uma nova: a palavra já tem tradução no dicionário de
 * espanhol (`lib/i18n/dicionario.ts`) porque a tela já a mostra. É de propósito
 * — uma prévia que inventasse o próprio vocabulário divergiria do balão logo na
 * primeira revisão de copy.
 *
 * `text` NÃO entra: mensagem de texto sem corpo é "sem mensagem" (a lista põe
 * "Sem mensagens"), não um rótulo de tipo.
 */
export const ROTULO_DO_TIPO: Record<string, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização compartilhada",
  contact: "Contato",
  reaction: "Reação",
  system: "Sistema",
};

/**
 * Prévia de UMA mensagem, dada pelo corpo (quando existe) e pelo tipo já
 * resolvido (`resolveMessageType` / `EntradaDeGrupo.type`).
 *
 * Nunca devolve texto cru de cartão ilegível: um `BEGIN:VCARD` sem `FN:` legível
 * cai no rótulo de tipo (`Contato`), que é o comportamento antigo — só que agora
 * em português.
 *
 * Tipo que NÃO está em `ROTULO_DO_TIPO` é valor de wire desconhecido: devolve o
 * próprio tipo entre colchetes para a prévia nunca virar vazia nem derrubar a
 * lista (`conversation.last_message_preview?.trim()` não pode receber `null`).
 * O token cru ali é diagnóstico, não prosa de tela — e é o que resta quando o
 * canal inventa um tipo que o CRM ainda não conhece.
 */
export function previaDaMensagem(body: string | null | undefined, tipo: string): string {
  if (body) {
    if (body.includes("BEGIN:VCARD")) {
      const nome = parseVcard(body)?.name;
      if (nome) return `Contato: ${nome}`.slice(0, LIMITE);
    } else if (tipo === "contact") {
      // `contactMessage.displayName` — o nome que o payload traz quando não há
      // cartão. Já é nome de gente; só ganha o rótulo que o cartão ganharia.
      return `Contato: ${body.trim()}`.slice(0, LIMITE);
    } else {
      return body.slice(0, LIMITE);
    }
  }
  if (tipo === "text") return "";
  return ROTULO_DO_TIPO[tipo] ?? `[${tipo}]`;
}

/**
 * Cópia pra área de transferência que funciona TAMBÉM em contexto não-seguro
 * (self-host servindo http://IP): `navigator.clipboard` só existe em
 * isSecureContext — fora dele o fallback usa textarea + execCommand('copy').
 *
 * Regra do repo (teste-régua): componente client NUNCA chama
 * navigator.clipboard direto — sempre este helper.
 */

/**
 * Container do fallback do textarea.
 *
 * Dentro de painel modal com focus trap (Sheet/Dialog — `role="dialog"`,
 * `aria-modal`), o trap segura o foco na árvore do diálogo: um textarea
 * anexado em `document.body` fica FORA da árvore, o trap recusa a seleção e
 * o `execCommand('copy')` copia nada ou devolve false (#2580, "Endereço da
 * fonte" em Webhooks). Sobe do elemento ativo até o nó de diálogo mais
 * próximo; sem diálogo aberto devolve `document.body` — o comportamento de
 * sempre dos demais call sites.
 */
function containerDoFallback(): Element {
  let atual: Element | null = document.activeElement;
  while (atual) {
    if (atual.matches('dialog, [role="dialog"], [role="alertdialog"]')) return atual;
    atual = atual.parentElement;
  }
  return document.body;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permissão negada / documento sem foco — tenta o fallback abaixo
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  // #2580: o textarea nasce DENTRO do diálogo/elemento ativo (focus trap) e
  // recebe focus() ANTES de select() — browsers só selecionam o textarea
  // focado, e fora da árvore do diálogo o trap bloqueia a seleção.
  // O focus() acima tira o foco do botão em TODO caminho de reserva (com ou
  // sem diálogo), e o textarea é removido logo depois: sem devolver, o foco
  // cai no body e quem usa teclado/leitor de tela perde o lugar.
  const focoAnterior = document.activeElement;
  containerDoFallback().appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  if (focoAnterior instanceof HTMLElement) focoAnterior.focus({ preventScroll: true });
  return ok;
}

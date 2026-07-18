/**
 * Cópia pra área de transferência que funciona TAMBÉM em contexto não-seguro
 * (self-host servindo http://IP): `navigator.clipboard` só existe em
 * isSecureContext — fora dele o fallback usa textarea + execCommand('copy').
 *
 * Regra do repo (teste-régua): componente client NUNCA chama
 * navigator.clipboard direto — sempre este helper.
 */
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
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

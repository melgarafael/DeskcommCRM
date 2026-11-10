/**
 * OS BOTÕES QUE UM MODELO APROVADO LEVOU AO CLIENTE — gravados na mensagem.
 *
 * Um modelo (template) com respostas rápidas chega ao cliente com o texto E os
 * botões ("Sim, confirmo", "Quero mudar algo"). A conversa do CRM mostrava só
 * o texto, e quem lia não sabia que aquilo tinha saído por modelo nem quais
 * opções o cliente recebeu — e a resposta dele ("Quero mudar algo") aparecia
 * solta, sem a pergunta que a originou.
 *
 * O envio grava os textos dos botões em `messages.metadata.template_buttons`
 * (`app/api/v1/messages/_handler.ts`), lidos do espelho da definição NO MOMENTO
 * do envio: é o que o cliente recebeu, e continua sendo mesmo que o modelo seja
 * editado depois. O balão não faz join — o que não está na linha não aparece.
 *
 * Puro e sem dependência de servidor: o balão (cliente) usa `lerBotoesDoModelo`;
 * o handler usa `botoesDoModelo` sobre os `components` do espelho.
 */

/** A chave em `messages.metadata`. Uma constante, para as duas pontas não divergirem. */
export const CHAVE_DOS_BOTOES_DO_MODELO = "template_buttons";

/** A plataforma aceita até 10 botões num modelo; mais que isso não é dado válido. */
const MAXIMO_DE_BOTOES = 10;

function textos(lista: unknown): string[] {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim())
    .slice(0, MAXIMO_DE_BOTOES);
}

/**
 * Os textos dos botões de uma definição, na ordem. Aceita o componente em
 * maiúscula (como a plataforma devolve) ou minúscula (como ela aceita na
 * escrita), e qualquer tipo de botão — resposta rápida, link ou telefone: o que
 * importa para quem lê a conversa é o que o cliente viu.
 */
export function botoesDoModelo(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const grupo = components.find(
    (c): c is { buttons?: unknown } =>
      c !== null && typeof c === "object" && String((c as { type?: unknown }).type ?? "").toUpperCase() === "BUTTONS",
  );
  if (!grupo || !Array.isArray(grupo.buttons)) return [];
  return textos(grupo.buttons.map((b) => (b !== null && typeof b === "object" ? (b as { text?: unknown }).text : null)));
}

/** Os botões gravados numa mensagem, ou `[]` — nunca lança: `metadata` é jsonb aberto. */
export function lerBotoesDoModelo(metadata: Record<string, unknown> | null | undefined): string[] {
  return textos(metadata?.[CHAVE_DOS_BOTOES_DO_MODELO]);
}

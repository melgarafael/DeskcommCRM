/**
 * O TEXTO DO MODELO NO FORMATO QUE O WHATSAPP ENTENDE.
 *
 * Dois defeitos medidos em conversas reais (26/09/2026, Claude Haiku 4.5, atendimento em espanhol):
 *
 *   1. às vezes o modelo escreve o salto de linha ESCAPADO — os caracteres
 *      `\` e `n` — e o cliente lê "Tómate tu tiempo.\n\nCualquier duda…";
 *   2. o modelo usa negrito de Markdown (`**texto**`), mas o WhatsApp usa
 *      `*texto*`: os asteriscos duplos aparecem na tela do cliente.
 *
 * Pura: sem I/O. Aplicada no `send_message` antes de qualquer gate, para que o
 * que se mede (pausa humana, spinning, bolhas) seja o que o cliente recebe, e
 * no texto de `gerarAbordagemDeFormulario` (ação `send_ai_message` e
 * prospecção), que vai ao cliente sem passar pelo `send_message`.
 */
export function formatarParaWhatsApp(texto: string): string {
  let t = texto;

  // 1. Saltos de linha escapados viram saltos de verdade.
  t = t.replace(/\\r\\n|\\n|\\r/g, '\n');

  // 2. Markdown → WhatsApp.
  // O título vem PRIMEIRO e sai sem a ênfase de dentro: o WhatsApp não aninha
  // negrito, e `## **Serviços**` virava `**Serviços**` — os asteriscos duplos
  // que esta função existe para tirar — quando o negrito rodava antes.
  t = t.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_, titulo: string) => `*${titulo.replace(ENFASE_DO_TITULO, '$2')}*`);
  // `__x__` é negrito no Markdown (CommonMark), por isso também vira `*x*`.
  t = t.replace(NEGRITO_DO_MARKDOWN, '*$2*');

  // 3. Espaços no fim da linha e mais de uma linha em branco seguida.
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

// Ênfase só conta quando o par abre e fecha FORA de palavra, de caminho e de
// parâmetro de link: `?__hstc=1&__hssc=2`, `/__init__`, `__init__.py` e
// `ab**cd**ef` (senha, código) não são ênfase — trocar um caractere ali quebra
// o link. Limite conhecido: depois de `-` ou `.` ainda converte
// (`https://x.com/a-__b__` → `a-*b*`).
const FORA_ANTES = String.raw`(?<![\p{L}\p{N}_*/?&=])`;
const FORA_DEPOIS = String.raw`(?![\p{L}\p{N}_*/]|[.?&=][\p{L}\p{N}])`;
const NEGRITO_DO_MARKDOWN = new RegExp(String.raw`${FORA_ANTES}(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1${FORA_DEPOIS}`, 'gu');
const ENFASE_DO_TITULO = new RegExp(String.raw`${FORA_ANTES}(\*\*|__|\*)(?=\S)([^\n]+?)(?<=\S)\1${FORA_DEPOIS}`, 'gu');

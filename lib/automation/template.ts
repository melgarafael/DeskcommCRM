import { resolveField } from "@/lib/automation/conditions";
import { valorComRotulo } from "@/lib/automation/campos-do-render";
import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { RESERVA_DA_VARIAVEL } from "@/lib/texto/reserva-da-variavel";

/**
 * A marcação `{{caminho}}` ou `{{caminho|"reserva"}}`. Grupo 1 = caminho,
 * grupo 2 = reserva (ausente quando não há). Compartilhada com o follow-up.
 */
export const MARCACAO = new RegExp(String.raw`\{\{\s*([\w.]+)\s*${RESERVA_DA_VARIAVEL}\}\}`, "g");

const ALIASES: Record<string, string> = {
  nome: "contact.name",
  primeiro_nome: "contact.name",
  telefone: "contact.phone_number",
  email: "contact.email",
};

/**
 * A marcação tem dono no CRM (contato ou negócio) — e por isso NÃO se preenche
 * de fora.
 *
 * Existe para quem recebe valor de terceiro (as variáveis do integrador em
 * `lib/operacao/modelos-de-mensagem.ts`): `{{nome}}` é alias de `contact.name`,
 * então um valor mandado para "nome" seria descartado em silêncio pelo render
 * — e quem mandou receberia o texto com a marcação vazia achando que preencheu.
 * A régua é por NOME, e não pelo dado: sem contato informado a marcação também
 * estaria vazia, e aí a recusa sumiria justamente no caso mais enganoso.
 */
export function marcacaoDoCrm(nome: string): boolean {
  return ALIASES[nome] !== undefined || nome.startsWith("contact.") || nome.startsWith("lead.");
}

/**
 * `{{servico}}` como atalho de `{{lead.custom_fields.servico}}`.
 *
 * Quem escreve a mensagem digita o nome do campo que o formulário mandou, e não
 * o caminho interno do banco. Só vale para nome SIMPLES (sem ponto) e só como
 * ÚLTIMO recurso: alias e caminho direto continuam ganhando, então nenhum
 * template que já funcionava muda de resultado. Lista (multiselect) sai
 * separada por vírgula, que é como a pessoa leria — e, quando o funil declarou
 * as opções, com o RÓTULO de cada uma (#3605, ver `valorComRotulo`).
 */
function campoPersonalizadoDoLead(context: Record<string, unknown>, nome: string): unknown {
  // Alias é marcação do CRM e tem dono: contato sem nome fica vazio, não pega
  // um campo do formulário que por acaso se chame igual.
  if (nome.includes(".") || ALIASES[nome] !== undefined) return undefined;
  const lead = context.lead;
  if (!lead || typeof lead !== "object") return undefined;
  const campos = (lead as { custom_fields?: unknown }).custom_fields;
  if (!campos || typeof campos !== "object" || Array.isArray(campos)) return undefined;
  // Só campo PRÓPRIO: `{{constructor}}` ou `{{toString}}` não podem puxar do protótipo.
  if (!Object.hasOwn(campos, nome)) return undefined;
  // A lista sai CRUA (array inclusive): quem junta e traduz é o `valorComRotulo`
  // logo abaixo, com o separador e o rótulo que o domínio usa (#3605).
  return (campos as Record<string, unknown>)[nome];
}

/**
 * Campos do contato que SÓ A EQUIPE vê e que nenhuma mensagem renderiza, nem
 * pedidos pelo caminho (`{{contact.address_book_name}}`). O contexto da
 * automação carrega a linha inteira do contato (`select("*")`), então a guarda
 * mora aqui, onde todo texto de automação e de modelo de mensagem passa. O nome
 * da agenda é o rótulo que alguém da empresa escreveu no celular e pode ser um
 * apelido interno (decisão do mantenedor no PR #2439).
 */
const SO_DA_EQUIPE = new Set(["contact.address_book_name"]);

/**
 * A chave do campo personalizado que `path` está pedindo — ou `null` quando a
 * marcação não fala de campo personalizado.
 *
 * Três formas contam: o atalho (`{{destino}}`), o caminho do negócio
 * (`{{lead.custom_fields.destino}}`) e o do contato, para campo de escopo
 * `contato` (#2791). Alias de CRM (`{{nome}}`, `{{telefone}}`) NUNCA conta: o
 * valor dele é do contato, e traduzi-lo por uma opção de campo homônimo
 * trocaria o nome da pessoa pelo rótulo de um pacote.
 */
function chaveDoCampoPersonalizado(path: string): string | null {
  if (!path.includes(".")) return ALIASES[path] === undefined ? path : null;
  const [raiz, meio, chave] = path.split(".");
  if (!chave || meio !== "custom_fields") return null;
  return raiz === "lead" || raiz === "contact" ? chave : null;
}

/**
 * `formatarValor` recebe cada VALOR já resolvido, nunca o template: quem
 * renderiza para HTML escapa o que veio do contato/negócio e mantém a marcação
 * que o operador escreveu.
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  formatarValor: (valor: string) => string = (valor) => valor,
): string {
  return template.replace(MARCACAO, (_m, path: string, reserva: string | undefined) => {
    if (SO_DA_EQUIPE.has(path)) return "";
    // `{{nome}}` fala com a pessoa: segue a régua única de nome de gente
    // (cadastrado, depois o perfil do WhatsApp). Contato que chega pelo
    // WhatsApp tem `name` nulo — só `contact.name` saía "Olá , ...".
    const resolved =
      path === "nome" || path === "primeiro_nome"
        ? nomeDoContato(context.contact as ContatoNomeavel | undefined)
        : (resolveField(context, ALIASES[path] ?? path) ?? campoPersonalizadoDoLead(context, path));
    // Campo de LISTA guarda o CÓDIGO da opção no card (`paris-franca`), e o
    // cliente lê o rótulo (#3605). O mapa só existe quando quem montou o
    // contexto o hidratou (`hidratarCamposDoFunil`); sem ele, o valor sai como
    // sempre saiu — nenhuma mensagem que hoje está certa muda.
    const chave = chaveDoCampoPersonalizado(path);
    const legivel = chave === null ? resolved : valorComRotulo(context, chave, resolved);
    // `{{primeiro_nome}}` = primeira palavra do nome, como no Inbox e na campanha.
    const texto = String(legivel ?? "");
    const valor = path === "primeiro_nome" ? (texto.trim().split(/\s+/)[0] ?? "") : texto;
    // Sem o dado, a reserva que quem escreveu a mensagem deixou. Ela é texto do
    // operador (como o resto do corpo), não valor do contato: não passa por `formatarValor`.
    if (reserva !== undefined && valor.trim() === "") return reserva;
    return formatarValor(valor);
  });
}

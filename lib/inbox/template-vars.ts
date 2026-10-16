import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { MidiaDeTemplate } from "@/lib/templates/midias";

/**
 * Interpola variáveis de template com dados do contato da conversa (Onda 5).
 * Suporta {{nome}} e {{primeiro_nome}}. Variável sem valor ou desconhecida
 * mantém o literal `{{x}}` — nunca gera texto quebrado que iria pro cliente.
 *
 * O nome resolvido cai de `name` para `displayName` (#2744): contato que só
 * tem `display_name` (o caso do contato criado pela ingestão do canal, que
 * grava só o nome do perfil) não podia mandar `{{nome}}` literal pro cliente.
 */
export interface TemplateContact {
  name?: string | null;
  /**
   * Nome do perfil gravado pela ingestão (`contacts.display_name`), usado como
   * fallback quando `name` está vazio. Opcional: consumidores antigos do
   * compositor ainda não passam.
   */
  displayName?: string | null;
}

/** Variáveis que o contato tem que preencher — as outras sempre ficam cruas. */
const VARIAVEIS_DE_NOME = ["nome", "primeiro_nome"];

function regexDaVariavel(key: string): RegExp {
  return new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "i");
}

/**
 * Nome completo a usar: a regra central de `nomeDoContato` — `name` (CRM) vence,
 * vazio cai no `displayName` (canal), e identificador técnico (`Contato 5431@lid`)
 * nunca vira nome. Sem nome de gente, string vazia: o literal sobrevive.
 */
function nomeResolvido(contact: TemplateContact): string {
  return nomeDoContato({ name: contact.name, display_name: contact.displayName }) ?? "";
}

/**
 * `true` quando o corpo tem `{{nome}}`/`{{primeiro_nome}}` e o contato não tem
 * NENHUM dos dois nomes: o literal sobrevive à interpolação, e o operador
 * precisa saber disso antes de mandar (issue #2744). Chave desconhecida não
 * conta — `{{codigo}}` cru é comportamento esperado, não acidente de nome.
 */
export function faltouNomeDeContato(body: string, contact: TemplateContact): boolean {
  if (nomeResolvido(contact) !== "") return false;
  return VARIAVEIS_DE_NOME.some((key) => regexDaVariavel(key).test(body));
}

/**
 * Motivo FIXO que acompanha o botão quando a RESPOSTA é barrada pelo curinga
 * literal (#2744). Um literal, não dois: o gate (a trava de envio) e a faixa
 * visível leem daqui, e quem vê o motivo vê exatamente a razão pela qual o
 * código barrou. A faixa é persistente (não o toast que some) porque o operador
 * precisa editar o texto antes de mandar — e o motivo tem de continuar na tela
 * enquanto ele edita.
 */
export const MOTIVO_CURINGA_LITERAL =
  "Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar.";

/**
 * O motivo pelo qual a RESPOSTA ao cliente não pode sair — `null` quando pode.
 *
 * Só a RESPOSTA: a nota interna nunca chega ao cliente e continua sendo o lugar
 * onde o atendente registra por que a conversa esfriou. É a mesma fronteira do
 * `janelaFechada` no compositor (#2744, opção A).
 *
 * O gate é sobre o literal SOBREVIVENTE, não sobre a string `{{`: contato com
 * nome (ou `display_name` de gente) não sofre bloqueio nenhum — `{{nome}}`
 * resolve e some do texto. Chave desconhecida (`{{codigo}}`) também não conta.
 * Por isso delega para `faltouNomeDeContato`, que já carrega essa regra.
 */
export function motivoDoCuringaLiteral(
  body: string,
  contact: TemplateContact,
): string | null {
  return faltouNomeDeContato(body, contact) ? MOTIVO_CURINGA_LITERAL : null;
}

/** O que uma resposta rápida guarda além do texto (#2526). */
export interface RespostaRapida {
  /**
   * O `id` do template (linhas de `message_templates`). O payload só lê `body`
   * e `midias`, mas recebe a linha COMPLETA vind do hook — escondê-lo no
   * chamador obrigaria a todo mundo a remapear para dentro.
   */
  id?: string;
  body: string;
  /** `undefined`/`null` em linha antiga e em teste — os dois são "só texto". */
  midias?: readonly MidiaDeTemplate[] | null;
}

/**
 * O PAYLOAD DE USO (#2526): o que a escolha da resposta rápida entrega ao
 * compositor, pronto para virar uma mensagem editável.
 *
 * `texto` é o corpo interpolado — a legenda da PRIMEIRA imagem quando há mídia,
 * o mesmo contrato do envio de mídia que já existe —, e `midias` são as
 * imagens que o próprio operador carregou no template, na ordem gravada.
 *
 * O `slice` devolve uma lista NOVA de propósito: o compositor embaralha a fila
 * de envio, e embaralhar a lista do cache do React Query mudaria o que a tela
 * de templates mostra sem ninguém ter mexido nela.
 */
export function payloadDeUso(
  template: RespostaRapida,
  contact: TemplateContact,
): { texto: string; midias: MidiaDeTemplate[] } {
  return {
    texto: interpolateTemplate(template.body, contact),
    midias: [...(template.midias ?? [])],
  };
}

export function interpolateTemplate(body: string, contact: TemplateContact): string {
  const full = nomeResolvido(contact);
  const first = full.split(/\s+/)[0] ?? "";
  return body.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (literal, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (key === "nome") return full !== "" ? full : literal;
    if (key === "primeiro_nome") return first !== "" ? first : literal;
    return literal; // desconhecida: mantém
  });
}

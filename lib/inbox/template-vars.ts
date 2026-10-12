import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

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

import {
  MARCACAO_DE_VARIAVEL,
  chaveDoCampoPersonalizado,
  resolverVariaveis,
  type InstanteDoEnvio,
} from "@/lib/variaveis/resolvedor";

/**
 * A marcação `{{caminho}}`, `{{caminho|"reserva"}}` ou `{{caminho|data}}`. A
 * forma mora no resolvedor único (`lib/variaveis/resolvedor.ts`) desde o #3687:
 * era o primeiro lugar onde as telas divergiam — o Inbox não casava ponto nem
 * número. A ORDEM dos grupos é contrato (1 = caminho, 2 = reserva, 3 =
 * modificador da data, #4339): quem já lia 1 e 2 continua lendo os mesmos dois.
 */
export const MARCACAO = MARCACAO_DE_VARIAVEL;

/** Quem mexe em caminho de campo personalizado precisa da mesma regra de chave. */
export { chaveDoCampoPersonalizado };

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
 * O texto da automação com os dados do contato e do negócio.
 *
 * `formatarValor` recebe cada VALOR já resolvido, nunca o template: quem
 * renderiza para HTML escapa o que veio do contato/negócio e mantém a marcação
 * que o operador escreveu. `agora` é o instante do envio (fuso do canal) e só
 * ele faz `{{saudacao}}` resolver; sem ele o token fica literal, como no
 * editor.
 *
 * A conta é do resolvedor único (#3687): `quandoVazio: "vazio"` é a política
 * desta tela — sem valor, string vazia, que é o que `automation_rules` já
 * gravado espera. É ele também que aplica `{{campo|data}}` (#4339), no idioma e
 * no fuso que o contexto traz em `__render` — a mesma conta nas quatro telas.
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  formatarValor: (valor: string) => string = (valor) => valor,
  agora?: InstanteDoEnvio,
): string {
  return resolverVariaveis(template, context, {
    fonte: "automacao",
    quandoVazio: "vazio",
    agora,
    formatarValor,
  }).texto;
}

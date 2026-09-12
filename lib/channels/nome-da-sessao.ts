/**
 * O nome da sessão que o CRM manda para o WAHA, num lugar só.
 *
 * ─── Por que este arquivo existe ───────────────────────────────────────────
 *
 * O formato curto (`org_` + os 8 primeiros caracteres do uuid da organização —
 * 12 no total) nasceu dentro da tela de onboarding. O banco montava o dele por
 * conta própria, e por um tempo montou `org_<32>_<32>`: 69 caracteres, acima do
 * `@MaxLength(54)` do WAHA, que responde
 * `400 name must be shorter than or equal to 54 characters`.
 *
 * O onboarding escapava porque gastava o formato curto. O botão "Conectar novo
 * WhatsApp" da tela de Conexões, que gasta o nome vindo do banco, falhava
 * SEMPRE — e o operador só via o card preso em `Parado`.
 *
 * Duas lições ficaram, e são as duas regras deste arquivo:
 *
 *   1. superfície não monta o nome da sessão à mão; deriva daqui;
 *   2. o teto é conferido do lado do CRM — descobrir o limite por um 400 opaco
 *      do transporte, depois da reserva feita, é o que prendia o card.
 */

/**
 * Teto do `name` de sessão no WAHA (`@MaxLength(54)`).
 *
 * Não é folga: é o limite do outro lado. Mudar aqui só com o WAHA mudando lá.
 */
export const TETO_NOME_DE_SESSAO_WAHA = 54;

/**
 * Formato curto e estável da sessão — o mesmo que o onboarding sempre usou.
 *
 * O prefixo `org_` não é decorativo: `lib/channels/onboarding-session.ts`
 * procura exatamente esta string para achar a linha legada da própria
 * organização. Mudar o formato aqui é mudar a busca lá.
 */
export function nomeCurtoDaSessao(organizationId: string): string {
  return `org_${organizationId.slice(0, 8)}`;
}

/** O nome cabe no teto do WAHA? Falso = não pode chegar ao transporte. */
export function nomeDaSessaoCabeNoWaha(nome: string): boolean {
  return nome.length <= TETO_NOME_DE_SESSAO_WAHA;
}

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
 * A migration 0232 consertou o gerador no banco e renomeou as linhas que já
 * estavam fora do teto. Três regras ficaram, e são as três deste arquivo:
 *
 *   1. superfície não monta o nome da sessão à mão; deriva daqui;
 *   2. o teto é conferido do lado do CRM — descobrir o limite por um 400 opaco
 *      do transporte, depois da reserva feita, é o que prendia o card;
 *   3. o que dá para curar em runtime é curado sob a MESMA condição da 0232, e
 *      só ela. O resto para aqui, com motivo próprio.
 */

/**
 * Teto do `name` de sessão no WAHA (`@MaxLength(54)`).
 *
 * Não é folga: é o limite do outro lado. Mudar aqui só com o WAHA mudando lá.
 */
export const TETO_NOME_DE_SESSAO_WAHA = 54;

/** O `@Matches` do mesmo DTO. Um nome fora dele toma o mesmo 400. */
const PADRAO_NOME_DE_SESSAO_WAHA = /^[a-zA-Z0-9_-]+$/;

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

/** O nome cabe no que o WAHA aceita? Falso = não pode chegar ao transporte. */
export function nomeDaSessaoCabeNoWaha(nome: string): boolean {
  return nome.length <= TETO_NOME_DE_SESSAO_WAHA && PADRAO_NOME_DE_SESSAO_WAHA.test(nome);
}

/**
 * O mesmo formato que a 0232 passou a gerar no banco: `org_<8>_<32>` = 45.
 *
 * Gera com o `crypto` global (Node 22 e Edge têm), não com `node:crypto`: este
 * módulo é importado por `app/onboarding/connect-whatsapp/page.tsx`, e um
 * import de builtin aqui amarraria a tela ao runtime Node sem precisar.
 */
export function nomeDaSessaoNovo(organizationId: string, unico = crypto.randomUUID()): string {
  return `org_${organizationId.replaceAll("-", "").slice(0, 8)}_${unico.replaceAll("-", "")}`;
}

/**
 * Renomear este canal é seguro? É a condição EXATA do backfill da 0232 —
 * `phone_number is null and status <> 'WORKING'` — e a igualdade não é
 * estética.
 *
 * O WAHA guarda a credencial da sessão numa pasta com o NOME da sessão
 * (`/app/.sessions/<name>`). Renomear um canal que pareou de verdade deixa o
 * CRM apontando para uma sessão que não existe e abandona a que existe: o
 * número some do sistema e só volta com um QR novo. Ou seja, a guarda frouxa
 * não é feiura — é perda de canal em produção.
 *
 * `phone_number` é quem carrega o peso. `status` entra porque a 0232 o tem,
 * mas ele NÃO protege o caminho de conectar: `fn_reserve_channel_connection`
 * grava `status='STARTING'` na linha e devolve essa linha, então o status que
 * chega aqui é sempre `STARTING`, nunca `WORKING`. Uma guarda que olhasse só o
 * status renomearia um canal pareado e parado — exatamente o caso perigoso.
 */
export function podeRenomearSessaoDoWaha(
  canal: { phone_number?: string | null; status?: string | null },
): boolean {
  return (canal.phone_number ?? null) === null && canal.status !== "WORKING";
}

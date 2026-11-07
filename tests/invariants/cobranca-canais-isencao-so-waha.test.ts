import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { assinar, chaveDeCobranca, criarOrg, criarPlano, erroDe, uuid, valor } from "./cobranca-helpers";

/**
 * A ISENÇÃO DE VAGA DA LINHA MORTA SEM NÚMERO VALE SÓ PARA O WAHA (#3416).
 *
 * A 0809 tira da conta a linha `FAILED`/`STOPPED` sem `phone_number` — a sessão
 * de um QR que ninguém leu. Essa leitura só é verdadeira no WAHA, em que o
 * número é o que identifica a vaga e é gravado no pareamento. Nos outros
 * provedores (`zernio`, `zernio_social`, `meta_cloud`, `datafy`) a conexão não
 * se identifica por `phone_number`, e uma linha deles sem número segue sendo
 * uma conexão da empresa: ocupa a vaga, morta ou não.
 *
 * A régua é a MESMA nos três lugares, e este arquivo cobra os dois do banco:
 *   · o gatilho `fn_trava_canais_do_plano` (a isenção do `new` e o `count`);
 *   · `fn_vaga_ao_reviver_canal` (9036), que só confere a vaga de quem hoje
 *     não ocupa;
 *   · e o gêmeo do app, `lerUsoDaOrganizacao` — vigiado em `lib/cobranca/uso.test.ts`.
 */

const P = "c0b0000a-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const canal = (n: number) => uuid(P, 100 + n);
const PLANO_1 = uuid(P, 901);

type Estado = "STARTING" | "SCAN_QR_CODE" | "WORKING" | "STOPPED" | "FAILED";

/** Canal de provedor que não é WAHA: endereçado por `zernio_account_id`, sem número. */
function canalSocial(id: string, orgId: string, estado: Estado): string {
  return `insert into public.channel_sessions
    (id, organization_id, provider, zernio_account_id, webhook_secret_encrypted, status)
    values ('${id}', '${orgId}', 'zernio_social', 'zac-${id.slice(-12)}', '\\x00'::bytea, '${estado}')`;
}

function canalWaha(id: string, orgId: string, estado: Estado, telefone: string | null = null): string {
  return `insert into public.channel_sessions
    (id, organization_id, waha_session_name, webhook_secret_encrypted, status, phone_number)
    values ('${id}', '${orgId}', 'cob-${id.slice(-12)}', '\\x00'::bytea, '${estado}',
            ${telefone === null ? "null" : `'${telefone}'`})`;
}

beforeAll(() => {
  criarPlano({ id: PLANO_1, nome: "Um número conectado", maxCanais: 1 });
  for (let n = 1; n <= 5; n++) criarOrg(org(n), `cob-isencao-waha-${n}`);
  chaveDeCobranca("ligado");
});

describe("inv. 6d — a isenção de vaga sem número é do WAHA", () => {
  it("⭐ FAILED sem número de provedor que não é WAHA continua ocupando a vaga", () => {
    assinar(org(1), PLANO_1);
    sql(`${canalSocial(canal(1), org(1), "FAILED")};`);
    // Com a vaga ocupada pela conexão social, a conexão seguinte é recusada.
    expect(erroDe(`${canalWaha(canal(2), org(1), "STARTING")};`)).toContain("limite_do_plano:canais:1");
  });

  it("⭐ a linha morta sem número de outro provedor não nasce isenta no teto", () => {
    assinar(org(2), PLANO_1);
    sql(`${canalWaha(canal(3), org(2), "WORKING", "5511900000013")};`);
    const e = erroDe(`${canalSocial(canal(4), org(2), "STOPPED")};`);
    expect(e).toContain("PT402");
    expect(e).toContain("limite_do_plano:canais:1");
  });

  it("⭐ reviver a linha social morta não passa pela conferência de quem não ocupa (ela já ocupa)", () => {
    assinar(org(3), PLANO_1);
    sql(`${canalSocial(canal(5), org(3), "FAILED")};`);
    expect(
      erroDe(`set role service_role; select public.fn_vaga_ao_reviver_canal('${org(3)}', '${canal(5)}');`),
    ).toBe("");
    // A função só TOMA vaga de quem não ocupava; a linha social já ocupava,
    // então nada é tomado nem recontado aqui.
    expect(valor(`select status from public.channel_sessions where id = '${canal(5)}';`)).toBe("FAILED");
  });

  it("CONTROLE: no WAHA, FAILED sem número segue fora da conta", () => {
    assinar(org(4), PLANO_1);
    sql(`${canalWaha(canal(6), org(4), "FAILED")};`);
    expect(erroDe(`${canalWaha(canal(7), org(4), "STARTING")};`)).toBe("");
  });

  it("CONTROLE: fora do teto, a linha social morta entra normalmente", () => {
    assinar(org(5), PLANO_1);
    expect(erroDe(`${canalSocial(canal(8), org(5), "FAILED")};`)).toBe("");
  });
});

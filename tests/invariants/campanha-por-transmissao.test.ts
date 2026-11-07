/**
 * MIGRATION 0712 — campanha por transmissão (broadcast) do provedor.
 *
 * O que só o banco prova: `transmissao` entra no vocabulário fechado de
 * `velocidade`, continua presa a modelo aprovado pelo CHECK da 0711, e o id da
 * transmissão é ÚNICO por organização — é por ele que o eco de cada mensagem
 * volta à campanha, e dois ecos apontando para duas campanhas misturariam os
 * relatórios.
 */
import { describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const COM_MODELO = `organization_id, name, channel_session_id, base_legal, message_mode,
  provider_template_name, provider_template_language, velocidade`;

describe("0712: campanha por transmissão do provedor", () => {
  it("transmissão com modelo aprovado passa", () => {
    seedGov();
    sql(`insert into public.campaigns (${COM_MODELO})
           values ('${GOV_ORG}', 'broadcast oficial', '${GOV_SESSION}', 'consent', 'template', 'oferta', 'pt_BR', 'transmissao');`);
    expect(sql(`select velocidade from public.campaigns where name = 'broadcast oficial';`)).toBe("transmissao");
  });

  it("transmissão com texto livre (número por QR) é recusada pelo CHECK da 0711", () => {
    seedGov();
    expect(() =>
      sql(`insert into public.campaigns (organization_id, name, channel_session_id, base_legal, message_mode, velocidade)
             values ('${GOV_ORG}', 'broadcast por QR', '${GOV_SESSION}', 'consent', 'text', 'transmissao');`),
    ).toThrow(/campaigns_rapida_so_com_modelo/);
  });

  it("o id da transmissão nasce vazio e é único por organização", () => {
    seedGov();
    sql(`insert into public.campaigns (${COM_MODELO}, provider_broadcast_id)
           values ('${GOV_ORG}', 'broadcast A', '${GOV_SESSION}', 'consent', 'template', 'oferta', 'pt_BR', 'transmissao', 'bc-unico');`);
    sql(`insert into public.campaigns (${COM_MODELO})
           values ('${GOV_ORG}', 'broadcast B', '${GOV_SESSION}', 'consent', 'template', 'oferta', 'pt_BR', 'transmissao');`);
    expect(sql(`select coalesce(provider_broadcast_id, 'vazio') from public.campaigns where name = 'broadcast B';`)).toBe(
      "vazio",
    );
    expect(() =>
      sql(`update public.campaigns set provider_broadcast_id = 'bc-unico' where name = 'broadcast B';`),
    ).toThrow(/campaigns_provider_broadcast_id_uidx/);
  });
});

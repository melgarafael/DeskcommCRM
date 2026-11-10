/**
 * MIGRATION 0711 — campanha com envio rápido.
 *
 * O que só o banco prova: `velocidade` é vocabulário FECHADO, toda campanha
 * que já existia fica `gradual`, e rápida só existe com modelo aprovado — a
 * rajada por um número por QR é o caminho mais curto para o banimento, e a
 * regra não pode depender de a API ter conferido.
 */
import { describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

describe("0711: campanha com envio rápido", () => {
  it("velocidade nasce `gradual` para toda campanha que já existia", () => {
    const def = sql(
      `select column_default || '|' || is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'campaigns' and column_name = 'velocidade';`,
    );
    expect(def).toBe("'gradual'::text|NO");
  });

  it("velocidade fora do vocabulário é recusada pelo CHECK", () => {
    seedGov();
    expect(() =>
      // Com modelo, para só o CHECK do vocabulário poder recusar (com texto
      // livre, o de "rápida só com modelo" recusaria antes).
      sql(`insert into public.campaigns
             (organization_id, name, channel_session_id, base_legal, message_mode,
              provider_template_name, provider_template_language, velocidade)
             values ('${GOV_ORG}', 'velocidade inventada', '${GOV_SESSION}', 'consent', 'template',
                     'oferta', 'pt_BR', 'turbo');`),
    ).toThrow(/campaigns_velocidade_check/);
  });

  it("rápida com texto livre (número por QR) é recusada — rajada por QR é banimento", () => {
    seedGov();
    expect(() =>
      sql(`insert into public.campaigns (organization_id, name, channel_session_id, base_legal, message_mode, velocidade)
             values ('${GOV_ORG}', 'rajada por QR', '${GOV_SESSION}', 'consent', 'text', 'rapida');`),
    ).toThrow(/campaigns_rapida_so_com_modelo/);
  });

  it("rápida com modelo aprovado passa", () => {
    seedGov();
    sql(`insert into public.campaigns
           (organization_id, name, channel_session_id, base_legal, message_mode,
            provider_template_name, provider_template_language, velocidade)
           values ('${GOV_ORG}', 'rajada oficial', '${GOV_SESSION}', 'consent', 'template',
                   'oferta', 'pt_BR', 'rapida');`);
    expect(sql(`select velocidade from public.campaigns where name = 'rajada oficial';`)).toBe("rapida");
  });
});

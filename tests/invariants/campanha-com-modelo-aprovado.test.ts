/**
 * MIGRATION 0710 — campanha com modelo aprovado.
 *
 * O que só o banco prova: `message_mode` é vocabulário FECHADO (`text` |
 * `template`) e o modelo exige nome E idioma — a plataforma identifica a
 * definição pelos dois.
 *
 * Entrega e leitura do modelo pelo oficial direto (os carimbos `delivered_at` /
 * `read_at` com `status = 'sent'`) são do #2937 e já têm prova própria em
 * `tests/invariants/ack-da-api-oficial-alcanca-o-destinatario.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

describe("0710: campanha com modelo aprovado", () => {
  it("message_mode nasce `text` para toda campanha que já existia", () => {
    const def = sql(
      `select column_default || '|' || is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'campaigns' and column_name = 'message_mode';`,
    );
    expect(def).toBe("'text'::text|NO");
  });

  it("modo fora do vocabulário é recusado pelo CHECK", () => {
    seedGov();
    expect(() =>
      sql(`insert into public.campaigns (organization_id, name, channel_session_id, base_legal, message_mode)
             values ('${GOV_ORG}', 'modo inventado', '${GOV_SESSION}', 'consent', 'broadcast');`),
    ).toThrow(/campaigns_message_mode_check/);
  });

  it("modelo sem idioma é recusado — nome e idioma identificam a definição", () => {
    seedGov();
    expect(() =>
      sql(`insert into public.campaigns
             (organization_id, name, channel_session_id, base_legal, message_mode, provider_template_name)
             values ('${GOV_ORG}', 'sem idioma', '${GOV_SESSION}', 'consent', 'template', 'oferta');`),
    ).toThrow(/campaigns_modelo_exige_nome_e_idioma/);
  });
});

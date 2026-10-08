import { beforeAll, describe, expect, it } from "vitest";

import { criarPlano, uuid, valor } from "./cobranca-helpers";

/**
 * O PLANO QUE A EMPRESA PODE ESCOLHER SOZINHA — migration 0601, seção F.
 * O padrão é `true`: um plano que já existia continua aparecendo para as
 * empresas depois do `update.sh` (nada muda para quem não mexer).
 */
const P = "c0b3a004-0000-4000-8000";
const PLANO = uuid(P, 1);

beforeAll(() => {
  criarPlano({ id: PLANO, nome: "Oferecido" });
});

describe("cobranca_planos.oferecido_ao_cliente", () => {
  it("⭐ nasce true (plano antigo segue aparecendo para as empresas)", () => {
    expect(valor(`select oferecido_ao_cliente::text from public.cobranca_planos where id = '${PLANO}';`)).toBe("true");
  });

  it("é not null", () => {
    expect(
      valor(`select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'cobranca_planos' and column_name = 'oferecido_ao_cliente';`),
    ).toBe("NO");
  });
});

import { describe, expect, it } from "vitest";

import {
  modoDoDestinoDoAviso,
  resolverDestinoDoAviso,
} from "@/lib/escalacao/destino-do-aviso";

/**
 * A CONFIGURAÇÃO ANTIGA CONTINUA VALENDO (#3803).
 *
 * A coluna nova nasce com `default 'fixo'`: quem já tinha um número configurado
 * não é migrado para o modo novo por conta própria, não perde o número e não
 * precisa reabrir a tela para continuar recebendo aviso. Este arquivo é a prova
 * disso do lado do TypeScript — o `default` do banco está na migration e no
 * baseline, e a linha antiga é o que estas asserções descrevem.
 */

/** A linha como ela está no banco antes desta entrega: sem `destino_modo`. */
const LINHA_ANTIGA = {
  organization_id: "00000000-0000-4000-8000-000000000001",
  channel_session_id: "00000000-0000-4000-8000-000000000002",
  telefone_destino: "+5531988887777",
  rotulo: "Plantão",
  destino_jid: null,
  ligado: true,
  resposta_whatsapp_habilitada: true,
};

const RESPONSAVEL = "44444444-4444-4444-8444-444444444444";

describe("modoDoDestinoDoAviso — o valor ausente é `fixo`, nunca um modo novo", () => {
  it("linha sem a coluna: fixo", () => {
    expect(modoDoDestinoDoAviso(LINHA_ANTIGA)).toBe("fixo");
  });

  it("`fixo` gravado: fixo", () => {
    expect(modoDoDestinoDoAviso({ destino_modo: "fixo" })).toBe("fixo");
  });

  it("`responsavel` gravado: responsavel", () => {
    expect(modoDoDestinoDoAviso({ destino_modo: "responsavel" })).toBe("responsavel");
  });

  it("lixo (versão futura, campo torto): volta para fixo em vez de estourar", () => {
    for (const lixo of ["RESPONSAVEL", "responsável", "", 0, null, undefined, {}]) {
      expect(modoDoDestinoDoAviso({ destino_modo: lixo })).toBe("fixo");
    }
  });

  it("configuração ausente (organização sem aviso): fixo, sem lançar", () => {
    expect(modoDoDestinoDoAviso(null)).toBe("fixo");
    expect(modoDoDestinoDoAviso(undefined)).toBe("fixo");
  });
});

describe("config antiga com número fixo continua aceita", () => {
  it("resolve para o MESMO número, sem reformatar", () => {
    const r = resolverDestinoDoAviso({
      config: LINHA_ANTIGA,
      conversa: { assigned_to_user_id: RESPONSAVEL, assignee_kind: "human" },
      negocio: { owner_user_id: RESPONSAVEL, owner_kind: "human" },
      contato: { carteira_user_id: RESPONSAVEL },
      whatsapps: new Map([[RESPONSAVEL, "+5531988889999"]]),
    });
    expect(r).toEqual({
      telefone: "+5531988887777",
      origem: "numero_da_empresa",
      user_id: null,
      descartes: [],
    });
  });

  it("não procura responsável quando o modo é fixo — nem com a cadeia inteira preenchida", () => {
    const r = resolverDestinoDoAviso({
      config: { ...LINHA_ANTIGA, destino_modo: "fixo" },
      conversa: { assigned_to_user_id: RESPONSAVEL, assignee_kind: "human" },
      negocio: { owner_user_id: RESPONSAVEL, owner_kind: "human" },
      contato: { carteira_user_id: RESPONSAVEL },
      whatsapps: new Map([[RESPONSAVEL, "+5531988889999"]]),
    });
    expect(r.telefone).toBe(LINHA_ANTIGA.telefone_destino);
    expect(r.user_id).toBeNull();
    expect(r.descartes).toEqual([]);
  });

  it("as colunas que a linha antiga já tinha (`rotulo`, `destino_jid`, `ligado`) não mudam a decisão", () => {
    const r = resolverDestinoDoAviso({
      config: { ...LINHA_ANTIGA, destino_jid: "5531988887777@s.whatsapp.net", ligado: false },
      conversa: null,
      negocio: null,
      contato: null,
      whatsapps: new Map(),
    });
    expect(r.telefone).toBe("+5531988887777");
    expect(r.origem).toBe("numero_da_empresa");
  });

  it("o modo novo, na MESMA linha, usa o número da empresa só como último elo", () => {
    const r = resolverDestinoDoAviso({
      config: { ...LINHA_ANTIGA, destino_modo: "responsavel" },
      conversa: { assigned_to_user_id: RESPONSAVEL, assignee_kind: "human" },
      negocio: null,
      contato: null,
      whatsapps: new Map([[RESPONSAVEL, "+5531988889999"]]),
    });
    expect(r.telefone).toBe("+5531988889999");
    expect(r.origem).toBe("responsavel_da_conversa");
  });
});

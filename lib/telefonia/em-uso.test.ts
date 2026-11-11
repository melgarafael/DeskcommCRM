/**
 * `telefoniaEmUso` — o sinal que o item de menu da #1290 usa.
 *
 * O que este arquivo vigia, e por quê:
 *
 *  - basta UMA das fontes reais de telefonia (tronco salvo, tronco da
 *    instalação, número ativo, ligação SIP registrada) — olhar só o tronco
 *    salvo escondia Chamadas de quem atende ligação de verdade;
 *  - ligação de WhatsApp (`provider = 'wacalls'`) NÃO conta: ela mora na mesma
 *    tabela, mas a tela de Chamadas lista só SIP, e contá-la daria a porta de
 *    uma tela vazia (o defeito original);
 *  - a leitura é da ORGANIZAÇÃO, por `organization_id` — linha de outra empresa
 *    não acende o menu desta;
 *  - falha fechada por fonte e nunca lança: roda no layout de `/app`.
 *
 * O banco falso aplica os filtros `eq` de verdade sobre as linhas, para que o
 * teste meça o filtro e não a chamada.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { telefoniaEmUso } from "./em-uso";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[] | Error | { erro: string }>) {
  const from = vi.fn((tabela: string) => {
    const filtros: Array<[string, unknown]> = [];
    const consulta = {
      select: () => consulta,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return consulta;
      },
      limit: () => consulta,
      then: (resolver: (r: { data: Linha[] | null; error: unknown }) => unknown, rejeitar: (e: unknown) => unknown) => {
        const conteudo = tabelas[tabela] ?? [];
        if (conteudo instanceof Error) return Promise.reject(conteudo).then(resolver, rejeitar);
        if (!Array.isArray(conteudo)) return Promise.resolve({ data: null, error: { message: conteudo.erro } }).then(resolver, rejeitar);
        const data = conteudo.filter((l) => filtros.every(([c, v]) => l[c] === v)).slice(0, 1);
        return Promise.resolve({ data, error: null }).then(resolver, rejeitar);
      },
    };
    return consulta;
  });
  return { db: { from } as never, from };
}

const ORG = "org-1";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("telefoniaEmUso", () => {
  it("tronco salvo para a organização = ligada", async () => {
    const { db } = bancoFalso({ voip_trunk_settings: [{ organization_id: ORG }] });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(true);
  });

  it("sem tronco salvo, mas com número ativo (a entrada acha a org pelo número) = ligada", async () => {
    const { db } = bancoFalso({ phone_numbers: [{ id: "n1", organization_id: ORG, is_active: true }] });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(true);
  });

  it("número INATIVO não conta", async () => {
    const { db } = bancoFalso({ phone_numbers: [{ id: "n1", organization_id: ORG, is_active: false }] });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(false);
  });

  it("só histórico de ligação SIP = ligada (é o que a tela de Chamadas lista)", async () => {
    const { db } = bancoFalso({ voice_calls: [{ id: "c1", organization_id: ORG, provider: "sip" }] });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(true);
  });

  it("só histórico de ligação de WhatsApp (wacalls) = desligada: a tela de Chamadas abriria vazia", async () => {
    const { db } = bancoFalso({ voice_calls: [{ id: "c1", organization_id: ORG, provider: "wacalls" }] });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(false);
  });

  it("tronco da instalação (VOIP_TRUNK_ENDPOINT) = ligada, sem ler o banco", async () => {
    vi.stubEnv("VOIP_TRUNK_ENDPOINT", "trunk-da-instalacao");
    const { db, from } = bancoFalso({});
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(true);
    expect(from).not.toHaveBeenCalled();
  });

  it("nada em lugar nenhum = desligada", async () => {
    const { db } = bancoFalso({});
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(false);
  });

  it("linhas de OUTRA organização não acendem o menu desta", async () => {
    const { db } = bancoFalso({
      voip_trunk_settings: [{ organization_id: "org-2" }],
      phone_numbers: [{ id: "n1", organization_id: "org-2", is_active: true }],
      voice_calls: [{ id: "c1", organization_id: "org-2", provider: "sip" }],
    });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(false);
  });

  it("erro numa fonte não apaga a outra: número ativo segue valendo", async () => {
    const { db } = bancoFalso({
      voip_trunk_settings: { erro: "boom" },
      voice_calls: new Error("rede"),
      phone_numbers: [{ id: "n1", organization_id: ORG, is_active: true }],
    });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(true);
  });

  it("erro em todas as fontes: desligada, sem lançar", async () => {
    const { db } = bancoFalso({
      voip_trunk_settings: { erro: "boom" },
      phone_numbers: new Error("rede"),
      voice_calls: { erro: "boom" },
    });
    await expect(telefoniaEmUso(db, ORG)).resolves.toBe(false);
  });
});

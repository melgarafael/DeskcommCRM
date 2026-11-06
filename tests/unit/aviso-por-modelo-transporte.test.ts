/**
 * O TRANSPORTE DO AVISO À EQUIPE escolhe entre texto livre e modelo aprovado
 * (migration 9094) — e a escolha é de quem chama, nunca um palpite dele.
 *
 * Sem `opcoes.modelo`, nada mudou: o aviso sai como texto livre pelo adapter.
 * Com ele, o MESMO texto vai dentro da variável única do modelo, numa linha só,
 * pelo envio de modelo de `lib/channels/` — e continua sem gravar conversa.
 *
 * A escolha não é automática de propósito: a confirmação do comando RESPONDER
 * usa este mesmo transporte numa conexão cuja janela de 24 h acabou de abrir
 * (a equipe escreveu), e lá texto livre é o certo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  send: vi.fn(async () => ({ externalId: "texto-1" })),
  isConfigured: vi.fn(() => true),
  resolveRecipient: vi.fn(() => "5531900000000"),
}));
vi.mock("@/lib/channels", () => ({
  getAdapter: vi.fn(() => adapter),
  resolveSessionRef: vi.fn(() => "conta-1"),
  CHANNEL_SESSION_REF_COLUMNS: "provider",
}));
const enviarModeloDireto = vi.hoisted(() => vi.fn(async () => ({ externalId: "modelo-1" })));
vi.mock("@/lib/channels/modelo-direto", () => ({ enviarModeloDireto }));

import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import type { CanalDoAviso } from "@/lib/escalacao/aviso-ao-suporte";
import type { ModeloDoAviso } from "@/lib/escalacao/modelo-do-aviso";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL: CanalDoAviso = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "WORKING",
  archived_at: null,
  aceitaMensagemLivre: false,
};
const MODELO: ModeloDoAviso = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "aviso_da_equipe",
  language: "pt_BR",
  chave: "1",
  corpo: "🔔 Aviso\n\n{{1}}\n\nAbra o CRM.",
};
const AVISO = "Resumo do lead para a equipe\n\nCliente: Maria\nAbrir negócio: https://crm.exemplo.com.br/app/leads/1";

function admin() {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: { provider: "provedor-do-teste" }, error: null }),
  };
  return { from: () => q } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("criarTransporteDoAviso — texto livre ou modelo", () => {
  it("sem modelo, o aviso sai como TEXTO pelo adapter — o caminho de sempre", async () => {
    const t = await criarTransporteDoAviso(admin());
    const r = await t.envia(ORG, CANAL, "5531900000000", AVISO);
    expect(r.externalId).toBe("texto-1");
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, sessionRef: "conta-1", kind: "text", body: AVISO }),
    );
    expect(enviarModeloDireto).not.toHaveBeenCalled();
  });

  it("com modelo, o MESMO texto vai na variável do modelo, numa linha só", async () => {
    const t = await criarTransporteDoAviso(admin());
    const r = await t.envia(ORG, CANAL, "5531900000000", AVISO, { modelo: MODELO });
    expect(r.externalId).toBe("modelo-1");
    expect(adapter.send).not.toHaveBeenCalled();
    expect(enviarModeloDireto).toHaveBeenCalledTimes(1);
    const [, envio] = enviarModeloDireto.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(envio).toMatchObject({
      organizationId: ORG,
      channelSessionId: CANAL.id,
      provider: "provedor-do-teste",
      sessionRef: "conta-1",
      to: "5531900000000",
      name: "aviso_da_equipe",
      language: "pt_BR",
      values: {
        "1": "Resumo do lead para a equipe · Cliente: Maria · Abrir negócio: https://crm.exemplo.com.br/app/leads/1",
      },
    });
    expect(String((envio.values as Record<string, string>)["1"])).not.toMatch(/\n/);
  });

  it("a chave do valor é a do modelo — no formato nomeado, o nome da variável", async () => {
    const t = await criarTransporteDoAviso(admin());
    await t.envia(ORG, CANAL, "5531900000000", "Lead novo", { modelo: { ...MODELO, chave: "texto" } });
    const [, envio] = enviarModeloDireto.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(envio.values).toEqual({ texto: "Lead novo" });
  });

  it("`modelo: null` é o mesmo que não ter modelo", async () => {
    const t = await criarTransporteDoAviso(admin());
    await t.envia(ORG, CANAL, "5531900000000", AVISO, { modelo: null });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(enviarModeloDireto).not.toHaveBeenCalled();
  });
});

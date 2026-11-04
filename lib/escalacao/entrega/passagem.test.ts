import { describe, it, expect, vi } from "vitest";
import {
  configEntregaSchema,
  entregarPassagem,
  textoCurtoDaPassagem,
  type DepsEntrega,
  type PassagemParaEntrega,
  type ClaimAviso,
} from "./passagem";
const O = "aaaaaaaa-0000-4000-8000-000000000001",
  A = "bbbbbbbb-0000-4000-8000-000000000001",
  B = "bbbbbbbb-0000-4000-8000-000000000002";
const passage: PassagemParaEntrega = {
  organizationId: O,
  episodeId: "episode1",
  conversationId: "cccccccc-0000-4000-8000-000000000001",
  leadId: "lead1",
  serviceRevision: 1,
  resumo: {
    nome: "Teste",
    interesse: "Veículo consultado",
    troca: "Veículo usado",
    pagamento: "Equipe confirma condições",
  },
};
const config = configEntregaSchema.parse({
  enabled: true,
  seller_user_ids: [A, B],
  seller_destinations: { [A]: "+5511000000001", [B]: "+5511000000002" },
  supervisor_destinations: ["+5511000000003"],
});
function fixture() {
  const delivered = new Map<string, ClaimAviso>();
  const claims = new Map<string, string>();
  let index = 0;
  const deps: DepsEntrega = {
    db: {
      identidadeDoResponsavel: vi.fn(async () => ({
        nome: "Vendedor sintético",
        empresa: "Empresa sintética",
      })),
      responsavelVigente: vi.fn(async () => true),
      passagemVigente: vi.fn(async () => true),
      atribuirMesmoResponsavel: vi.fn(async () => ({ status: "assigned" as const, userId: A })),
      moverParaHumano: vi.fn(async () => true),
      canalDaConversa: vi.fn(async () => ({
        id: "channel",
        status: "WORKING",
        archived_at: null,
        aceitaMensagemLivre: true,
      })),
      destinoDaOrganizacao: vi.fn(async () => false),
      reivindicarAviso: vi.fn(async (p, hash) => {
        const key = p.organizationId + ":" + p.episodeId + ":" + hash;
        const previous = delivered.get(key);
        if (previous) return previous;
        const claimId = "claim" + index++;
        claims.set(claimId, key);
        const c: ClaimAviso = { status: "claimed", claimId };
        delivered.set(key, { status: "busy" });
        return c;
      }),
      marcaTentativa: vi.fn(async () => {}),
      concluirAviso: vi.fn(async (_p, id, status) => {
        delivered.set(claims.get(id)!, { status });
      }),
    },
    pacing: {
      decide: vi.fn(async () => ({ liberado: true as const })),
      registraEnvio: vi.fn(async () => {}),
    },
    transporte: {
      configurado: vi.fn(async () => true),
      resolveDestino: vi.fn(async (_o, _c, p) => p + "@jid"),
      envia: vi.fn(async () => ({ externalId: "ack" })),
    },
    comLockDoCanal: async (_o, _c, f) => f(),
    clock: () => new Date("2026-10-07T18:00:00Z"),
    urlPublica: "https://crm.example.com",
  };
  return deps;
}
describe("Passagem: contrato sem efeitos externos", () => {
  it("opt-in desligado não toca banco nem transporte", async () => {
    const d = fixture();
    expect((await entregarPassagem(d, passage, { ...config, enabled: false })).status).toBe(
      "disabled",
    );
    expect(d.db.passagemVigente).not.toHaveBeenCalled();
  });
  it("mesmo owner é usado no card/etapa e avisa vendedor+supervisor", async () => {
    const d = fixture();
    expect(await entregarPassagem(d, passage, config)).toMatchObject({
      status: "delivered",
      ownerId: A,
      delivered: 2,
    });
    expect(d.db.moverParaHumano).toHaveBeenCalledWith(passage, A);
    expect(d.transporte.envia).toHaveBeenCalledTimes(2);
  });
  it("identidade revogada impede aviso e usa a mesma empresa/owner confirmados", async () => {
    const d = fixture();
    vi.mocked(d.db.identidadeDoResponsavel).mockResolvedValue(null);
    expect((await entregarPassagem(d, passage, config)).status).toBe("stale");
    expect(d.db.identidadeDoResponsavel).toHaveBeenCalledWith(passage, A);
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("reprocessamento não reenvia destinos confirmados", async () => {
    const d = fixture();
    await entregarPassagem(d, passage, config);
    await entregarPassagem(d, passage, config);
    expect(d.transporte.envia).toHaveBeenCalledTimes(2);
  });
  it("timeout de provedor vira ambíguo e impede reenvio no retry", async () => {
    const d = fixture();
    vi.mocked(d.transporte.envia).mockRejectedValue(new Error("timeout"));
    expect((await entregarPassagem(d, passage, config)).status).toBe("ambiguous");
    await entregarPassagem(d, passage, config);
    expect(d.transporte.envia).toHaveBeenCalledTimes(2);
  });
  it("fronteira obsoleta não atribui nem avisa", async () => {
    const d = fixture();
    vi.mocked(d.db.passagemVigente).mockResolvedValue(false);
    expect((await entregarPassagem(d, passage, config)).status).toBe("stale");
    expect(d.db.atribuirMesmoResponsavel).not.toHaveBeenCalled();
  });
  it("conflito de owner é preservado, não manda para outro", async () => {
    const d = fixture();
    vi.mocked(d.db.atribuirMesmoResponsavel).mockResolvedValue({ status: "conflict" });
    expect((await entregarPassagem(d, passage, config)).status).toBe("conflict");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("sem elegível fica em retry, sem mensagem ou liberação IA", async () => {
    const d = fixture();
    vi.mocked(d.db.atribuirMesmoResponsavel).mockResolvedValue({ status: "no_eligible" });
    expect((await entregarPassagem(d, passage, config)).status).toBe("retry");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("etapa bloqueada por campos não envia confirmação falsa", async () => {
    const d = fixture();
    vi.mocked(d.db.moverParaHumano).mockResolvedValue(false);
    expect((await entregarPassagem(d, passage, config)).status).toBe("blocked");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("teto do canal preservado e sem sleeps no dreno", async () => {
    const d = fixture();
    vi.mocked(d.pacing.decide).mockResolvedValue({
      liberado: false,
      motivo: "teto_diario",
      liberaEm: new Date("2026-10-08T10:00:00Z"),
    });
    const r = await entregarPassagem(d, passage, config);
    expect(r.retryAt).toBe("2026-10-08T10:00:00.000Z");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("número da própria organização não recebe aviso", async () => {
    const d = fixture();
    vi.mocked(d.db.destinoDaOrganizacao).mockResolvedValue(true);
    await entregarPassagem(d, passage, config);
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("deduplica vendedor que também é supervisor", async () => {
    const d = fixture();
    await entregarPassagem(d, passage, {
      ...config,
      supervisor_destinations: [config.seller_destinations[A]!],
    });
    expect(d.transporte.envia).toHaveBeenCalledTimes(1);
  });
  it("sem ACK não declara entrega nem repete", async () => {
    const d = fixture();
    vi.mocked(d.transporte.envia).mockResolvedValue({ externalId: null });
    expect((await entregarPassagem(d, passage, config)).status).toBe("ambiguous");
    await entregarPassagem(d, passage, config);
    expect(d.transporte.envia).toHaveBeenCalledTimes(2);
  });
  it("tentativas ambíguas contam no teto sem contar replay novamente", async () => {
    const d = fixture();
    vi.mocked(d.transporte.envia).mockRejectedValue(new Error("timeout"));
    await entregarPassagem(d, passage, config);
    await entregarPassagem(d, passage, config);
    expect(d.pacing.registraEnvio).toHaveBeenCalledTimes(2);
  });
  it("falha ao reservar teto bloqueia rede", async () => {
    const d = fixture();
    vi.mocked(d.pacing.registraEnvio).mockRejectedValue(new Error("database"));
    await expect(entregarPassagem(d, passage, config)).rejects.toThrow("database");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("pausa retirada durante atribuição impede aviso", async () => {
    const d = fixture();
    vi.mocked(d.db.passagemVigente).mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await entregarPassagem(d, passage, config)).status).toBe("stale");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("transferência humana cancela aviso ao vendedor anterior", async () => {
    const d = fixture();
    vi.mocked(d.db.responsavelVigente).mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await entregarPassagem(d, passage, config)).status).toBe("stale");
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
  it("ausência de card é terminal acionável, não retry infinito", async () => {
    const d = fixture();
    vi.mocked(d.db.atribuirMesmoResponsavel).mockResolvedValue({ status: "missing_lead" });
    expect(await entregarPassagem(d, passage, config)).toMatchObject({
      status: "blocked",
      reason: "missing_lead",
    });
  });
  it("resumo é curto, com link de conversa, e omite CPF", () => {
    const s = textoCurtoDaPassagem(
      { ...passage, resumo: { nome: "Teste", pagamento: "CPF 123.456.789-00" } },
      "https://crm.example.com",
    );
    expect(s).not.toContain("123.456");
    expect(s).toContain("/app/inbox?id=");
    expect(s.length).toBeLessThan(1100);
  });
});

describe("Atribuição sem aviso externo", () => {
  it("aceita vendedor sem telefone somente com avisos explicitamente desligados", () => {
    expect(
      configEntregaSchema.safeParse({
        enabled: true,
        seller_user_ids: [A],
        notifications_enabled: false,
      }).success,
    ).toBe(true);
    expect(configEntregaSchema.safeParse({ enabled: true, seller_user_ids: [A] }).success).toBe(
      false,
    );
  });
  it("atribui e move sem resolver destino, canal, pacing, claim ou transporte", async () => {
    const d = fixture();
    const cfg = configEntregaSchema.parse({
      enabled: true,
      seller_user_ids: [A],
      notifications_enabled: false,
    });
    const r = await entregarPassagem(d, passage, cfg);
    expect(r).toMatchObject({
      status: "delivered",
      reason: "notifications_disabled",
      ownerId: A,
      delivered: 0,
      pending: 0,
    });
    expect(d.db.atribuirMesmoResponsavel).toHaveBeenCalledWith(passage, [A]);
    expect(d.db.moverParaHumano).toHaveBeenCalledWith(passage, A);
    expect(d.db.canalDaConversa).not.toHaveBeenCalled();
    expect(d.db.reivindicarAviso).not.toHaveBeenCalled();
    expect(d.pacing.decide).not.toHaveBeenCalled();
    expect(d.transporte.configurado).not.toHaveBeenCalled();
    expect(d.transporte.resolveDestino).not.toHaveBeenCalled();
    expect(d.transporte.envia).not.toHaveBeenCalled();
  });
});

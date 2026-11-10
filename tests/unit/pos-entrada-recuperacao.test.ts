import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Os efeitos da mensagem RECUPERADA de uma queda (Spec 32 §3): só os de "o cliente
 * respondeu". Nunca despacho do agente, demanda nova, drenagem de eventos nem
 * `message.received` no event_log. A mensagem é do passado: acordar a IA por ela
 * responderia a alguém que já foi atendido.
 */

const sp = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  garantirLead: vi.fn(async () => ({ criado: true, leadId: "lead-1" }) as never),
  encerraDemanda: vi.fn(async () => ({}) as never),
  reatividade: vi.fn(async () => ({ matched: false, reacted: 0 }) as never),
  textoNosFollowups: vi.fn(async () => {}),
  respostaCampanha: vi.fn(async () => ({ atribuiu: false, optOut: 0 }) as never),
  marcarConversa: vi.fn(async () => {}),
  pessoal: vi.fn(async () => ({ pessoal: false, erro: null }) as never),
  desativados: vi.fn(async () => [] as string[]),
  numeroInterno: vi.fn(async () => false),
  warn: vi.fn(),
  /** O que a conversa já tem em `last_message_at` (null = sem carimbo ou sem linha). */
  ultimaDaConversa: null as string | null,
  /** O registro do que o admin tocou: tabelas lidas/escritas e RPCs chamadas. */
  tabelas: [] as string[],
  rpcs: [] as string[],
}));

vi.mock("@/lib/audit", () => ({ audit: sp.audit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: sp.warn, error: vi.fn() } }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: vi.fn(async () => {}),
  drenarEventosDoInbound: vi.fn(async () => {}),
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({ garantirLeadDaConversa: sp.garantirLead }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: sp.encerraDemanda }));
vi.mock("@/lib/followup/reactivity", () => ({
  applyReactivityEvent: sp.reatividade,
  createSupabaseReactivityClient: () => ({}),
}));
vi.mock("@/lib/followup/aplicar-inbound", () => ({
  aplicarTextoNosFollowups: sp.textoNosFollowups,
  textoDoPayloadInbound: (p: Record<string, unknown> | null | undefined) =>
    typeof p?.body_preview === "string" ? p.body_preview : "",
}));
vi.mock("@/lib/campanhas/resposta", () => ({ aplicarRespostaNaCampanha: sp.respostaCampanha }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: sp.marcarConversa }));
vi.mock("@/lib/channels/desativado", () => ({ idsDosCanaisDesativados: sp.desativados }));
vi.mock("@/lib/contacts/contato-pessoal", () => ({ lerPessoalDoContato: sp.pessoal }));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({ ehContatoDoNumeroInterno: sp.numeroInterno }));

import { aplicarEfeitosDaRecuperacao, type EntradaDaRecuperacao } from "@/lib/channels/pos-entrada";

const ORG = "org-1";
const SESSAO = "sess-1";
const ENVIADA = "2026-10-25T10:00:00.000Z";

/** Qualquer `.from()`/`.rpc()` cai aqui: encadeável, sem dado (ou com o dado dado), e registrado. */
function cadeia(dado: unknown = null): unknown {
  const p: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dado, error: null }).then(ok);
      return () => p;
    },
    apply() {
      return p;
    },
  });
  return p;
}

const admin = {
  from(tabela: string) {
    sp.tabelas.push(tabela);
    if (tabela === "conversations" && sp.ultimaDaConversa) return cadeia({ last_message_at: sp.ultimaDaConversa });
    return cadeia();
  },
  rpc(fn: string) {
    sp.rpcs.push(fn);
    return cadeia();
  },
};

function entrada(extra: Partial<EntradaDaRecuperacao> = {}): EntradaDaRecuperacao {
  return {
    organizationId: ORG,
    contactId: "ct-1",
    conversationId: "cv-1",
    messageId: null,
    channelSessionId: SESSAO,
    texto: "oi",
    nomeDoContato: null,
    requestId: "recuperacao:imp-1:false_X_A1",
    origem: "historico_queda",
    enviadaEm: ENVIADA,
    previa: "oi",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sp.ultimaDaConversa = null;
  sp.tabelas.length = 0;
  sp.rpcs.length = 0;
  sp.desativados.mockResolvedValue([]);
  sp.pessoal.mockResolvedValue({ pessoal: false, erro: null } as never);
  sp.numeroInterno.mockResolvedValue(false);
});

describe("aplicarEfeitosDaRecuperacao (Spec 32 §3)", () => {
  it("caso normal: roda reatividade, texto do follow-up, resposta de campanha e carimbo da conversa, com a hora REAL", async () => {
    await aplicarEfeitosDaRecuperacao(admin as never, entrada());

    expect(sp.reatividade).toHaveBeenCalledTimes(1);
    expect(sp.reatividade).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        event_type: "message.received",
        organization_id: ORG,
        created_at: ENVIADA,
        payload: expect.objectContaining({ contact_id: "ct-1", sent_at: ENVIADA, direction: "inbound" }),
      }),
      // A mensagem é de antes da volta: pode parar o fluxo que cancela na resposta, não acordar a espera.
      { semAcordar: true },
    );
    // Aplicar o texto como resposta manda o próximo passo AGORA, a quem pode já ter sido atendido.
    expect(sp.textoNosFollowups).not.toHaveBeenCalled();
    expect(sp.respostaCampanha).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, contactId: "ct-1", recebidoEm: new Date(ENVIADA) }),
    );
    expect(sp.marcarConversa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "cv-1", direction: "inbound", preview: "oi", at: ENVIADA }),
    );
  });

  it("conversa que já tem uma mensagem MAIS NOVA (chegou ao vivo depois da volta): o carimbo não volta no tempo", async () => {
    sp.ultimaDaConversa = "2026-10-26T09:00:00.000Z";
    await aplicarEfeitosDaRecuperacao(admin as never, entrada());

    expect(sp.marcarConversa).not.toHaveBeenCalled();
    // Sabotagem: tirar a leitura de `last_message_at` faz a conversa voltar para a hora da mensagem velha.
  });

  it("conversa cuja última mensagem é MAIS VELHA que a recuperada: o carimbo anda para a frente", async () => {
    sp.ultimaDaConversa = "2026-10-24T09:00:00.000Z";
    await aplicarEfeitosDaRecuperacao(admin as never, entrada());

    expect(sp.marcarConversa).toHaveBeenCalledTimes(1);
  });

  it("nunca despacha o agente, nunca abre demanda, nunca grava no event_log", async () => {
    await aplicarEfeitosDaRecuperacao(admin as never, entrada());

    expect(sp.rpcs).not.toContain("emit_event");
    expect(sp.rpcs.some((f) => f.includes("dispatch"))).toBe(false);
    expect(sp.tabelas).not.toContain("event_log");
    expect(sp.garantirLead).not.toHaveBeenCalled();
    expect(sp.encerraDemanda).not.toHaveBeenCalled();
    // Sabotagem: chamar `aplicarEfeitosPosEntrada` inteiro (o despacho do agente) faz o `emit_event` aparecer e este caso ficar vermelho.
  });

  it("canal pausado: nenhum efeito", async () => {
    sp.desativados.mockResolvedValue([SESSAO]);
    await aplicarEfeitosDaRecuperacao(admin as never, entrada({ texto: "PARE" }));

    expect(sp.reatividade).not.toHaveBeenCalled();
    expect(sp.textoNosFollowups).not.toHaveBeenCalled();
    expect(sp.respostaCampanha).not.toHaveBeenCalled();
    expect(sp.marcarConversa).not.toHaveBeenCalled();
    expect(sp.audit).not.toHaveBeenCalled();
    // Sabotagem: não checar o canal pausado faz a reatividade rodar mesmo com o canal desligado.
  });

  it("contato pessoal: nenhum efeito de follow-up, campanha ou conversa", async () => {
    sp.pessoal.mockResolvedValue({ pessoal: true, erro: null } as never);
    await aplicarEfeitosDaRecuperacao(admin as never, entrada());

    expect(sp.reatividade).not.toHaveBeenCalled();
    expect(sp.textoNosFollowups).not.toHaveBeenCalled();
    expect(sp.respostaCampanha).not.toHaveBeenCalled();
    expect(sp.marcarConversa).not.toHaveBeenCalled();
    // Sabotagem: ignorar `is_personal` faz a reatividade e a conversa rodarem para o contato pessoal.
  });

  it("um efeito que falha não impede os seguintes, e não lança", async () => {
    sp.reatividade.mockRejectedValueOnce(new Error("reatividade caiu") as never);
    await expect(aplicarEfeitosDaRecuperacao(admin as never, entrada())).resolves.toBeUndefined();

    // O passo de follow-up falhou; a resposta de campanha e a conversa seguem.
    expect(sp.respostaCampanha).toHaveBeenCalledTimes(1);
    expect(sp.marcarConversa).toHaveBeenCalledTimes(1);
    expect(sp.warn).toHaveBeenCalledWith(expect.stringContaining("follow-up"), expect.anything());
    // Sabotagem: deixar a falha subir (sem o try por efeito) faz este caso ver a exceção e a conversa não ser marcada.
  });

  it("número interno de avisos: nada acontece", async () => {
    sp.numeroInterno.mockResolvedValue(true);
    await aplicarEfeitosDaRecuperacao(admin as never, entrada());
    expect(sp.reatividade).not.toHaveBeenCalled();
    expect(sp.marcarConversa).not.toHaveBeenCalled();
  });
});

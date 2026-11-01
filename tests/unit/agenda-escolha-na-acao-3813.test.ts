/**
 * #3813 — A ESCOLHA NA AÇÃO, NÃO SÓ NA FUNÇÃO PURA.
 *
 * A decisão pura já tem o arquivo dela (`agenda-escolha-de-envio-3813.test.ts`).
 * Aqui se mede o que a issue cobra na prática: a regra com
 * `quando_ha_compromisso` não é mais adiada pelo motor (`postponeUntil`) e o
 * envio termina como PULO REGISTRADO (`skipped` + motivo) ou sai de verdade —
 * sem `AgendaDeferredError` no caminho de quem escolheu.
 *
 * ═══ O que é dublado, e por quê ═══
 *
 * `protecaoAgendaSupabase` — a LEITURA — é dublada com a proteção que o caso
 * precisa: o que está sob teste é o que o consumidor faz com o compromisso, não
 * a consulta (que tem os casos dela em `agenda-protecao-followup.test.ts` e no
 * primeiro arquivo desta dupla). A guarda (`assertAgendaEffectSupabase`) roda de
 * VERDADE, sobre a leitura dublada — é ela que precisa respeitar a escolha.
 * `checarGuardasDeContato` também roda de verdade: um contato bloqueado tem de
 * continuar bloqueado, escolha nenhuma fura o consentimento.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as OrigemDeAtendimento from "@/lib/atendimento/origem";
import type * as ProtecaoFollowup from "@/lib/agenda/protecao-followup";

const sendMessageHandler = vi.fn();
const espacarEnvio = vi.fn();
const serviceForAutomation = vi.fn();
const reportarEnvio = vi.fn();
const protecaoAgendaSupabase = vi.fn();

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a),
}));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: (...a: unknown[]) => espacarEnvio(...a),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: (...a: unknown[]) => serviceForAutomation(...a),
}));
vi.mock("@/lib/atendimento/origem", async (importOriginal) => ({
  ...(await importOriginal<typeof OrigemDeAtendimento>()),
  assertServiceBoundarySupabase: vi.fn(async () => {}),
}));
// A LEITURA dublada; a guarda (`assertAgendaEffectSupabase`) e o erro
// `AgendaDeferredError` continuam os de produção.
vi.mock("@/lib/agenda/protecao-followup", async (importOriginal) => ({
  ...(await importOriginal<typeof ProtecaoFollowup>()),
  protecaoAgendaSupabase: (...a: unknown[]) => protecaoAgendaSupabase(...a),
}));
vi.mock("@/lib/automation/desfecho-do-envio", () => ({
  reportarEnvio: (...a: unknown[]) => reportarEnvio(...a),
}));
// A janela do canal e o teto diário NÃO são o objeto deste arquivo: abertos,
// eles deixam o `postponeUntil` devolver `null` quando a agenda não adia — que
// é justamente o que se quer medir. As réguas deles têm os casos delas.
vi.mock("@/lib/automation/janela-do-canal", () => ({
  adiarAteAJanelaAbrir: vi.fn(async () => null),
  knobsDoCanal: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: vi.fn(async () => ({ ok: true, texto: "Oi, vi seu formulário." })),
}));
vi.mock("@/lib/automation/dados-do-formulario", () => ({
  dadosDoFormularioDoContexto: vi.fn(async () => ({ dados: {}, origem: null, origemDaAbordagem: "automacao" })),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: vi.fn(async () => ({ permite: true })),
}));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: vi.fn(async () => {}) }));
vi.mock("@/lib/escalacao/assunto-comercial", () => ({
  comercialExigeHumanoViaSupabase: vi.fn(async () => ({ exige: false })),
  restricaoComercialBarra: vi.fn(() => false),
}));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-whatsapp";
import "@/lib/automation/actions/send-ai-message";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

/**
 * O motivo é literal de propósito: este arquivo mede o COMPORTAMENTO da ação
 * (a mensagem sai, o pulo é registrado), não o vocabulário — que tem os casos
 * dele no arquivo da decisão pura. Com a constante escrita aqui, o teste
 * também roda na `main` e falha pelo motivo certo (a ação adia), em vez de
 * morrer no import de um módulo que ainda não existe lá.
 */
const MOTIVO_DO_PULO = "compromisso_na_agenda";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const AGENTE = "66666666-6666-4666-8666-666666666666";
const REAVALIAR = "2027-01-31T12:00:00.000Z";

const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** A proteção de um contato com horário marcado daqui a três meses. */
function proteger(adiar = true) {
  protecaoAgendaSupabase.mockResolvedValue(
    new Map([
      [
        CONTATO,
        adiar
          ? { adiar: true, motivo: "agendado", appointment_id: "appointment-1", reavaliar_em: REAVALIAR }
          : { adiar: false, motivo: "sem_compromisso", appointment_id: null, reavaliar_em: null },
      ],
    ]),
  );
}

function ctx(): ActionCtx {
  return {
    admin: { from: () => ({}) } as unknown as ActionCtx["admin"],
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Pós-atendimento",
    event: { id: "evento-1" } as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: CONTATO, phone_number: "+551****8888" } },
  };
}

function acao(tipo: "send_whatsapp_message" | "send_ai_message") {
  const registrada = getAction(tipo);
  if (!registrada) throw new Error(`${tipo} não está registrada`);
  return registrada;
}

const CONFIG_WHATSAPP = { channel_session_id: CANAL, template: "Oi, {{primeiro_nome}}!" };
const CONFIG_IA = { channel_session_id: CANAL, agent_id: AGENTE, instruction: "Fale do formulário." };

beforeEach(() => {
  vi.clearAllMocks();
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
  serviceForAutomation.mockResolvedValue(FRONTEIRA);
  reportarEnvio.mockImplementation(async (_ctx: unknown, type: string) => ({
    type,
    status: "success" as const,
    detail: { message_id: "mensagem-1" },
  }));
  proteger();
});

describe("#3813 — postponeUntil: quem escolheu não é adiado", () => {
  it("PADRÃO (sem a chave): devolve o instante da reavaliação — o comportamento de hoje", async () => {
    // Asserção que JÁ passa na main: é o anti-regressão do padrão.
    await expect(acao("send_whatsapp_message").postponeUntil!(ctx(), CONFIG_WHATSAPP)).resolves.toBe(REAVALIAR);
    await expect(acao("send_ai_message").postponeUntil!(ctx(), CONFIG_IA)).resolves.toBe(REAVALIAR);
  });

  it.each(["enviar", "nao_enviar"] as const)("escolha `%s`: NÃO adia o evento", async (escolha) => {
    await expect(
      acao("send_whatsapp_message").postponeUntil!(ctx(), { ...CONFIG_WHATSAPP, quando_ha_compromisso: escolha }),
    ).resolves.toBeNull();
    await expect(
      acao("send_ai_message").postponeUntil!(ctx(), { ...CONFIG_IA, quando_ha_compromisso: escolha }),
    ).resolves.toBeNull();
  });

  it("valor desconhecido na config cai no padrão (adiar) em vez de estourar", async () => {
    await expect(
      acao("send_whatsapp_message").postponeUntil!(ctx(), { ...CONFIG_WHATSAPP, quando_ha_compromisso: "mande_sempre" }),
    ).resolves.toBe(REAVALIAR);
  });
});

describe("#3813 — execute: enviar mesmo assim, ou pular com motivo", () => {
  it("`enviar`: a mensagem SAI com compromisso marcado", async () => {
    const r = await acao("send_whatsapp_message").execute(ctx(), {
      ...CONFIG_WHATSAPP,
      quando_ha_compromisso: "enviar",
    });
    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
  });

  it("`nao_enviar`: o envio é PULADO com o motivo, e o handler não é chamado", async () => {
    const r = await acao("send_whatsapp_message").execute(ctx(), {
      ...CONFIG_WHATSAPP,
      quando_ha_compromisso: "nao_enviar",
    });
    expect(r).toMatchObject({
      type: "send_whatsapp_message",
      status: "skipped",
      detail: { reason: MOTIVO_DO_PULO, appointment_id: "appointment-1" },
    });
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("`nao_enviar` na ação de IA: pulo com motivo, sem gerar texto pago", async () => {
    const r = await acao("send_ai_message").execute(ctx(), { ...CONFIG_IA, quando_ha_compromisso: "nao_enviar" });
    expect(r).toMatchObject({ type: "send_ai_message", status: "skipped", detail: { reason: MOTIVO_DO_PULO } });
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("PADRÃO: continua adiando/falhando como hoje (nada muda para quem não configurou)", async () => {
    const r: ActionResultDetail = await acao("send_whatsapp_message").execute(ctx(), CONFIG_WHATSAPP);
    expect(r.status).toBe("failed");
    expect(String(r.error)).toContain("agenda");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("sem compromisso a escolha não bloqueia: as três enviariam", async () => {
    proteger(false);
    for (const escolha of ["adiar", "enviar", "nao_enviar"] as const) {
      const r = await acao("send_whatsapp_message").execute(ctx(), {
        ...CONFIG_WHATSAPP,
        quando_ha_compromisso: escolha,
      });
      expect(r.status, escolha).toBe("success");
    }
  });
});

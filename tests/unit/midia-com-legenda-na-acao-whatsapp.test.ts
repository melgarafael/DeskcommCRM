/**
 * MÍDIA COM LEGENDA NA AÇÃO `send_whatsapp_message` (#2734).
 *
 * ═══ Por que este arquivo existe ═══
 *
 * Até esta entrega, a ação montava o envio com `{ type: "text", body }` na mão: a
 * mídia do Inbox e das campanhas (`sendMessageHandler`) nunca era alcançada daqui,
 * e um `media_url` no config era campo morto — validado pela tela e ignorado pelo
 * runtime. O que se prova aqui é o outro lado: COM mídia, o `body` sai como LEGENDA
 * da mídia pelo MESMO handler; e quando a mídia não pode sair — URL sem tipo
 * identificável, ou janela de 24 h fechada num canal de hetero-restrição — o
 * passo RECUSA com motivo em vez de mandar o texto solto no lugar dela.
 * #2972: os tipos que saem deixaram de ser só imagem e PDF (áudio, vídeo e
 * documento entraram), e o caso da planilha virou o CONTROLE disso.
 *
 * ═══ O que o dublê é, e o que ele não é ═══
 *
 * `sendMessageHandler` é dublado (é a fronteira do envio, e o que se mede é o que
 * CHEGA nele). `classificarMidiaComLegenda` e `canalAceitaTextoLivreAgora` — a régua
 * da janela, em `lib/channels/` — rodam de VERDADE sobre as linhas que o dublê do
 * banco devolve; dublar o veredito provaria só que a ação chama uma função.
 *
 * ═══ Anti-vacuidade ═══
 *
 * O caso sem mídia e o caso com a janela ABERTA ficam aqui de propósito: sem eles,
 * uma ação que recusasse todo envio — ou uma que nunca enviasse mídia — satisfaria
 * os casos de recusa inteiros.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

const sendMessageHandler = vi.fn();
const espacarEnvio = vi.fn();
const serviceForAutomation = vi.fn();
const assertAgendaEffectSupabase = vi.fn();
const reportarEnvio = vi.fn();

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => sendMessageHandler(...args),
}));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: (...args: unknown[]) => espacarEnvio(...args),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: (...args: unknown[]) => serviceForAutomation(...args),
}));
vi.mock("@/lib/agenda/efeito", () => ({
  assertAgendaEffectSupabase: (...args: unknown[]) => assertAgendaEffectSupabase(...args),
}));
vi.mock("@/lib/automation/desfecho-do-envio", () => ({
  reportarEnvio: (...args: unknown[]) => reportarEnvio(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-whatsapp";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/**
 * Dublê do cliente admin. Responde as DUAS leituras da régua da janela —
 * `conversations` (última entrada + sessão) e `channel_sessions` (provider) — com o
 * que cada caso precisa. Qualquer outra tabela seria ruído: a ação não lê mais nada
 * por conta própria (o envio é do handler).
 */
function bancoFalso(input: { provider: string | null; ultimoInbound: string | null }) {
  const from = (tabela: string) => {
    const encadeavel: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "is", "in", "order", "limit", "update"]) {
      encadeavel[metodo] = () => encadeavel;
    }
    encadeavel.maybeSingle = async () => {
      if (tabela === "conversations") {
        return {
          data: { last_inbound_at: input.ultimoInbound, channel_session_id: CANAL },
          error: null,
        };
      }
      if (tabela === "channel_sessions") return { data: { provider: input.provider }, error: null };
      return { data: null, error: null };
    };
    encadeavel.single = encadeavel.maybeSingle;
    return encadeavel;
  };
  return { from } as unknown as ActionCtx["admin"];
}

function executar(config: Record<string, unknown>, admin: ActionCtx["admin"]): Promise<ActionResultDetail> {
  const acao = getAction("send_whatsapp_message");
  if (!acao) throw new Error("send_whatsapp_message não está registrada");
  const ctx: ActionCtx = {
    admin,
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Boas-vindas com catálogo",
    event: { id: "evento-1" } as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: CONTATO, phone_number: "+551****8888" } },
  };
  return acao.execute(ctx, config);
}

/** O `input` que chegou ao handler, na última chamada. */
function envio(): Record<string, unknown> {
  const chamada = sendMessageHandler.mock.calls.at(-1);
  if (!chamada) throw new Error("o handler de envio não foi chamado");
  return chamada[2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
  serviceForAutomation.mockResolvedValue(FRONTEIRA);
  assertAgendaEffectSupabase.mockResolvedValue(undefined);
  reportarEnvio.mockImplementation(async (_ctx, type: string) => ({
    type,
    status: "success" as const,
    detail: { message_id: "mensagem-1" },
  }));
});

describe("send_whatsapp_message — SEM mídia (contrato de antes, intacto)", () => {
  it("manda texto puro e não consulta a janela de 24 h", async () => {
    // Anti-vacuidade: o caminho de texto é o que já existia e o que a maioria das
    // regras de produção usa. Se ele passasse a exigir a régua da mídia, toda regra
    // de texto passaria a ler duas tabelas a mais por disparo — e uma leitura que
    // falha barraria um envio que sempre saiu.
    const r = await executar(
      { channel_session_id: CANAL, template: "Oi, {{primeiro_nome}}!" },
      bancoFalso({ provider: "meta_cloud", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ conversation_id: CONVERSA, type: "text" });
    expect(envio().media_url).toBeUndefined();
    expect(envio().media_mime).toBeUndefined();
  });
});

describe("send_whatsapp_message — COM mídia, o texto vira LEGENDA", () => {
  it("imagem: `type: image` + `media_url`, e o corpo é a legenda renderizada", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Olha o catálogo, {{primeiro_nome}}.", media_url: "https://cdn.exemplo/oferta.jpg" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(envio()).toMatchObject({
      conversation_id: CONVERSA,
      type: "image",
      media_url: "https://cdn.exemplo/oferta.jpg",
      media_mime: "image/jpeg",
    });
    // A legenda é o texto da regra renderizado — não uma string vazia nem o corpo
    // cru com a marcação.
    expect(String(envio().body)).not.toContain("{{");
    expect(String(envio().body).length).toBeGreaterThan(0);
  });

  it("PDF: `type: document` — o MIME decide, não o nome do campo", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Segue a proposta.", media_url: "https://cdn.exemplo/proposta.pdf" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({
      type: "document",
      media_url: "https://cdn.exemplo/proposta.pdf",
      media_mime: "application/pdf",
    });
  });

  it("URL sem extensão conhecida e sem MIME: recusa com motivo, sem enviar nada", async () => {
    // Sem pista de tipo, escolher entre mandar como `octet-stream` (chega como
    // arquivo genérico) ou como imagem (quebra o PDF) seria adivinhar. Recusar é o
    // único desfecho honesto.
    const r = await executar(
      { channel_session_id: CANAL, template: "Segue.", media_url: "https://cdn.exemplo/arquivo-sem-extensao" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/imagem|PDF/);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});

describe("send_whatsapp_message — áudio, vídeo e documento (#2972)", () => {
  it("planilha: sai como `document` com o texto de legenda, pela mesma cadeia", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Segue a planilha.", media_url: "https://cdn.exemplo/custos.xlsx" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({
      type: "document",
      media_url: "https://cdn.exemplo/custos.xlsx",
      media_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    // A legenda continua sendo o texto da regra renderizado — não uma string vazia.
    expect(String(envio().body).length).toBeGreaterThan(0);
  });

  it("áudio do operador: sai como `type: audio` (mensagem de voz na ponta do canal)", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Escuta o recado.", media_url: "https://cdn.exemplo/recado.ogg" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ type: "audio", media_mime: "audio/ogg" });
  });

  it("vídeo curto: sai como `type: video`", async () => {
    const r = await executar(
      { channel_session_id: CANAL, template: "Olha o produto.", media_url: "https://cdn.exemplo/produto.mp4" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ type: "video", media_mime: "video/mp4" });
  });

  it("CONTROLE: a URL sem tipo identificável continua recusada, e nada sai", async () => {
    // A cerca que SOBREVIVEU à ampliação: o que a régua ganhou foram tipos
    // conhecidos, não a permissão de adivinhar.
    const r = await executar(
      { channel_session_id: CANAL, template: "Segue.", media_url: "https://cdn.exemplo/relatorio.qzx" },
      bancoFalso({ provider: "waha", ultimoInbound: null }),
    );

    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/imagem/);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(espacarEnvio).not.toHaveBeenCalled();
  });
});

describe("send_whatsapp_message — canal oficial fora da janela de 24 h", () => {
  it("mídia recusada com motivo, e o texto NÃO sai sozinho no lugar dela", async () => {
    const trintaHorasAtras = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const r = await executar(
      { channel_session_id: CANAL, template: "Olha o catálogo.", media_url: "https://cdn.exemplo/oferta.png" },
      bancoFalso({ provider: "meta_cloud", ultimoInbound: trintaHorasAtras }),
    );

    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/janela/i);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("o MESMO canal com a janela ABERTA envia a mídia (anti-vacuidade)", async () => {
    const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await executar(
      { channel_session_id: CANAL, template: "Olha o catálogo.", media_url: "https://cdn.exemplo/oferta.png" },
      bancoFalso({ provider: "meta_cloud", ultimoInbound: umaHoraAtras }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ type: "image", media_url: "https://cdn.exemplo/oferta.png" });
  });

  it("canal sem a restrição (QR) envia a mídia mesmo com o cliente calado há dias", async () => {
    // O caso que a régua NÃO pode pegar: num canal de QR o cliente calado não fecha
    // janela nenhuma, e barrar aqui seria inventar uma regra que o canal não tem.
    const umaSemanaAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await executar(
      { channel_session_id: CANAL, template: "Olha a novidade.", media_url: "https://cdn.exemplo/novidade.webp" },
      bancoFalso({ provider: "waha", ultimoInbound: umaSemanaAtras }),
    );

    expect(r.status).toBe("success");
    expect(envio()).toMatchObject({ type: "image", media_mime: "image/webp" });
  });
});

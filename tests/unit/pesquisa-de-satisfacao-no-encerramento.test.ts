import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import {
  capturarRespostaDeSatisfacao,
  fecharPedidosVencidos,
  lerNotaDaResposta,
  lerOpcaoDaSatisfacao,
  pedirSatisfacaoAoEncerrar,
  resumoDaSatisfacao,
} from "@/lib/atendimento/satisfacao";

import { bancoFake } from "./_duplo-de-banco-692";

import { GET as metricsDaSatisfacao } from "@/app/api/v1/metrics/satisfacao/route";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * A PESQUISA DE SATISFAÇÃO DO ENCERRAMENTO (#4023).
 *
 * ─── O QUE ESTE ARQUIVO PRENDE ──────────────────────────────────────────────
 *
 *   - DESLIGADA de fábrica: organização que nunca ligou não recebe pergunta
 *     nenhuma, e nenhum pedido nasce;
 *   - ligada: a pergunta sai UMA vez ao encerrar, e o segundo fechamento da
 *     MESMA conversa não manda a segunda (o índice parcial único é quem
 *     responde — os dois fechamentos podem chegar juntos);
 *   - a resposta de 1 a 5 que volta pela entrada normal vira a nota do pedido;
 *     "vcs demoraram" não vira nota e segue a vida;
 *   - pedido vencido vira `sem_nota` e NUNCA entra na média: silêncio não é
 *     zero;
 *   - média e contagem com piso `manager`: o `agent` recebe 403 da rota de
 *     métricas.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *
 *   - trocar `ligado === true` por "ausente conta como ligado": o caso de
 *     fábrica acusa;
 *   - tirar o `status = aguardando` da leitura antes de gravar a nota: a
 *     segunda resposta sobrescreve a primeira e o caso do CAS acusa;
 *   - contar `sem_nota` como nota 0: a média do caso de vencido acusa.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";

const LIGADA = { satisfacao: { ligado: true } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendMessageHandler).mockResolvedValue({ id: "msg-1", status: "sent" } as never);
});

describe("#4023 — a pergunta sai UMA vez, e só com a opção ligada", () => {
  it("desligada de fábrica: não envia pergunta e não cria pedido", async () => {
    const banco = bancoFake({ settings: {} });

    const desfecho = await pedirSatisfacaoAoEncerrar(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
    });

    expect(desfecho).toEqual({ pedida: false, motivo: "desligada" });
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(banco.estado.pedidos).toHaveLength(0);
  });

  it("ligada: envia a pergunta uma vez e guarda o pedido aguardando", async () => {
    const banco = bancoFake({ settings: LIGADA });

    const desfecho = await pedirSatisfacaoAoEncerrar(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
    });

    expect(desfecho.pedida).toBe(true);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(sendMessageHandler).mock.calls[0];
    const ctx = chamada?.[1];
    const entrada = chamada?.[2];
    expect(ctx?.organization_id).toBe(ORG);
    expect((entrada as { conversation_id: string }).conversation_id).toBe(CONVERSA);
    expect((entrada as { metadata?: Record<string, unknown> }).metadata?.pesquisa_de_satisfacao).toBe(true);
    expect(banco.estado.pedidos).toHaveLength(1);
    expect(banco.estado.pedidos[0]?.status).toBe("aguardando");
  });

  it("fechar a MESMA conversa de novo não manda a segunda pergunta", async () => {
    const banco = bancoFake({
      settings: LIGADA,
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          status: "aguardando",
          expira_em: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const desfecho = await pedirSatisfacaoAoEncerrar(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
    });

    expect(desfecho).toEqual({ pedida: false, motivo: "ja_pedida" });
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("canal que não entregou fecha o pedido como sem nota (não vira nota zero)", async () => {
    vi.mocked(sendMessageHandler).mockResolvedValue({ id: "msg-2", status: "failed" } as never);
    const banco = bancoFake({ settings: LIGADA });

    const desfecho = await pedirSatisfacaoAoEncerrar(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
    });

    expect(desfecho).toEqual({ pedida: false, motivo: "falha_ao_enviar" });
    expect(banco.estado.pedidos[0]?.status).toBe("sem_nota");
  });

  it("organização parada: não pergunta, não retenta, e o encerramento fica de pé", async () => {
    // Catraca `chamadores-do-envio-tratam-org-parada`: este arquivo é o teste de
    // comportamento de `lib/atendimento/satisfacao.ts`. A suspensão não pode
    // derrubar o fechamento nem marcar a pergunta como enviada.
    vi.mocked(sendMessageHandler).mockRejectedValue(new OrgNaoOperanteError(ORG, "suspended"));
    const banco = bancoFake({ settings: LIGADA });

    const desfecho = await pedirSatisfacaoAoEncerrar(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
    });

    expect(desfecho).toEqual({ pedida: false, motivo: "org_parada" });
    expect(banco.estado.pedidos[0]?.status).toBe("aguardando");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
  });
});

describe("#4023 — a resposta vira nota do pedido", () => {
  it("lê o dígito sozinho e recusa o que não é nota", () => {
    expect(lerNotaDaResposta("5")).toBe(5);
    expect(lerNotaDaResposta(" 4. ")).toBe(4);
    expect(lerNotaDaResposta("nota: 3")).toBe(3);
    expect(lerNotaDaResposta("2 👍")).toBe(2);
    expect(lerNotaDaResposta("50")).toBeNull();
    expect(lerNotaDaResposta("quero 4 caixas")).toBeNull();
    expect(lerNotaDaResposta("4 reais")).toBeNull();
    expect(lerNotaDaResposta(null)).toBeNull();
  });

  it("grava a nota no pedido aguardando da conversa", async () => {
    const banco = bancoFake({
      settings: LIGADA,
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          status: "aguardando",
          expira_em: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const desfecho = await capturarRespostaDeSatisfacao(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      texto: "4",
      messageId: "msg-resposta",
    });

    expect(desfecho).toEqual({ capturada: true, nota: 4 });
    expect(banco.estado.pedidos[0]?.status).toBe("respondida");
    expect(banco.estado.pedidos[0]?.nota).toBe(4);
    expect(banco.estado.pedidos[0]?.mensagem_da_resposta_id).toBe("msg-resposta");
  });

  it("uma SEGUNDA resposta não sobrescreve a primeira", async () => {
    const banco = bancoFake({
      settings: LIGADA,
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          status: "respondida",
          nota: 5,
          respondido_em: new Date().toISOString(),
          expira_em: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const desfecho = await capturarRespostaDeSatisfacao(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      texto: "1",
    });

    expect(desfecho).toEqual({ capturada: false, motivo: "sem_pedido" });
    expect(banco.estado.pedidos[0]?.nota).toBe(5);
  });

  it("mensagem que não é 1-5 não é capturada (segue o caminho normal)", async () => {
    const banco = bancoFake({
      settings: LIGADA,
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          status: "aguardando",
          expira_em: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const desfecho = await capturarRespostaDeSatisfacao(banco.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      texto: "vcs demoraram bastante",
    });

    expect(desfecho).toEqual({ capturada: false, motivo: "nao_e_nota" });
    expect(banco.estado.pedidos[0]?.status).toBe("aguardando");
  });
});

describe("#4023 — média e contagem, e a recusa para quem não gerencia", () => {
  it("pedido vencido vira sem_nota e fica FORA da média", async () => {
    const banco = bancoFake({
      settings: LIGADA,
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: "c-1",
          contact_id: CONTATO,
          status: "respondida",
          nota: 4,
          respondido_em: new Date().toISOString(),
          expira_em: new Date(Date.now() + 3_600_000).toISOString(),
        },
        {
          id: "pedido-2",
          organization_id: ORG,
          conversation_id: "c-2",
          contact_id: CONTATO,
          status: "aguardando",
          expira_em: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    expect(await fecharPedidosVencidos(banco.client, ORG)).toBe(1);
    const resumo = await resumoDaSatisfacao(banco.client, { organizationId: ORG });

    expect(resumo.respostas).toBe(1);
    expect(resumo.media).toBe(4);
    expect(resumo.sem_nota).toBe(1);
    expect(resumo.pedidos).toBe(2);
  });

  it("sem nenhuma nota a média é null, não 0", async () => {
    const banco = bancoFake({
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          status: "sem_nota",
          expira_em: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const resumo = await resumoDaSatisfacao(banco.client, { organizationId: ORG });
    expect(resumo.media).toBeNull();
    expect(resumo.respostas).toBe(0);
  });

  it("a rota de métricas responde para manager", async () => {
    const banco = bancoFake({
      pedidos: [
        {
          id: "pedido-1",
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          status: "respondida",
          nota: 5,
          respondido_em: new Date().toISOString(),
          expira_em: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as Awaited<ReturnType<typeof requireRole>>);
    vi.mocked(createAdminClient).mockReturnValue(banco.client);

    const resposta = await metricsDaSatisfacao(
      new NextRequest("http://localhost/api/v1/metrics/satisfacao"),
    );
    const corpo = (await resposta.json()) as { data: { media: number; respostas: number } };

    expect(resposta.status).toBe(200);
    expect(corpo.data.media).toBe(5);
    expect(corpo.data.respostas).toBe(1);
  });

  it("a rota de métricas recusa quem NÃO gerencia", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const resposta = await metricsDaSatisfacao(
      new NextRequest("http://localhost/api/v1/metrics/satisfacao"),
    );

    expect(resposta.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

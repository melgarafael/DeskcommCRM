import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * FECHAR COM A ESCOLHA DE DEVOLVER AO AUTOMÁTICO (#3313, item 1).
 *
 * A trava de humano mora no CONTATO (`contacts.force_human`), não na conversa:
 * fechar a conversa não a soltava, e a próxima mensagem daquele cliente, dias
 * depois, era pulada pela IA sem ninguém perceber. A rota passa a aceitar a
 * escolha do diálogo de fechamento e, quando ela é "devolver", chama
 * `devolverAtendimentoAoAgente` — a MESMA função do botão da tela e do cron.
 *
 * ─── O QUE ESTE ARQUIVO PRENDE ──────────────────────────────────────────────
 *
 *   - sem a chave no corpo, a regra NÃO é chamada: fechar continua sendo só
 *     fechar (é o caso de toda conversa sem contato travado e de todo cliente
 *     antigo da API);
 *   - `false` (="Manter com a equipe") também não chama nada — a trava fica;
 *   - `true` (o padrão MARCADO) chama a regra com a conversa, a org e o ator
 *     humano certos, e a conversa encerra do mesmo jeito;
 *   - `contato_sempre_humano` (marca «sempre atendimento humano») NÃO vira erro
 *     na tela: a conversa fechou e o que muda é a resposta, que conta que a
 *     trava continua — sem log de erro, porque é recusa esperada;
 *   - falha de banco na devolução também não derruba o fechamento, mas fica no
 *     log (é defeito, não recusa).
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - tirar a chamada da regra: os casos de `true` acusam (nada é chamado, e o
 *     corpo sai sem `devolucao`);
 *   - chamar a regra sempre, ignorando a chave: os casos de corpo sem chave e o
 *     de `false` acusam.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const ATENDENTE = "22222222-2222-4222-8222-222222222222";
const COLEGA = "33333333-3333-4333-8333-333333333333";

const CONVERSA_FECHADA = {
  id: CONVERSA,
  organization_id: ORG,
  status: "closed",
  service_revision: 7,
  // A main passou a exigir controle da conversa antes de qualquer escrita
  // (`exigirControleDaConversa`): sem dono, o `fn_can_view_conversation` abaixo
  // responde que este atendente pode encerrar.
  assigned_to_user_id: null,
};

function chamar(corpo: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/close`, {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: CONVERSA }) },
  );
}

type Resposta = { data: Record<string, unknown> & { devolucao?: { ok: boolean; motivo?: string } } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONVERSA_FECHADA, error: null }) }) }),
      }),
    }),
    // `exigirControleDaConversa` (main) chama `fn_can_view_conversation` para
    // conversa SEM dono humano; `true` = este atendente pode encerrar.
    rpc: async () => ({ data: true, error: null }),
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: async () => ({ data: CONVERSA_FECHADA, error: null }),
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
    ok: true,
    conversationId: CONVERSA,
    jaEstavaComOAgente: false,
    continuidade: { houveAtendimentoHumano: false, resumo: "", decisoes: [], notas: [] },
  } as unknown as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);
});

describe("close — fechar sem a escolha não devolve nada", () => {
  it("corpo sem a chave: fecha, não chama a regra e o corpo sai como sempre saiu", async () => {
    const res = await chamar({ expected_revision: 7 });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.id).toBe(CONVERSA);
    expect(devolverAtendimentoAoAgente, "quem não pediu não pode ganhar devolução").not.toHaveBeenCalled();
    expect(Object.keys(corpo.data)).not.toContain("devolucao");
  });

  it("corpo com corpo vazio (cliente antigo) também não devolve", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(devolverAtendimentoAoAgente).not.toHaveBeenCalled();
  });

  it("'Manter com a equipe' (`false`): fecha e a trava continua — a regra não é chamada", async () => {
    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: false });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toBeUndefined();
    expect(devolverAtendimentoAoAgente).not.toHaveBeenCalled();
  });
});

describe("close — 'Devolver ao automático ao fechar' (o padrão marcado)", () => {
  it("chama a MESMA regra do botão, com a conversa, a org e o ator humano", async () => {
    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: true });
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledTimes(1);
    const [deps, input] = vi.mocked(devolverAtendimentoAoAgente).mock.calls[0]!;
    expect(deps.organizationId).toBe(ORG);
    expect(deps.actor).toEqual({ type: "user", id: ATENDENTE, role: "agent" });
    expect(input).toEqual({ conversationId: CONVERSA, expectedAssignee: null });
    // Nenhuma origem automática: quem devolveu foi a pessoa, no gesto de fechar.
    expect(input.origem).toBeUndefined();
  });

  it("contato 'sempre atendimento humano': a conversa fecha, a trava CONTINUA e não há log de erro", async () => {
    vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
      ok: false,
      erro: "contato_sempre_humano",
    } as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    // 200, e não 409: o fechamento ACONTECEU. O que a tela precisa saber é que a
    // IA não voltou — e é isso que viaja no corpo.
    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: false, motivo: "contato_sempre_humano" });
    expect(logger.error, "recusa esperada não é defeito de banco").not.toHaveBeenCalled();
  });

  it("falha de banco na devolução não derruba o fechamento, mas fica no log", async () => {
    vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
      ok: false,
      erro: "assignment_conflict",
      detalhe: "deadlock detected",
    } as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: false, motivo: "assignment_conflict" });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("fechamento que falha (revisão obsoleta) NÃO devolve: 409 sem tocar na trava", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: async () => ({ data: null, error: { code: "PT409", message: "rev" } }),
    } as unknown as ReturnType<typeof createAdminClient>);

    const res = await chamar({ expected_revision: 6, devolver_ao_automatico: true });

    expect(res.status).toBe(409);
    expect(devolverAtendimentoAoAgente, "devolver uma conversa que não fechou desfaria o 409").not.toHaveBeenCalled();
  });
});

/**
 * A MESMA REGRA DE DONO DO BOTÃO "Devolver ao automático" (#3436).
 *
 * `reactivate-bot` só devolve conversa de outro atendente pela mão de um
 * `manager` ou acima, e passa o dono lido como `expectedAssignee`. Fechar com
 * "devolver" marcado é o mesmo gesto por outra porta: sem a regra aqui, o
 * agente que não pode clicar o botão conseguiria o mesmo efeito fechando.
 *
 * SABOTAGEM: tirar a guarda de dono da rota faz o primeiro caso acusar (a regra
 * é chamada e a devolução sai `ok: true`); tirar o `expectedAssignee` faz o
 * segundo acusar.
 */
describe("close — devolver ao fechar segue a regra de dono do botão", () => {
  function conversaDoColega(papel: "agent" | "manager") {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: ATENDENTE, idioma: "pt-BR" },
      org: { orgId: ORG, role: papel },
    } as Awaited<ReturnType<typeof requireRole>>);
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { ...CONVERSA_FECHADA, assigned_to_user_id: COLEGA },
                error: null,
              }),
            }),
          }),
        }),
      }),
      // Quem pode ver pode encerrar: o fechamento em si não é o que se recusa.
      rpc: async () => ({ data: true, error: null }),
    } as unknown as Awaited<ReturnType<typeof createClient>>);
  }

  it("agente fechando conversa de colega com 'devolver': fecha, mas a trava NÃO é solta", async () => {
    conversaDoColega("agent");

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: false, motivo: "conversa_de_outro_atendente" });
    expect(devolverAtendimentoAoAgente, "agente não devolve conversa de colega").not.toHaveBeenCalled();
  });

  it("gerente fechando conversa de colega devolve, exigindo que o dono ainda seja o lido", async () => {
    conversaDoColega("manager");

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: true });
    const [, input] = vi.mocked(devolverAtendimentoAoAgente).mock.calls[0]!;
    expect(input).toEqual({ conversationId: CONVERSA, expectedAssignee: COLEGA });
  });
});

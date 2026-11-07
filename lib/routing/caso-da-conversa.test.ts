/**
 * O CASO DA CONVERSA TIRA A CONVERSA DA FILA? (issue #3717)
 *
 * ## O defeito que este teste tranca
 *
 * `lib/routing/decide.ts` e `lib/routing/eligibles.ts` nunca leram
 * `agent_cases`: a elegibilidade era só
 * `conversations.status ∈ (open,pending,claimed,ai_handling) ∧ sem dono`
 * (`..._0228_...:76-81`, dentro de `fn_wake_channel_routing`). Uma conversa cujo
 * caso JÁ NÃO pede ninguém — `awaiting_lead` (a bola está com o cliente) ou um
 * caso `resolved`/`cancelled` sem entrada nova do cliente — continuava elegível
 * e era reenfileirada a cada mudança de disponibilidade de QUALQUER atendente
 * (`trg_routing_availability_changed`). O rodízio então entregava a uma pessoa
 * uma conversa em que ela não tem nada a fazer.
 *
 * ## Por que os testes olham a FRONTEIRA, e não só "não atribuiu"
 *
 * Um teste que só conferisse "conversa com caso awaiting_lead não é atribuída"
 * passaria numa implementação que para de rotear QUALQUER conversa com caso —
 * inclusive a `awaiting_human`, que é justamente a que precisa de gente. Os
 * casos abaixo cobrem os dois lados, mais a ordem das regras (o caso vence o
 * destino padrão do número, e perde para a idempotência) e o corte temporal que
 * impede um caso concluído de calar a fila para sempre.
 */
import { describe, expect, it } from "vitest";

import { motivoParaNaoRotear } from "./caso-da-conversa";
import { decideRouting, type RoutingCandidate } from "./decide";
import { motivoDoCasoParaRoteamento } from "./worker";
import { routingConfigSchema } from "@/lib/schemas/routing";

const NOW = new Date("2026-10-30T12:00:00Z");
const cand = (userId: string): RoutingCandidate => ({
  userId,
  currentLoad: 0,
  lastAssignedAt: null,
});
const config = routingConfigSchema.parse({ mode: "round_robin" });

describe("motivoParaNaoRotear — de quem é a bola", () => {
  it("sem caso nenhum, a fila segue como sempre (todo o histórico do produto)", () => {
    expect(motivoParaNaoRotear(null, null)).toBeNull();
    expect(motivoParaNaoRotear(undefined, "2026-10-30T11:00:00Z")).toBeNull();
  });

  it("awaiting_human PEDE uma pessoa: continua roteável", () => {
    // Este é o caso que a regra não pode calar: a IA travou e a pergunta está
    // com a equipe. Sem esta linha, o conserto viraria "caso aberto nunca chega
    // a um humano".
    expect(motivoParaNaoRotear({ status: "awaiting_human", encerradoEm: null }, null)).toBeNull();
  });

  it("escalated (foi passado adiante) também pede uma pessoa", () => {
    // Mesma doutrina de `operator-turn.ts:676`: awaiting_human e escalated são
    // os estados em que a pergunta está com a equipe.
    expect(
      motivoParaNaoRotear({ status: "escalated", encerradoEm: "2026-10-30T10:00:00Z" }, null),
    ).toBeNull();
  });

  it("awaiting_lead: a bola está com o CLIENTE — não distribui", () => {
    expect(motivoParaNaoRotear({ status: "awaiting_lead", encerradoEm: null }, null)).toBe(
      "caso_aguardando_cliente",
    );
  });

  it("awaiting_lead: o cliente respondeu DEPOIS do pedido — a fila volta a valer", () => {
    // `provide_case_update` (a saída de awaiting_lead) é ferramenta do modelo, e
    // nenhum gatilho de agent_cases pede roteamento. Com o agente pausado, ou com
    // um modelo que não chama a ferramenta, o caso ficaria awaiting_lead para
    // sempre: sem este corte, a resposta do cliente nunca chegaria a ninguém.
    expect(
      motivoParaNaoRotear(
        { status: "awaiting_lead", encerradoEm: null, atualizadoEm: "2026-10-30T11:00:00Z" },
        "2026-10-30T11:59:00Z",
      ),
    ).toBeNull();
  });

  it("awaiting_lead: o cliente falou ANTES do pedido — continua barrando", () => {
    // A última fala é anterior ao pedido da equipe: o cliente ainda não
    // respondeu o que foi perguntado.
    expect(
      motivoParaNaoRotear(
        { status: "awaiting_lead", encerradoEm: null, atualizadoEm: "2026-10-30T11:00:00Z" },
        "2026-10-30T10:30:00Z",
      ),
    ).toBe("caso_aguardando_cliente");
  });

  it("caso resolvido sem entrada nova do cliente: não distribui", () => {
    // O desfecho da issue: a IA resolveu, ninguém fechou a conversa, e ela
    // seguia no pool elegível.
    expect(
      motivoParaNaoRotear(
        { status: "resolved", encerradoEm: "2026-10-30T10:00:00Z" },
        "2026-10-30T09:00:00Z",
      ),
    ).toBe("caso_encerrado");
  });

  it("cancelado sem entrada nova do cliente: não distribui", () => {
    expect(
      motivoParaNaoRotear({ status: "cancelled", encerradoEm: "2026-10-30T10:00:00Z" }, null),
    ).toBe("caso_encerrado");
  });

  it("cliente falou DEPOIS do encerramento: assunto novo, a fila volta a valer", () => {
    // Sem este corte, um caso concluído ontem calaria a fila para sempre: o
    // cliente que escreve "e o boleto?" dois dias depois nunca chegaria a
    // ninguém.
    expect(
      motivoParaNaoRotear(
        { status: "resolved", encerradoEm: "2026-10-28T10:00:00Z" },
        "2026-10-30T09:00:00Z",
      ),
    ).toBeNull();
  });

  it("status desconhecido falha ABERTO (distribui)", () => {
    // Clone com engine mais novo pode gravar um estado que este build não
    // conhece; parar a distribuição de uma org inteira por isso é o erro caro.
    expect(
      motivoParaNaoRotear({ status: "estado_novo_do_futuro", encerradoEm: null }, null),
    ).toBeNull();
  });
});

describe("decideRouting — o caso vence a fila, e perde para a idempotência", () => {
  it("com motivo do caso, NÃO atribui — mesmo com elegível sobrando", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [cand("agente-a"), cand("agente-b")],
      config,
      attempts: 0,
      now: NOW,
      motivoDoCaso: "caso_aguardando_cliente",
    });
    expect(action).toEqual({ kind: "skip", reason: "caso_aguardando_cliente" });
  });

  it("o caso responde SE há distribuição, antes de o número responder QUEM recebe", () => {
    // #2331 entrega o número inteiro a uma pessoa de destino padrão. Um caso que
    // já não pede ninguém não vira trabalho dela.
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [],
      config,
      defaultAssigneeUserId: "dono-do-numero",
      attempts: 0,
      now: NOW,
      motivoDoCaso: "caso_encerrado",
    });
    expect(action).toEqual({ kind: "skip", reason: "caso_encerrado" });
  });

  it("conversa que já tem dono continua sendo `already_assigned` (idempotência primeiro)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: true,
      eligibles: [cand("agente-a")],
      config,
      attempts: 0,
      now: NOW,
      motivoDoCaso: "caso_aguardando_cliente",
    });
    expect(action).toEqual({ kind: "skip", reason: "already_assigned" });
  });

  it("sem motivo do caso, nada muda: atribui como antes", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [cand("agente-a")],
      config,
      attempts: 0,
      now: NOW,
      motivoDoCaso: null,
    });
    expect(action).toEqual({ kind: "assign", userId: "agente-a" });
  });
});

/** Dublê mínimo do client admin: registra a cadeia e devolve `resposta`. */
function clientDuble(resposta: { data: unknown; error: { message: string } | null }) {
  const chamadas: Array<{ tabela: string; filtros: string[]; ordens: string[]; limite?: number }> =
    [];
  const client = {
    from(tabela: string) {
      const registro = {
        tabela,
        filtros: [] as string[],
        ordens: [] as string[],
        limite: undefined as number | undefined,
      };
      const cadeia: Record<string, unknown> = {
        select() {
          return cadeia;
        },
        eq(col: string, val: unknown) {
          registro.filtros.push(`${col}=${String(val)}`);
          return cadeia;
        },
        order(col: string, opts: { ascending: boolean }) {
          registro.ordens.push(`${col}:${opts.ascending ? "asc" : "desc"}`);
          return cadeia;
        },
        limit(n: number) {
          registro.limite = n;
          return cadeia;
        },
        maybeSingle() {
          chamadas.push(registro);
          return Promise.resolve(resposta);
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

describe("motivoDoCasoParaRoteamento — a leitura do caso mais recente", () => {
  it("busca o caso da ORG e da CONVERSA, o mais recente, uma linha só", async () => {
    const { client, chamadas } = clientDuble({
      data: { status: "awaiting_lead", closed_at: null },
      error: null,
    });

    const motivo = await motivoDoCasoParaRoteamento(client as never, ORG, {
      id: CONVERSA,
      last_inbound_at: null,
    });
    expect(motivo).toBe("caso_aguardando_cliente");

    const c = chamadas[0]!;
    expect(c.tabela).toBe("agent_cases");
    // Service role bypassa RLS: o filtro de org é programático, não opcional.
    expect(c.filtros).toContain(`organization_id=${ORG}`);
    // O caso pertence a UMA conversa (um contato pode ter várias por canal).
    expect(c.filtros).toContain(`conversation_id=${CONVERSA}`);
    expect(c.ordens).toEqual(["created_at:desc", "id:desc"]);
    expect(c.limite).toBe(1);
  });

  it("awaiting_lead lido do banco usa updated_at como o instante do pedido", async () => {
    const { client } = clientDuble({
      data: { status: "awaiting_lead", closed_at: null, updated_at: "2026-10-30T11:00:00Z" },
      error: null,
    });
    await expect(
      motivoDoCasoParaRoteamento(client as never, ORG, {
        id: CONVERSA,
        last_inbound_at: "2026-10-30T11:59:00Z",
      }),
    ).resolves.toBeNull();
  });

  it("caso awaiting_human lido do banco devolve null (pode distribuir)", async () => {
    const { client } = clientDuble({
      data: { status: "awaiting_human", closed_at: null },
      error: null,
    });
    await expect(
      motivoDoCasoParaRoteamento(client as never, ORG, { id: CONVERSA, last_inbound_at: null }),
    ).resolves.toBeNull();
  });

  it("conversa sem caso devolve null", async () => {
    const { client } = clientDuble({ data: null, error: null });
    await expect(
      motivoDoCasoParaRoteamento(client as never, ORG, { id: CONVERSA, last_inbound_at: null }),
    ).resolves.toBeNull();
  });

  it("falha do banco NÃO derruba o evento: falha aberta, a fila distribui", async () => {
    // Subir a exceção reenfileiraria o evento e deixaria a conversa sem dono —
    // o desfecho caro. O erro sai no log, não na fila.
    const { client } = clientDuble({ data: null, error: { message: "boom" } });
    await expect(
      motivoDoCasoParaRoteamento(client as never, ORG, { id: CONVERSA, last_inbound_at: null }),
    ).resolves.toBeNull();
  });
});

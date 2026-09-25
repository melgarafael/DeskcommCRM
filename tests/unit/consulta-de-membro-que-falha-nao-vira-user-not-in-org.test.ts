/**
 * A CONSULTA DE MEMBRO QUE FALHA NÃO É "O USUÁRIO NÃO É DA ORGANIZAÇÃO".
 *
 * `assign_owner` pergunta a `user_organizations` se o usuário escolhido é membro
 * ativo da organização. Essa pergunta tem TRÊS respostas possíveis, não duas:
 *
 *   "é membro"      → escreve o responsável no lead;
 *   "não é membro"  → `user_not_in_org` (o operador vai mexer no que está certo);
 *   "não deu para   → a consulta falhou (rede, banco fora). Culpar a
 *    saber"             configuração do operador por uma queda de infraestrutura
 *                       manda ele mexer no que está certo (classe: falhar
 *                       fechado na ação, aberto na informação).
 *
 * O `maybeSingle` do supabase-js devolve `data: null` com o `error` preenchido
 * quando a conexão cai — medido no lote 9 de triagem com o cliente apontado para
 * `127.0.0.1:1`: a ação lia só o `data`, e o histórico da regra gravava
 * `user_not_in_org`. Os dois últimos casos abaixo ficam idênticos sem o
 * conserto; é o primeiro deles que fica vermelho se o `error` voltar a ser
 * ignorado.
 *
 * Só o banco é dublê (mesma forma dos vizinhos `send-ai-message.test.ts` e
 * `tests/unit/automacoes-de-demonstracao-sao-coerentes.test.ts`): o executor é o
 * de verdade, pego do registro por `getAction("assign_owner")`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/assign-owner";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "88800000-0000-4000-8000-000000000001";
const GERENTE = "88800000-0000-4000-8000-000000000002";
const LEAD = "88800000-0000-4000-8000-000000000003";

/** O que o `maybeSingle` da consulta de membro devolveu. */
type RespostaDaConsulta = { data: unknown; error: { message: string } | null };

/** O que a ação tentou gravar — a escrita observada é o outro lado da promessa. */
type Escrita = { tabela: string; valores: Record<string, unknown> };

/**
 * Dublê do admin client: `maybeSingle` responde o que o teste mandou (inclusive
 * o erro de infraestrutura), e `update … eq … eq` registra a escrita e é
 * aguardável. As duas partes importam: sem o erro de verdade o teste do caso de
 * infraestrutura seria vazio, e sem a escrita registrada uma ação que nunca
 * atribuísse ninguém passaria no caso do membro de verdade.
 */
function banco(resposta: RespostaDaConsulta, escritas: Escrita[]): SupabaseClient {
  const tabela = (nome: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "order", "limit"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => resposta;
    cadeia.update = (valores: Record<string, unknown>) => {
      escritas.push({ tabela: nome, valores });
      return cadeia;
    };
    cadeia.then = (resolve: (v: { error: null }) => unknown) => resolve({ error: null });
    return cadeia;
  };
  return { from: tabela } as unknown as SupabaseClient;
}

function ctx(admin: SupabaseClient): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "88800000-0000-4000-8000-000000000004",
    ruleName: "Automação de teste",
    event: {
      id: "88800000-0000-4000-8000-000000000005",
      organization_id: ORG,
      event_type: "lead.created",
      entity_kind: "lead",
      entity_id: LEAD,
      payload: { lead_id: LEAD },
      metadata: {},
      consumed_by: [],
      attempts: 0,
    } as unknown as EventRow,
    context: { lead: { id: LEAD } },
    requestId: "test-request-id",
  };
}

const MEMBRO_ATIVO = { user_id: GERENTE, role: "manager" };

describe("assign_owner — consulta de membro que falha não vira user_not_in_org", () => {
  it("membro ativo: atribui o lead e o histórico diz o usuário", async () => {
    const escritas: Escrita[] = [];
    const resultado = await getAction("assign_owner")!.execute(ctx(banco({ data: MEMBRO_ATIVO, error: null }, escritas)), {
      user_id: GERENTE,
    });

    expect(resultado).toEqual({ type: "assign_owner", status: "success", detail: { user_id: GERENTE } });
    expect(escritas.map((e) => e.tabela)).toEqual(["crm_leads"]);
    expect(escritas[0]!.valores.owner_user_id).toBe(GERENTE);
    expect(escritas[0]!.valores.owner_kind).toBe("user");
    expect(escritas[0]!.valores.owner_agent_id).toBeNull();
  });

  it("membro ausente (data: null, error: null): user_not_in_org, e o lead não é tocado", async () => {
    const escritas: Escrita[] = [];
    const resultado = await getAction("assign_owner")!.execute(ctx(banco({ data: null, error: null }, escritas)), {
      user_id: GERENTE,
    });

    expect(resultado.status).toBe("failed");
    expect(resultado.error).toBe("user_not_in_org");
    expect(escritas).toEqual([]);
  });

  it("consulta com erro (rede/banco fora): falha transitória com a mensagem do erro", async () => {
    const escritas: Escrita[] = [];
    const erro = { message: "TypeError: fetch failed" };
    const admin = banco({ data: null, error: erro }, escritas);

    // Guarda de vacuidade: o dublê devolve MESMO o erro que o caso precisa —
    // sem isso, o caso passaria por não ter erro nenhum para ignorar.
    expect((await admin.from("user_organizations").select("user_id, role").maybeSingle()).error).toEqual(erro);

    const resultado = await getAction("assign_owner")!.execute(ctx(admin), { user_id: GERENTE });

    expect(resultado.status).toBe("failed");
    expect(resultado.error, "quem falhou foi a infraestrutura, não a configuração do operador").not.toBe(
      "user_not_in_org",
    );
    expect(resultado.error).toBe("membro_indeterminado");
    expect(resultado.detail).toEqual({ reason: "membro_indeterminado", erro: "TypeError: fetch failed" });
    expect(escritas).toEqual([]);
  });

  it("garante que o trio owner_user_id, owner_kind='user' e owner_agent_id=null seja sempre gravado", async () => {
    const escritas: Escrita[] = [];
    const resultado = await getAction("assign_owner")!.execute(
      ctx(banco({ data: MEMBRO_ATIVO, error: null }, escritas)),
      { user_id: GERENTE },
    );

    expect(resultado.status).toBe("success");
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.valores).toMatchObject({
      owner_user_id: GERENTE,
      owner_agent_id: null,
      owner_kind: "user",
    });
  });
});

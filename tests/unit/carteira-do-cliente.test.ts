/**
 * Issue #2591 — carteira do cliente: o contato ganha um vendedor dono.
 *
 * ─── RED-BEFORE (medido ANTES de qualquer linha de fix) ─────────────────────
 *
 * Os dois primeiros casos medem a AUSÊNCIA de hoje, que é o que a issue
 * descreve:
 *
 *   1. não há dono por contato — o `contacts` do schema não tem
 *      `carteira_user_id` (o dono só existe em `crm_leads.owner_user_id` e em
 *      `conversations.assigned_to_user_id`);
 *   2. não há aviso — nenhum consumidor de `message.received` conhece a
 *      carteira, então quem atende outro vendedor não avisa ninguém.
 *
 * Sem as três fatias do PR estes casos reprovam (rc 1); com elas passam
 * (rc 0). Os demais casos são a regra das três fatias: decisão do aviso,
 * comportamento do handler, caminho do servidor da carteira e a virada do
 * negócio novo.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const raiz = path.resolve(__dirname, "..", "..");

/**
 * Especificador em VARIÁVEL de propósito: com literal, o vite resolve o import
 * na transformação e o arquivo INTEIRO cai no carregamento ("Failed to resolve
 * import"), sem rodar nenhum caso — o vermelho sairia como erro de config, não
 * como asserção. Em variável, o import falha DENTRO do caso e cada um
 * reprovando pelo que mede.
 */
const MODULO_AVISO = "@/lib/carteira/aviso-ao-dono";
const MODULO_NEGOCIO = "@/lib/carteira/negocio-novo";

function arquivo(relativo: string): string {
  return readFileSync(path.join(raiz, relativo), "utf8");
}

/** O trecho da `contacts` — CREATE TABLE + os `alter table` do apêndice. */
function textoDoContato(): string {
  const baseline = arquivo("supabase/baseline.sql");
  const inicio = baseline.indexOf('CREATE TABLE IF NOT EXISTS "public"."contacts"');
  const bloco = inicio >= 0 ? baseline.slice(inicio, inicio + 6000) : "";
  const alteracoes = [...baseline.matchAll(/alter table (?:public\.)?contacts\b[\s\S]{0,600}/gi)]
    .map((m) => m[0])
    .join("\n");
  return `${bloco}\n${alteracoes}`;
}

describe("#2591 — fatia 1: dono por contato", () => {
  it("o contato tem dono no schema (carteira_user_id em contacts)", () => {
    expect(
      textoDoContato(),
      "sem carteira_user_id em contacts não existe dono por contato — só por negócio e por conversa",
    ).toContain("carteira_user_id");
  });

  it("o dono é gravado só pelo caminho do servidor (RPC + trava da sessão)", () => {
    const baseline = arquivo("supabase/baseline.sql");
    expect(baseline).toContain("fn_definir_carteira_do_cliente");
    expect(baseline, "a coluna precisa ficar fora do que o authenticated grava (#2591)").toContain(
      "trg_contacts_carteira_so_pelo_servidor",
    );
  });

  it("a porta manager+ da carteira existe na API", () => {
    const rota = path.join(raiz, "app/api/v1/contacts/[id]/carteira/route.ts");
    expect(existsSync(rota), "sem rota não há como o gerente pôr o cliente na carteira").toBe(true);
    expect(readFileSync(rota, "utf8")).toContain('requireRole("manager"');
  });
});

describe("#2591 — fatia 2: aviso ao vendedor dono", () => {
  it("um consumidor de message.received avisa o vendedor dono", async () => {
    const registro = arquivo("lib/event-log/register-handlers.ts");
    expect(registro, "sem registro não há aviso: o dreno não chama ninguém").toContain(
      "avisoAoDonoDaCarteira",
    );

    const { avisoAoDonoDaCarteira } = await import(/* @vite-ignore */ MODULO_AVISO);
    expect(avisoAoDonoDaCarteira.events).toContain("message.received");
    // Escrita interna: roda com a organização parada (mesma régua do push).
    expect(avisoAoDonoDaCarteira.naOrgParada).toBe("roda");
  });

  it("a regra do aviso: sem dono nada muda; dono atendendo nada muda; tarefa aberta não repete", async () => {
    const { decidirAvisoDeCarteira } = await import(/* @vite-ignore */ MODULO_AVISO);

    expect(decidirAvisoDeCarteira({ donoId: null, atendenteId: "u-b", tarefaAberta: false })).toBe(
      "sem_carteira",
    );
    expect(decidirAvisoDeCarteira({ donoId: "u-a", atendenteId: "u-a", tarefaAberta: false })).toBe(
      "dono_quem_atende",
    );
    expect(decidirAvisoDeCarteira({ donoId: "u-a", atendenteId: null, tarefaAberta: false })).toBe(
      "sem_atendente",
    );
    expect(decidirAvisoDeCarteira({ donoId: "u-a", atendenteId: "u-b", tarefaAberta: true })).toBe(
      "tarefa_ja_aberta",
    );
    expect(decidirAvisoDeCarteira({ donoId: "u-a", atendenteId: "u-b", tarefaAberta: false })).toBe(
      "cria_tarefa",
    );
  });

  it("com o cliente falando com outro vendedor, o handler cria UMA tarefa para o dono", async () => {
    const criarTarefaInterna = vi.fn(
      async (
        _db: unknown,
        _pedido: { organizationId: string; atribuirA: unknown; contactId: string | null; origem: string },
      ) => ({ ok: true as const, tarefa_id: "tarefa-1", assigned_to: "u-a" }),
    );
    vi.doMock("@/lib/tarefas/criar-tarefa", () => ({ criarTarefaInterna }));

    const linhas: Record<string, Array<Record<string, unknown>>> = {
      contacts: [{ id: "contato-1", organization_id: "org-1", carteira_user_id: "u-a", name: "Cliente" }],
      conversations: [{ id: "conv-1", organization_id: "org-1", assigned_to_user_id: "u-b" }],
      crm_tasks: [],
      user_organizations: [
        { user_id: "u-a", organization_id: "org-1", role: "agent", accepted_at: "2026-01-01", revoked_at: null },
      ],
    };
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: (tabela: string) => cadeia(tabela, linhas[tabela] ?? []),
      }),
    }));
    // Os casos de cima já importaram o módulo de verdade: sem isto o cache
    // devolve o módulo antigo e o `doMock` não muda nada.
    vi.resetModules();

    const { avisoAoDonoDaCarteira } = await import(/* @vite-ignore */ MODULO_AVISO);
    const r = await avisoAoDonoDaCarteira.handle(evento());
    expect(r.status).toBe("ok");
    expect(criarTarefaInterna).toHaveBeenCalledTimes(1);
    const pedido = criarTarefaInterna.mock.calls[0]![1];
    expect(pedido.atribuirA).toEqual({ usuario_id: "u-a" });
    expect(pedido.contactId).toBe("contato-1");
    vi.doUnmock("@/lib/tarefas/criar-tarefa");
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });
});

describe("#2591 — fatia 2: dono que saiu da equipe não recebe aviso (regra 5)", () => {
  it("com o dono revogado, o handler não cria tarefa", async () => {
    const criarTarefaInterna = vi.fn(async () => ({ ok: true as const, tarefa_id: "t", assigned_to: "u-a" }));
    vi.doMock("@/lib/tarefas/criar-tarefa", () => ({ criarTarefaInterna }));
    const linhas: Record<string, Array<Record<string, unknown>>> = {
      contacts: [{ id: "contato-1", organization_id: "org-1", carteira_user_id: "u-a", name: "Cliente" }],
      conversations: [{ id: "conv-1", organization_id: "org-1", assigned_to_user_id: "u-b" }],
      crm_tasks: [],
      user_organizations: [
        { user_id: "u-a", organization_id: "org-1", role: "agent", accepted_at: "2026-01-01", revoked_at: "2026-02-01" },
      ],
    };
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({ from: (tabela: string) => cadeia(tabela, linhas[tabela] ?? []) }),
    }));
    vi.resetModules();
    const { avisoAoDonoDaCarteira } = await import(/* @vite-ignore */ MODULO_AVISO);
    const r = await avisoAoDonoDaCarteira.handle(evento());
    expect(r.status).toBe("skipped");
    expect(criarTarefaInterna).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/tarefas/criar-tarefa");
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });
});

describe("#2591 — fatia 3: o negócio novo nasce com o dono", () => {
  it("o gatilho de inserção do negócio existe e só age quando o negócio chega sem dono", () => {
    const baseline = arquivo("supabase/baseline.sql");
    expect(baseline, "sem gatilho, o negócio novo continua nascendo no rodízio").toContain(
      "trg_crm_lead_nasce_na_carteira on public.crm_leads",
    );
    // O corpo da função é o que tem de estar certo (o nome aparece também no
    // cabeçalho `-- manifest:`, então procurar só o nome mediria comentário).
    const criacao = baseline.indexOf("create or replace function public.fn_crm_lead_nasce_na_carteira");
    expect(criacao, "a função do gatilho não está no schema").toBeGreaterThan(-1);
    const corpo = baseline.slice(criacao, criacao + 3500);
    // A guarda de "já tem dono não muda" é regra da issue: ninguém perde
    // carteira por um gatilho.
    expect(corpo).toMatch(/if new\.owner_user_id is not null or new\.owner_agent_id is not null then/);
    // E sem carteira a função devolve a linha intacta — é isto que mantém o
    // rodízio atual de pé.
    expect(corpo).toMatch(/if v_dono is null then\s*return new;/);
  });

  it("no modo 'Só os seus', criar negócio para cliente de outro vendedor é recusado com motivo", async () => {
    const { recusaNegocioNaCarteiraDeOutro } = await import(/* @vite-ignore */ MODULO_NEGOCIO);
    expect(
      recusaNegocioNaCarteiraDeOutro({
        modo: "own",
        criadorId: "u-b",
        donoDaCarteira: "u-a",
      }),
    ).toBe(true);
    // Sem carteira nada muda (o padrão do #2547 continua: o que ele cria é dele).
    expect(recusaNegocioNaCarteiraDeOutro({ modo: "own", criadorId: "u-b", donoDaCarteira: null })).toBe(false);
    // Cliente da PRÓPRIA carteira: ele cria normalmente.
    expect(recusaNegocioNaCarteiraDeOutro({ modo: "own", criadorId: "u-a", donoDaCarteira: "u-a" })).toBe(false);
    // Fora do modo 'own' não há recusa: o gatilho cuida do dono.
    expect(recusaNegocioNaCarteiraDeOutro({ modo: "all", criadorId: "u-b", donoDaCarteira: "u-a" })).toBe(false);
  });
});

// ─── dublês ─────────────────────────────────────────────────────────────────

function evento() {
  return {
    id: "evento-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: { conversation_id: "conv-1", contact_id: "contato-1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** Builder mínimo no formato PostgREST que o handler encadeia. */
function cadeia(tabela: string, linhas: Array<Record<string, unknown>>) {
  const filtros: Record<string, unknown> = {};
  const resolver = () => {
    const achadas = linhas.filter((linha) =>
      Object.entries(filtros).every(([col, valor]) => {
        if (Array.isArray(valor)) return valor.includes(linha[col]);
        return linha[col] === valor;
      }),
    );
    return { data: achadas, error: null };
  };
  const builder = {
    select: () => builder,
    eq: (col: string, valor: unknown) => {
      filtros[col] = valor;
      return builder;
    },
    in: (col: string, valor: unknown) => {
      filtros[col] = valor;
      return builder;
    },
    limit: () => builder,
    maybeSingle: async () => {
      const { data, error } = resolver();
      return { data: data[0] ?? null, error };
    },
    then: (
      resolve: (valor: { data: Array<Record<string, unknown>>; error: null }) => unknown,
      reject?: (erro: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject),
  };
  void tabela;
  return builder;
}

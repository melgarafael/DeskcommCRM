/**
 * OS MODELOS DE MENSAGEM VISTOS DE FORA — o que a integração vê e o que ela
 * consegue preencher (issue #1615).
 *
 * Três garantias, e nenhuma delas é sobre "a lista funciona":
 *
 * 1. **O pessoal de cada atendente não sai para o token.** A tool usa o client
 *    service-role, que bypassa a policy `message_templates_select`; sem repetir
 *    o predicado dela, qualquer token de integração lia os rascunhos pessoais de
 *    todo mundo. O `eq("organization_id", …)` não bastava: ele separa empresas,
 *    e o vazamento era DENTRO da mesma empresa.
 *
 * 2. **Quem monta o texto fica sabendo o que o modelo pede.** `variaveis` é o
 *    que evita a tentativa no chute (`valores` recusado, tentar de novo).
 *
 * 3. **As variáveis do integrador entram validadas, e o que não serve é
 *    RECUSADO com o nome.** O render troca marcação sem valor por string vazia:
 *    um `valores` ignorado devolveria "Olá , tudo bem?" com `lacunas` vazio e a
 *    chamada marcada como bem-sucedida.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import type { McpContext } from "@/lib/mcp/types";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import {
  crmListMessageTemplates,
  crmRenderMessageTemplate,
} from "@/lib/mcp/tools/operacao";
import {
  VALOR_DE_VARIAVEL_MAX,
  listarModelosDeMensagem,
  preencherModeloDeMensagem,
} from "@/lib/operacao/modelos-de-mensagem";
import { ORG_ID, OUTRA_ORG, USER_ID, makeDb } from "@/tests/helpers/stages-db-double";

const COLEGA = "55555555-5555-4555-8555-555555555555";
const FONTE = "66666666-6666-4666-8666-666666666666";

const PESSOA: Actor = { type: "user", id: USER_ID, role: "agent" };
const TOKEN: Actor = { type: "api_token", id: "tok-1" };

function deps(db: ReturnType<typeof makeDb>, actor: Actor = TOKEN): DepsDaOperacao {
  return {
    supabase: db.client as unknown as SupabaseClient,
    organizationId: ORG_ID,
    actor,
    requestId: "req-1",
  };
}

function ctx(db: ReturnType<typeof makeDb>, actor: Actor = TOKEN): McpContext {
  return {
    organizationId: ORG_ID,
    role: "agent",
    actor,
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: db.client as unknown as SupabaseClient,
  };
}

/** A recusa como a operação a lança — código e frase, não só "deu erro". */
async function recusa(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("a operação NÃO recusou — era para ter lançado ApiError");
}

/** Os modelos da empresa: um compartilhado, um meu, um do colega. */
function comModelos(extra: Array<Record<string, unknown>> = []) {
  const db = makeDb();
  (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
    {
      id: "t-compartilhado",
      organization_id: ORG_ID,
      owner_user_id: null,
      title: "Política de troca",
      body: "A troca vale por {{dias}} dias.",
      shortcut: "troca",
      updated_at: "2026-09-20T10:00:00.000Z",
    },
    {
      id: "t-meu",
      organization_id: ORG_ID,
      owner_user_id: USER_ID,
      title: "Meu rascunho",
      body: "Oi {{nome}}",
      shortcut: null,
      updated_at: "2026-09-21T10:00:00.000Z",
    },
    {
      id: "t-do-colega",
      organization_id: ORG_ID,
      owner_user_id: COLEGA,
      title: "Rascunho do colega",
      body: "Anotação particular do colega",
      shortcut: null,
      updated_at: "2026-09-22T10:00:00.000Z",
    },
    {
      id: "t-outra-empresa",
      organization_id: OUTRA_ORG,
      owner_user_id: null,
      title: "De outra empresa",
      body: "nada",
      shortcut: null,
      updated_at: "2026-09-23T10:00:00.000Z",
    },
    ...extra,
  ];
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. quem vê o quê
// ---------------------------------------------------------------------------

describe("listar modelos de mensagem — a régua da policy, sob service-role", () => {
  it("⭐ token de integração NÃO vê o modelo pessoal de ninguém, nem com incluir_pessoais", async () => {
    // O token não é uma pessoa: `owner_user_id` de um token é o id do TOKEN, e
    // ele nunca casa com o dono de um rascunho. O que a lista devolve é o que a
    // empresa compartilhou — e nada do que cada atendente escreveu para si.
    const db = comModelos();

    const semPessoais = await listarModelosDeMensagem(deps(db));
    const pedindoPessoais = await listarModelosDeMensagem(deps(db), { incluirPessoais: true });

    expect(semPessoais.map((m) => m.id)).toEqual(["t-compartilhado"]);
    expect(pedindoPessoais.map((m) => m.id)).toEqual(["t-compartilhado"]);
  });

  it("nem a própria pessoa vê o pessoal sem pedir por ele", async () => {
    const db = comModelos();

    const lista = await listarModelosDeMensagem(deps(db, PESSOA));

    expect(lista.map((m) => m.id)).toEqual(["t-compartilhado"]);
    expect(lista[0]!.compartilhado).toBe(true);
  });

  it("com incluir_pessoais, a pessoa vê o próprio e continua sem ver o do colega", async () => {
    const db = comModelos();

    const lista = await listarModelosDeMensagem(deps(db, PESSOA), { incluirPessoais: true });

    expect(lista.map((m) => m.id).sort()).toEqual(["t-compartilhado", "t-meu"]);
    expect(lista.map((m) => m.id)).not.toContain("t-do-colega");
    expect(lista.map((m) => m.id)).not.toContain("t-outra-empresa");
  });

  it("⭐ o modelo pessoal de OUTRA empresa não entra nem para quem pediu o pessoal", async () => {
    // Duas coisas separadas de propósito: a organização é o corte de tenant, o
    // dono é o corte de pessoa. Um filtro só não cobre o outro.
    const db = comModelos([
      {
        id: "t-pessoal-de-outra-empresa",
        organization_id: OUTRA_ORG,
        owner_user_id: USER_ID,
        title: "Meu, noutra empresa",
        body: "nada",
        shortcut: null,
        updated_at: "2026-09-24T10:00:00.000Z",
      },
    ]);

    const lista = await listarModelosDeMensagem(deps(db, PESSOA), { incluirPessoais: true });

    expect(lista.map((m) => m.id)).not.toContain("t-pessoal-de-outra-empresa");
  });

  it("a lista informa as variáveis de cada modelo, sem repetir e na ordem do corpo", async () => {
    const db = comModelos([
      {
        id: "t-duas-vezes",
        organization_id: ORG_ID,
        owner_user_id: null,
        title: "Com duas marcações iguais",
        body: "Oi {{nome}}, sobre {{pedido_id}}: {{nome}}",
        shortcut: null,
        updated_at: "2026-09-25T10:00:00.000Z",
      },
    ]);

    const lista = await listarModelosDeMensagem(deps(db));
    const comVariaveis = lista.find((m) => m.id === "t-duas-vezes");

    expect(comVariaveis?.variaveis).toEqual(["nome", "pedido_id"]);
    // Modelo sem marcação nenhuma devolve lista vazia, não `undefined`.
    expect(lista.find((m) => m.id === "t-compartilhado")?.variaveis).toEqual(["dias"]);
  });
});

describe("preencher pelo id — a mesma régua de dono da lista", () => {
  // A lista fechada não basta: o id de um modelo pessoal alheio (os que a lista
  // devolvia antes deste conserto, por exemplo) abria o corpo pelo preenchimento.
  const AGENTE: Actor = { type: "ai_agent", id: "run-1", role: "agent" };

  it("⭐ token preenchendo o modelo pessoal do colega recebe 404, não o corpo", async () => {
    const db = comModelos();

    const err = await recusa(() =>
      crmRenderMessageTemplate.handler({ template_id: "t-do-colega" }, ctx(db)),
    );

    expect(err.status).toBe(404);
    expect(JSON.stringify(err)).not.toContain("Anotação particular");
  });

  it("token não preenche modelo pessoal de ninguém, nem o do usuário que o criou", async () => {
    const db = comModelos();

    expect((await recusa(() => preencherModeloDeMensagem(deps(db), { templateId: "t-meu" }))).status).toBe(404);
    expect(
      (await recusa(() => preencherModeloDeMensagem(deps(db, AGENTE), { templateId: "t-meu" }))).status,
    ).toBe(404);
  });

  it("a pessoa preenche o próprio modelo pessoal", async () => {
    const db = comModelos();

    const r = await preencherModeloDeMensagem(deps(db, PESSOA), { templateId: "t-meu" });

    expect(r.id).toBe("t-meu");
    expect(r.lacunas).toEqual(["nome"]);
  });

  it("⭐ a pessoa NÃO preenche o modelo pessoal do colega", async () => {
    const db = comModelos();

    const err = await recusa(() =>
      preencherModeloDeMensagem(deps(db, PESSOA), { templateId: "t-do-colega" }),
    );

    expect(err.status).toBe(404);
  });

  it("o compartilhado continua preenchível por token, agente e pessoa", async () => {
    const db = comModelos();

    for (const ator of [TOKEN, AGENTE, PESSOA]) {
      const r = await preencherModeloDeMensagem(deps(db, ator), {
        templateId: "t-compartilhado",
        valores: { dias: "7" },
      });
      expect(r.texto).toBe("A troca vale por 7 dias.");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. e 3. preencher: o que veio do contato, o que veio de fora, o que foi recusado
// ---------------------------------------------------------------------------

describe("preencher modelo com as variáveis do integrador", () => {
  function comModelo(corpo: string, contato?: Record<string, unknown>) {
    const db = makeDb();
    (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
      { id: "t1", organization_id: ORG_ID, owner_user_id: null, title: "Cobrança", body: corpo },
    ];
    (db.tabelas as unknown as Record<string, unknown[]>).contacts = contato ? [contato] : [];
    return db;
  }

  const CONTATO = {
    id: "c1",
    organization_id: ORG_ID,
    name: "Joana",
    phone_number: "+551****8888",
    email: null,
  };

  it("preenche a marcação do integrador junto com os dados do contato", async () => {
    const db = comModelo("Olá {{nome}}, pague em {{link_formulario}}", CONTATO);

    const r = await preencherModeloDeMensagem(deps(db), {
      templateId: "t1",
      contactId: "c1",
      valores: { link_formulario: "https://pagar.exemplo/abc" },
    });

    expect(r.texto).toBe("Olá Joana, pague em https://pagar.exemplo/abc");
    expect(r.lacunas).toEqual([]);
  });

  it("o que não veio em valores continua listado em lacunas", async () => {
    const db = comModelo("Olá {{nome}}, pague {{valor_aberto}} em {{link_formulario}}", CONTATO);

    const r = await preencherModeloDeMensagem(deps(db), {
      templateId: "t1",
      contactId: "c1",
      valores: { link_formulario: "https://pagar.exemplo/abc" },
    });

    expect(r.lacunas).toEqual(["valor_aberto"]);
  });

  it("⭐ variável que o modelo NÃO usa é recusada, com o nome dela e o que ele usa", async () => {
    // É o apelido trocado — `link_form` por `link_formulario`. Aceita em silêncio,
    // o render entregaria a frase com a marcação vazia e a chamada "bem-sucedida".
    const db = comModelo("Pague em {{link_formulario}}", CONTATO);

    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), {
        templateId: "t1",
        valores: { link_form: "https://pagar.exemplo/abc" },
      }),
    );

    expect(erro.status).toBe(422);
    expect(erro.message).toContain('"link_form"');
    expect(erro.message).toContain("link_formulario");
  });

  it("⭐ variável do contato é recusada, e a recusa aponta o caminho certo", async () => {
    // Aceitar `{ nome: "Joana" }` seria escrever por cima do contato — ou pior,
    // ser descartado em silêncio pelo alias quando o contato tem nome.
    const db = comModelo("Olá {{nome}}", CONTATO);

    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), {
        templateId: "t1",
        valores: { nome: "Joana" },
      }),
    );

    expect(erro.status).toBe(422);
    expect(erro.message).toContain('"nome"');
    expect(erro.message).toContain("contact_id");
  });

  it("chave fora do formato é recusada com o formato aceito", async () => {
    const db = comModelo("Pague em {{link_formulario}}");

    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), {
        templateId: "t1",
        valores: { "Link-Formulario": "https://pagar.exemplo/abc" },
      }),
    );

    expect(erro.status).toBe(422);
    expect(erro.message).toContain('"Link-Formulario"');
    expect(erro.message).toContain("letras minúsculas");
  });

  it("valor acima do teto é recusado, e a mensagem diz o teto", async () => {
    const db = comModelo("Pague em {{link_formulario}}");

    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), {
        templateId: "t1",
        valores: { link_formulario: "x".repeat(VALOR_DE_VARIAVEL_MAX + 1) },
      }),
    );

    expect(erro.status).toBe(422);
    expect(erro.message).toContain(String(VALOR_DE_VARIAVEL_MAX));
  });

  it("a recusa sai inteira numa rodada: as três classes de problema vêm juntas", async () => {
    const db = comModelo("Pague em {{link_formulario}}");

    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), {
        templateId: "t1",
        valores: { nome: "Joana", "Link-X": "y", link_form: "z" },
      }),
    );

    expect(erro.message).toContain('"nome"');
    expect(erro.message).toContain('"Link-X"');
    expect(erro.message).toContain('"link_form"');
  });

  it("modelo sem variável nenhuma recusa qualquer valor, sem citar uma lista vazia", async () => {
    const db = comModelo("Bom dia!");

    const erro = await recusa(() =>
      preencherModeloDeMensagem(deps(db), { templateId: "t1", valores: { oi: "x" } }),
    );

    expect(erro.message).toContain("não usa nenhuma variável");
  });
});

// ---------------------------------------------------------------------------
// a ferramenta da integração — a costura, não a regra
// ---------------------------------------------------------------------------

describe("a ferramenta da integração", () => {
  it("⭐ crm_list_message_templates com token e incluir_pessoais devolve só o compartilhado", async () => {
    const db = comModelos();

    const resposta = (await crmListMessageTemplates.handler(
      { incluir_pessoais: true },
      ctx(db),
    )) as { modelos: Array<{ id: string; variaveis: string[] }> };

    expect(resposta.modelos.map((m) => m.id)).toEqual(["t-compartilhado"]);
    expect(resposta.modelos[0]!.variaveis).toEqual(["dias"]);
  });

  it("crm_render_message_template leva `valores` até o render", async () => {
    const db = makeDb();
    (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
      {
        id: FONTE,
        organization_id: ORG_ID,
        owner_user_id: null,
        title: "Cobrança",
        body: "Pague em {{link_formulario}}",
      },
    ];

    const r = (await crmRenderMessageTemplate.handler(
      { template_id: FONTE, valores: { link_formulario: "https://pagar.exemplo/abc" } },
      ctx(db),
    )) as { texto: string; lacunas: string[] };

    expect(r.texto).toBe("Pague em https://pagar.exemplo/abc");
    expect(r.lacunas).toEqual([]);
  });

  it("o audit recebe os NOMES das variáveis, nunca os valores", async () => {
    // `api_audit_log.metadata` guarda os argumentos da chamada: o valor de uma
    // variável é conteúdo do cliente (link com token, número, protocolo), e log
    // é lugar de metadado.
    const redigido = crmRenderMessageTemplate.redigirParaAuditoria?.({
      template_id: FONTE,
      valores: { link_formulario: "https://pagar.exemplo/abc", protocolo: "8817" },
    });

    expect(redigido).toEqual({ template_id: FONTE, valores: ["link_formulario", "protocolo"] });
    expect(JSON.stringify(redigido)).not.toContain("pagar.exemplo");
  });

  it("sem `valores`, o audit não ganha campo novo", async () => {
    const redigido = crmRenderMessageTemplate.redigirParaAuditoria?.({ template_id: FONTE });

    expect(redigido).toEqual({ template_id: FONTE });
  });
});

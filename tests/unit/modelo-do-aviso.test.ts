/**
 * O MODELO APROVADO QUE LEVA O AVISO À EQUIPE (migration 9094) — a regra única.
 *
 * Três perguntas, e cada uma tem um modo de falha próprio:
 *
 *  - **o texto numa linha só** (`umaLinhaParaOModelo`): a plataforma recusa
 *    valor de variável com quebra de linha, tabulação ou mais de quatro espaços
 *    (erro 132018). O aviso de caso tem várias linhas — sem a conversão, todo
 *    aviso por modelo voltaria recusado. E o link não pode ser cortado: é o que
 *    leva a equipe ao caso;
 *  - **qual modelo serve** (`avaliarModeloDoAviso`): aprovado e com UMA variável
 *    de texto no corpo. Com duas, não há como repartir o aviso; com variável no
 *    cabeçalho ou no botão, ninguém teria o que pôr nela;
 *  - **o modelo é desta conexão** (`carregarModeloDoAviso`): o id aponta uma
 *    linha, mas quem vale é a definição da conexão — a de outra organização ou
 *    de outro número é recusa certa na plataforma.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  TETO_DO_VALOR_DO_MODELO,
  avaliarModeloDoAviso,
  carregarModeloDoAviso,
  modelosDoAvisoDaConexao,
  umaLinhaParaOModelo,
  type LinhaDoModelo,
} from "@/lib/escalacao/modelo-do-aviso";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CANAL = "22222222-2222-4222-8222-222222222222";
const OUTRO_CANAL = "33333333-3333-4333-8333-333333333333";

const CORPO_UMA = "🔔 Aviso do CRM\n\n{{1}}\n\nAbra o CRM para ver o detalhe.";

function linha(over: Partial<LinhaDoModelo> = {}): LinhaDoModelo {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "aviso_da_equipe",
    language: "pt_BR",
    status: "APPROVED",
    components: [{ type: "BODY", text: CORPO_UMA }],
    parameter_format: "POSITIONAL",
    ...over,
  };
}

describe("umaLinhaParaOModelo — o aviso cabe numa variável", () => {
  it("cada linha vira um trecho, sem quebra, tabulação nem espaço em série", () => {
    const saida = umaLinhaParaOModelo(
      "Resumo do lead para a equipe\nRegra: Formulário\n\nCliente:\tMaria\nTelefone:      +5531900000000",
    );
    expect(saida).toBe(
      "Resumo do lead para a equipe · Regra: Formulário · Cliente: Maria · Telefone: +5531900000000",
    );
    // As três recusas da plataforma, medidas na saída e não no código.
    expect(saida).not.toMatch(/[\n\r\t]/);
    expect(saida).not.toMatch(/ {5,}/);
  });

  it("texto que já cabe sai inteiro", () => {
    expect(umaLinhaParaOModelo("Lead novo")).toBe("Lead novo");
  });

  it("texto longo respeita o teto e o LINK sai inteiro, no fim", () => {
    const link = "https://crm.exemplo.com.br/app/leads/55555555-5555-4555-8555-555555555555";
    const texto = `${"Detalhe comprido do caso. ".repeat(60)}\nOutra linha\nAbrir negócio: ${link}`;
    const saida = umaLinhaParaOModelo(texto);
    expect(saida.length).toBeLessThanOrEqual(TETO_DO_VALOR_DO_MODELO);
    expect(saida.endsWith(`Abrir negócio: ${link}`)).toBe(true);
    expect(saida).toContain("…");
  });

  it("um teto apertado nunca devolve mais que o teto", () => {
    const saida = umaLinhaParaOModelo("primeira linha bem longa\nsegunda\nterceira", 20);
    expect(saida.length).toBeLessThanOrEqual(20);
  });
});

describe("avaliarModeloDoAviso — qual modelo serve", () => {
  it("aprovado, com uma variável no corpo: serve, e a chave é a da variável", () => {
    const r = avaliarModeloDoAviso(linha());
    expect(r).toEqual({
      ok: true,
      modelo: expect.objectContaining({ name: "aviso_da_equipe", language: "pt_BR", chave: "1", corpo: CORPO_UMA }),
    });
  });

  it("no formato nomeado, a chave é o NOME da variável", () => {
    const r = avaliarModeloDoAviso(
      linha({ parameter_format: "NAMED", components: [{ type: "BODY", text: "Aviso: {{texto}} — fim" }] }),
    );
    expect(r.ok && r.modelo.chave).toBe("texto");
  });

  it("em revisão, recusado ou pausado: não serve", () => {
    for (const status of ["PENDING", "REJECTED", "PAUSED", "DISABLED"]) {
      expect(avaliarModeloDoAviso(linha({ status })), status).toEqual({ ok: false, motivo: "nao_aprovado" });
    }
  });

  it("duas variáveis, nenhuma, ou variável fora do corpo: não serve", () => {
    const casos: Array<[string, unknown]> = [
      ["duas no corpo", [{ type: "BODY", text: "Oi {{1}}, aviso: {{2}}." }]],
      ["nenhuma", [{ type: "BODY", text: "Tem aviso novo no CRM." }]],
      [
        "uma no cabeçalho e uma no corpo",
        [
          { type: "HEADER", format: "TEXT", text: "Aviso {{1}}" },
          { type: "BODY", text: "Detalhe: {{1}}." },
        ],
      ],
      [
        "uma no corpo e uma no botão",
        [
          { type: "BODY", text: "Detalhe: {{1}}." },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Abrir", url: "https://crm.exemplo.com.br/{{1}}" }] },
        ],
      ],
    ];
    for (const [nome, components] of casos) {
      expect(avaliarModeloDoAviso(linha({ components })), nome).toEqual({ ok: false, motivo: "variaveis" });
    }
  });

  it("botão de resposta rápida, sem variável, não atrapalha", () => {
    const r = avaliarModeloDoAviso(
      linha({
        components: [
          { type: "BODY", text: CORPO_UMA },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Vi" }] },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

/** Um PostgREST em memória: `eq` e `is` filtram, `maybeSingle` e `then` respondem. */
function dbFake(tabelas: Record<string, Array<Record<string, unknown>>>): SupabaseClient {
  function builder(nome: string) {
    const filtros: Array<(l: Record<string, unknown>) => boolean> = [];
    const linhas = () => (tabelas[nome] ?? []).filter((l) => filtros.every((f) => f(l)));
    const q = {
      select: () => q,
      order: () => q,
      eq: (col: string, val: unknown) => {
        filtros.push((l) => l[col] === val);
        return q;
      },
      is: (col: string, val: unknown) => {
        filtros.push((l) => (l[col] ?? null) === val);
        return q;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(resolve),
    };
    return q;
  }
  return { from: (nome: string) => builder(nome) } as unknown as SupabaseClient;
}

const MODELO_DA_CONEXAO = { ...linha(), organization_id: ORG, channel_session_id: CANAL, waba_id: "conta-1" };

describe("carregarModeloDoAviso — o modelo é desta organização e desta conexão", () => {
  const tabelas = {
    meta_templates: [
      MODELO_DA_CONEXAO,
      {
        ...linha({ id: "55555555-5555-4555-8555-555555555555", name: "de_outro_numero" }),
        organization_id: ORG,
        channel_session_id: OUTRO_CANAL,
        waba_id: "conta-2",
      },
      {
        ...linha({ id: "66666666-6666-4666-8666-666666666666", name: "de_outra_org" }),
        organization_id: OUTRA_ORG,
        channel_session_id: CANAL,
        waba_id: "conta-1",
      },
      {
        ...linha({ id: "77777777-7777-4777-8777-777777777777", name: "em_revisao", status: "PENDING" }),
        organization_id: ORG,
        channel_session_id: CANAL,
        waba_id: "conta-1",
      },
    ],
    channel_sessions: [
      { id: CANAL, organization_id: ORG, provider: "outro", meta_waba_id: null },
      { id: OUTRO_CANAL, organization_id: ORG, provider: "outro", meta_waba_id: null },
    ],
  };
  const db = dbFake(tabelas);
  const carrega = (modeloId: string) =>
    carregarModeloDoAviso(db, { organizationId: ORG, channelSessionId: CANAL, modeloId });

  it("o modelo aprovado da conexão serve", async () => {
    const r = await carrega(MODELO_DA_CONEXAO.id);
    expect(r.ok && r.modelo.name).toBe("aviso_da_equipe");
  });

  it("o de OUTRO número da mesma organização é recusado", async () => {
    expect(await carrega("55555555-5555-4555-8555-555555555555")).toEqual({ ok: false, motivo: "outra_conexao" });
  });

  it("o de OUTRA organização nem é achado — o filtro de organização vem antes do id", async () => {
    expect(await carrega("66666666-6666-4666-8666-666666666666")).toEqual({ ok: false, motivo: "inexistente" });
  });

  it("o que ainda está em revisão é recusado", async () => {
    expect(await carrega("77777777-7777-4777-8777-777777777777")).toEqual({ ok: false, motivo: "nao_aprovado" });
  });

  it("a tela só oferece o que serve, e só desta conexão", async () => {
    const oferecidos = await modelosDoAvisoDaConexao(db, ORG, CANAL);
    expect(oferecidos.map((m) => m.nome)).toEqual(["aviso_da_equipe"]);
    expect(oferecidos[0]).toEqual({ id: MODELO_DA_CONEXAO.id, nome: "aviso_da_equipe", idioma: "pt_BR", corpo: CORPO_UMA });
  });
});

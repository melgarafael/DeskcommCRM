/**
 * A CASCATA INTERROMPIDA SE COMPLETA SOZINHA — issue #310, o segundo tempo.
 *
 * ─── O que a rota, sozinha, não resolvia ────────────────────────────────────
 *
 * `POST /api/v1/lgpd/anonymize` aprendeu a retomar uma cascata que parou no
 * meio. Só que a retomada era INALCANÇÁVEL: `app/app/contacts/[id]/_client.tsx`
 * troca o botão "Anonimizar contato" por um parágrafo quando `is_anonymized` é
 * verdadeiro, e `setAnonOpen(true)` é o ÚNICO caminho para o diálogo em todo o
 * repositório. No estado exato que a correção conserta — contato marcado como
 * anonimizado, leads e atividades ainda com PII — **não existe botão**.
 *
 * E o remédio não podia ser "põe um botão de volta": a LGPD dá PRAZO (redact em
 * D+15), e um direito do titular não deveria depender de alguém lembrar de
 * clicar num contato específico, um a um, sabendo quais procurar.
 *
 * Quem conserta é o varredor diário de retenção. Este arquivo mede as duas
 * propriedades que o tornam seguro rodar todo dia, para sempre:
 *
 *   1. ele COMPLETA o que faltou (senão o resíduo é permanente);
 *   2. ele é IDEMPOTENTE — a segunda passada não escreve nada. Sem isso o
 *      remédio seria pior que a doença: o passo 2 corta o título em 20
 *      caracteres antes do sufixo, então reescrever comeria um pedaço por dia
 *      até não sobrar título; e o passo 3, que reescrevia todas as atividades
 *      incondicionalmente, gravaria para sempre sobre dado já correto, com a
 *      auditoria registrando "efeito" em toda rodada.
 *
 * A régua é a REGRA (o laço, a guarda do sufixo, o filtro de organização). O que
 * o Postgres de fato aceita está fora daqui, como em `retencao-poda-em-lotes`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CONTATOS_EXAMINADOS,
  MAX_CONTATOS_POR_VARREDURA,
  MENSAGEM_REDIGIDA,
  NOTA_REDIGIDA,
  SUFIXO_ANONIMIZADO,
  type ClienteDaCascata,
  completarRedacaoDoContato,
  houveRedacao,
  varrerRedacoesIncompletas,
} from "@/lib/lgpd/cascata";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

/** O banco que o handler do cron enxerga nesta rodada. */
let bancoDoCron: { cliente: ClienteDaCascata } | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const cascata = bancoDoCron?.cliente as unknown as { from: (t: string) => unknown };
    // A DÉCIMA poda (issue #1686) também chama `from`, e pela MESMA regra do
    // `rpc` logo acima: o que este arquivo mede é a varredura, e o poda não
    // pode cair junto quando a cascata explode — é exatamente a asserção do
    // caso ⭐ lá embaixo. Por isso `conversation_drafts` tem superfície própria
    // aqui, sem passar por `bancoDoCron.cliente` (a que o caso faz explodir).
    const rascunhosVazios = () => {
      const q: Record<string, unknown> = {
        lt: () => q,
        select: () => q,
        order: () => q,
        limit: () => q,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return { delete: () => q };
    };
    return {
      // Poda sem nada a fazer: o que este arquivo mede é a varredura.
      rpc: async () => ({ data: 0, error: null }),
      from: (t: string) => (t === "conversation_drafts" ? rascunhosVazios() : cascata.from(t)),
    };
  },
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const CONTATO = "33333333-3333-4333-8333-333333333333";

interface Linha {
  id: string;
  organization_id: string;
  contact_id?: string | null;
  title?: string | null;
  payload?: unknown;
  is_anonymized?: boolean;
  headline?: string;
  body?: string | null;
  tool_calls?: unknown;
  social_identity?: unknown;
  next_action?: string | null;
  qualification?: unknown;
  status?: string | null;
  next_eval_at?: string | null;
  claimed_until?: string | null;
  completed_at?: string | null;
  cancel_reason?: string | null;
  embedding?: unknown;
  media_derived_text?: string | null;
}

interface Escrita {
  tabela: string;
  patch: Record<string, unknown>;
  alvos: string[];
}

/**
 * Um PostgREST de mentira com linhas de VERDADE, e que APLICA o UPDATE.
 *
 * Aplicar importa: sem isso, "rodar duas vezes não escreve na segunda" passaria
 * por vacuidade — a segunda passada leria o mesmo estado sujo da primeira e o
 * teste não distinguiria idempotência de dublê amnésico. É exatamente o modo de
 * falha que a guarda do sufixo existe para impedir.
 */
function banco(linhas: Linha[]) {
  const escritas: Escrita[] = [];

  const aplicar = (tabela: string, patch: Record<string, unknown>, alvos: Linha[]) => {
    escritas.push({ tabela, patch, alvos: alvos.map((l) => l.id) });
    for (const l of alvos) Object.assign(l, patch);
  };

  const cliente = {
    from(tabela: string) {
      const casar = (
        filtros: Array<[string, unknown]>,
        dentro: [string, string[]] | null,
        faixas: Array<[string, string]> = [],
        naoNulos: string[] = [],
      ): Linha[] =>
        linhas.filter((l) => {
          if ((l.id.split(":")[0] ?? "") !== tabela) return false;
          for (const [col, val] of filtros) {
            if ((l as unknown as Record<string, unknown>)[col] !== val) return false;
          }
          // `.lt()` da DÉCIMA poda (issue #1686): o corte do rascunho vencido.
          // `expires_at` é ISO-8601, e em ISO o lexical É o cronológico.
          for (const [col, val] of faixas) {
            const atual = (l as unknown as Record<string, string | undefined>)[col];
            if (atual === undefined || !(atual < val)) return false;
          }
          // `.not(col, "is", null)` do passo da transcrição (0497). Ignorá-lo
          // faria a mensagem já limpa voltar como resíduo e mascararia a idempotência.
          for (const col of naoNulos) {
            const atual = (l as unknown as Record<string, unknown>)[col];
            if (atual === null || atual === undefined) return false;
          }
          // O `.in()` da cascata vem em DUAS colunas — `id` no UPDATE das
          // atividades, `contact_id` na detecção em bloco. Um dublê que
          // ignorasse a coluna casaria as duas na errada e daria verde falso.
          if (dentro) {
            const [col, vals] = dentro;
            const valor = (l as unknown as Record<string, string | undefined>)[col];
            if (valor === undefined || !vals.includes(valor)) return false;
          }
          return true;
        });

      const construir = (
        modo: "select" | "update" | "delete",
        patch: Record<string, unknown>,
      ) => {
        const filtros: Array<[string, unknown]> = [];
        const faixas: Array<[string, string]> = [];
        const naoNulos: string[] = [];
        let dentro: [string, string[]] | null = null;
        let teto: number | null = null;
        const q: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            filtros.push([col, val]);
            return q;
          },
          lt: (col: string, val: string) => {
            faixas.push([col, val]);
            return q;
          },
          in: (col: string, vals: string[]) => {
            dentro = [col, vals];
            return q;
          },
          not: (col: string) => {
            naoNulos.push(col);
            return q;
          },
          select: () => q,
          order: () => q,
          limit: (n: number) => {
            teto = n;
            return q;
          },
          then: (r: (v: unknown) => unknown) => {
            let achadas = casar(filtros, dentro, faixas, naoNulos);
            if (teto !== null) achadas = achadas.slice(0, teto);
            if (modo === "update") {
              aplicar(tabela, patch, achadas);
              return Promise.resolve({ error: null }).then(r);
            }
            if (modo === "delete") {
              // A décima poda apaga MESMO: sem remover da lista, "rodar duas
              // vezes" mediria dublê amnésico em vez de idempotência — a
              // segunda passada devolveria as mesmas linhas.
              for (const alvo of achadas) {
                const i = linhas.indexOf(alvo);
                if (i >= 0) linhas.splice(i, 1);
              }
              return Promise.resolve({ data: achadas, error: null }).then(r);
            }
            return Promise.resolve({ data: achadas, error: null }).then(r);
          },
        };
        return q;
      };

      return {
        select: () => construir("select", {}),
        update: (patch: Record<string, unknown>) => construir("update", patch),
        delete: () => construir("delete", {}),
      };
    },
  } as unknown as ClienteDaCascata;

  return { cliente, escritas, linhas };
}

/** `id` carrega a tabela porque o dublê guarda tudo numa lista só. */
function contatoAnonimizado(sufixo = "a", org = ORG): Linha {
  return { id: `contacts:${sufixo}`, organization_id: org, is_anonymized: true };
}

let alvo: ReturnType<typeof banco>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("varredura: a retomada acontece sem ninguém clicar", () => {
  it("⭐ contato anonimizado com lead e atividade pendentes: a varredura completa os dois", async () => {
    alvo = banco([
      contatoAnonimizado(),
      {
        id: "crm_leads:1",
        organization_id: ORG,
        contact_id: "contacts:a",
        title: "Orçamento de telhado para a casa",
      },
      { id: "crm_lead_activities:1", organization_id: ORG, contact_id: "contacts:a", payload: { texto: "PII" } },
    ]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.examinados).toBe(1);
    expect(r.completados).toHaveLength(1);
    expect(r.completados[0]!.contactId).toBe("contacts:a");
    expect(r.completados[0]!.organizationId).toBe(ORG);
    expect(r.completados[0]!.resultado.leadsRedigidas).toEqual(["crm_leads:1"]);
    expect(r.completados[0]!.resultado.atividadesRedigidas).toBe(1);
    // O estado FINAL, não só a intenção.
    expect(alvo.linhas.find((l) => l.id === "crm_leads:1")!.title).toBe(
      `Orçamento de telhado${SUFIXO_ANONIMIZADO}`,
    );
    expect(alvo.linhas.find((l) => l.id === "crm_lead_activities:1")!.payload).toEqual({
      redacted: true,
    });
  });

  it("⭐ rodar a varredura duas vezes não escreve nada na segunda", async () => {
    alvo = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:a", title: "Orçamento de telhado para a casa" },
      { id: "crm_lead_activities:1", organization_id: ORG, contact_id: "contacts:a", payload: { texto: "PII" } },
    ]);

    await varrerRedacoesIncompletas(alvo.cliente);
    const tituloDepoisDaPrimeira = alvo.linhas.find((l) => l.id === "crm_leads:1")!.title;
    const escritasDaPrimeira = alvo.escritas.length;

    const segunda = await varrerRedacoesIncompletas(alvo.cliente);

    expect(segunda.completados, "a segunda passada achou trabalho onde não havia").toEqual([]);
    expect(
      alvo.escritas.length,
      "a segunda passada escreveu — num cron diário isso come o título um pedaço por dia",
    ).toBe(escritasDaPrimeira);
    expect(alvo.linhas.find((l) => l.id === "crm_leads:1")!.title).toBe(tituloDepoisDaPrimeira);
    // A prova de que a idempotência é do CÓDIGO e não do dublê: o título não
    // ganhou um segundo sufixo.
    expect(
      (tituloDepoisDaPrimeira ?? "").match(/\(anonimizado\)/g),
      "o sufixo entrou duas vezes",
    ).toHaveLength(1);
  });

  it("contato NÃO anonimizado passa intocado — a varredura não anonimiza ninguém", async () => {
    alvo = banco([
      { id: "contacts:vivo", organization_id: ORG, is_anonymized: false },
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:vivo", title: "Orçamento vivo" },
    ]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.examinados).toBe(0);
    expect(alvo.escritas, "a varredura redigiu um contato que ninguém pediu para anonimizar").toEqual([]);
    expect(alvo.linhas.find((l) => l.id === "crm_leads:1")!.title).toBe("Orçamento vivo");
  });

  it("⭐ a lead de OUTRA organização não é tocada (o cron roda com service role, sem RLS)", async () => {
    alvo = banco([
      contatoAnonimizado(),
      { id: "crm_leads:minha", organization_id: ORG, contact_id: "contacts:a", title: "Minha lead" },
      // Mesmo `contact_id`, outra org: só um vazamento de tenant produz isto, e
      // é justamente o que a RLS impediria se ela valesse aqui — ela não vale.
      { id: "crm_leads:alheia", organization_id: OUTRA_ORG, contact_id: "contacts:a", title: "Lead alheia" },
    ]);

    await varrerRedacoesIncompletas(alvo.cliente);

    expect(alvo.linhas.find((l) => l.id === "crm_leads:alheia")!.title).toBe("Lead alheia");
    expect(alvo.linhas.find((l) => l.id === "crm_leads:minha")!.title).toContain(SUFIXO_ANONIMIZADO);
  });

  it("⭐ o teto limita o CONSERTO, não a leitura — e o resto é alcançado na rodada seguinte", async () => {
    // A versão anterior tinha um teto só, aplicado como `limit` na consulta de
    // contatos: toda rodada examinava os MESMOS primeiros N. Uma vez limpos,
    // o cron rodava para sempre sem NUNCA alcançar o contato N+1 — starvation
    // silenciosa, num prazo legal, com a trilha dizendo que tudo correu bem.
    const linhas: Linha[] = [];
    for (let i = 0; i < 5; i += 1) {
      linhas.push(contatoAnonimizado(String(i)));
      linhas.push({
        id: `crm_leads:${i}`,
        organization_id: ORG,
        contact_id: `contacts:${i}`,
        title: `Negócio ${i} com PII`,
      });
    }
    alvo = banco(linhas);

    const primeira = await varrerRedacoesIncompletas(alvo.cliente, 2);

    // Examinou TODOS, consertou o teto, e disse que sobrou.
    expect(primeira.examinados).toBe(5);
    expect(primeira.comResiduo).toBe(5);
    expect(primeira.completados).toHaveLength(2);
    // Silêncio aqui seria indistinguível de "acabou" — o mesmo erro que o laço
    // de lotes da poda evita com `temResto`.
    expect(primeira.temResto).toBe(true);

    // ⭐ A propriedade que a starvation quebrava: as rodadas seguintes AVANÇAM.
    const vistos = new Set(primeira.completados.map((c) => c.contactId));
    for (let rodada = 0; rodada < 3; rodada += 1) {
      const r = await varrerRedacoesIncompletas(alvo.cliente, 2);
      for (const c of r.completados) vistos.add(c.contactId);
    }
    expect(
      vistos.size,
      "o cron nunca alcançou os contatos além do teto — resíduo pendente para sempre",
    ).toBe(5);
    expect(alvo.linhas.filter((l) => l.title?.endsWith(SUFIXO_ANONIMIZADO))).toHaveLength(5);

    const ultima = await varrerRedacoesIncompletas(alvo.cliente, 2);
    expect(ultima.comResiduo, "sobrou resíduo depois de tudo consertado").toBe(0);
    expect(ultima.temResto).toBe(false);
    expect(MAX_CONTATOS_POR_VARREDURA).toBeGreaterThan(0);
  });

  it("erro no SELECT não vira varredura vazia silenciosa", async () => {
    const cliente = {
      from: () => ({
        select: () => ({
          eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "sem permissão" } }) }),
        }),
      }),
    } as unknown as ClienteDaCascata;
    expect(MAX_CONTATOS_EXAMINADOS).toBeGreaterThan(MAX_CONTATOS_POR_VARREDURA);

    const r = await varrerRedacoesIncompletas(cliente);

    expect(r.completados).toEqual([]);
    expect(r.falhas.join(" "), "a falha sumiu — 'nada a fazer' e 'não consegui olhar' viraram a mesma coisa").toContain(
      "sem permissão",
    );
  });
});

describe("a unidade que as duas bocas compartilham", () => {
  it("houveRedacao distingue trabalho feito de nada a fazer", () => {
    const vazio: Parameters<typeof houveRedacao>[0] = {
      leadsRedigidas: [],
      atividadesRedigidas: 0,
      memoriasRedigidas: 0,
      runsRedigidas: 0,
      estadosRedigidos: 0,
      socialIdentidadeRedigida: false,
      transcricoesRedigidas: 0,
      tabelas: [],
      falhas: [],
    };
    expect(houveRedacao(vazio)).toBe(false);
    expect(houveRedacao({ ...vazio, leadsRedigidas: ["x"] })).toBe(true);
    expect(houveRedacao({ ...vazio, atividadesRedigidas: 1 })).toBe(true);
    expect(houveRedacao({ ...vazio, memoriasRedigidas: 1 })).toBe(true);
    expect(houveRedacao({ ...vazio, runsRedigidas: 1 })).toBe(true);
    expect(houveRedacao({ ...vazio, estadosRedigidos: 1 })).toBe(true);
    expect(houveRedacao({ ...vazio, socialIdentidadeRedigida: true })).toBe(true);
    expect(houveRedacao({ ...vazio, transcricoesRedigidas: 1 })).toBe(true);
  });

  it("⭐ `tabelas` lista só o que foi tocado — não o literal das três", async () => {
    alvo = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:a", title: `Já feita${SUFIXO_ANONIMIZADO}` },
      { id: "crm_lead_activities:1", organization_id: ORG, contact_id: "contacts:a", payload: { redacted: true } },
    ]);

    const r = await completarRedacaoDoContato(alvo.cliente, { id: "contacts:a", organizationId: ORG });

    expect(r.tabelas, "afirmou ter redigido tabelas que não tocou").toEqual([]);
    expect(alvo.escritas).toEqual([]);
  });

  it("⭐ o legado da IA é redigido junto com leads/atividades (#1957)", async () => {
    // A cascata fechava a ficha do contato mas deixava a MEMÓRIA do agente, os
    // ARGUMENTOS das ferramentas, o ESTADO da lead e a IDENTIDADE SOCIAL com PII.
    // Aqui os quatro entram de uma vez, com um contato sem resíduo de lead para
    // provar que a varredura atinge essas fontes mesmo quando o resto já estava.
    alvo = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:a", title: `Ok${SUFIXO_ANONIMIZADO}` },
      { id: "crm_lead_activities:1", organization_id: ORG, contact_id: "contacts:a", payload: { redacted: true } },
      { id: "lead_notes:1", organization_id: ORG, contact_id: "contacts:a", headline: "Lembrete: maria pediu orçamento", body: "Falou com o João sobre o telhado" },
      { id: "ai_agent_runs:1", organization_id: ORG, contact_id: "contacts:a", tool_calls: [{ tool_name: "crm_buscar_contato", args: { termo: "Maria Souza" } }] },
      { id: "lead_state:1", organization_id: ORG, contact_id: "contacts:a", next_action: "Ligar para Maria", qualification: { nome: "Maria" } },
    ]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.completados).toHaveLength(1);
    const resultado = r.completados[0]!.resultado;
    expect(resultado.memoriasRedigidas).toBe(1);
    expect(resultado.runsRedigidas).toBe(1);
    expect(resultado.estadosRedigidos).toBe(1);
    // O contato não declarou social_identity, então não é tocado por essa fonte.
    expect(resultado.socialIdentidadeRedigida).toBe(false);

    // Estado FINAL, não só a intenção — nada das quatro fontes guarda PII.
    expect(alvo.linhas.find((l) => l.id === "lead_notes:1")!.headline).toBe(NOTA_REDIGIDA);
    expect(alvo.linhas.find((l) => l.id === "lead_notes:1")!.body).toBe(NOTA_REDIGIDA);
    expect(alvo.linhas.find((l) => l.id === "ai_agent_runs:1")!.tool_calls).toEqual([
      { tool_name: "crm_buscar_contato", redacted: true, tool_calls: [] },
    ]);
    expect(alvo.linhas.find((l) => l.id === "lead_state:1")!.next_action).toBeNull();
    expect(alvo.linhas.find((l) => l.id === "lead_state:1")!.qualification).toEqual({});
  });

  it("⭐ contato com apenas identidade social residual é alcançado (#1957)", async () => {
    // Um contato cuja ÚNICA coisa pendente é o `social_identity` não deve
    // escapar: depois do pedido, a identidade social precisa sumir também.
    alvo = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:a", title: `Ok${SUFIXO_ANONIMIZADO}` },
      { id: "crm_lead_activities:1", organization_id: ORG, contact_id: "contacts:a", payload: { redacted: true } },
      { id: "contacts:a", organization_id: ORG, is_anonymized: true, social_identity: { instagram: "@maria" } },
    ]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.completados).toHaveLength(1);
    expect(r.completados[0]!.resultado.socialIdentidadeRedigida).toBe(true);
    // Depois do pedido, NENHUMA linha do contato retém identidade social.
    for (const linha of alvo.linhas.filter((l) => l.id === "contacts:a")) {
      expect(linha.social_identity).toBeNull();
    }
  });

  it("⭐ a segunda passada não redige as fontes novas mais de uma vez (#1957)", async () => {
    alvo = banco([
      contatoAnonimizado(),
      { id: "lead_notes:1", organization_id: ORG, contact_id: "contacts:a", headline: "nome", body: "telefone" },
      { id: "ai_agent_runs:1", organization_id: ORG, contact_id: "contacts:a", tool_calls: [{ tool_name: "x", args: { a: 1 } }] },
      { id: "lead_state:1", organization_id: ORG, contact_id: "contacts:a", next_action: "ação", qualification: { q: 1 } },
    ]);

    await varrerRedacoesIncompletas(alvo.cliente);
    const escritasDaPrimeira = alvo.escritas.length;

    const segunda = await varrerRedacoesIncompletas(alvo.cliente);

    expect(segunda.completados, "a segunda passada redigiu de novo o que já estava redigido").toEqual([]);
    expect(alvo.escritas.length, "rescreveu as fontes novas na segunda passada").toBe(escritasDaPrimeira);
  });

  it("⭐ tool_calls redigido guarda QUAIS ferramentas rodaram e apaga o que a pessoa disse (#1957)", async () => {
    // A forma real (lib/ai/runtime/serialize.ts): passos com o texto do modelo e
    // chamadas com argumentos e resultado. Apagar tudo apagaria também a trilha
    // de quais ferramentas o agente usou — que não identifica ninguém.
    alvo = banco([
      contatoAnonimizado(),
      {
        id: "ai_agent_runs:1",
        organization_id: ORG,
        contact_id: "contacts:a",
        tool_calls: [
          {
            step: 0,
            text: "Oi Maria, vou buscar seu pedido",
            finish_reason: "tool-calls",
            tokens_in: 10,
            tokens_out: 5,
            tool_calls: [
              { tool_name: "crm_buscar_contato", args: { termo: "Maria Souza" }, result: { telefone: "5511999999999" } },
            ],
          },
          { step: 1, text: "Pronto, Maria", tool_calls: [] },
        ],
      },
    ]);

    await varrerRedacoesIncompletas(alvo.cliente);

    const run = alvo.linhas.find((l) => l.id === "ai_agent_runs:1")!;
    expect(run.tool_calls).toEqual([
      { step: 0, redacted: true, tool_calls: [{ tool_name: "crm_buscar_contato" }] },
      { step: 1, redacted: true, tool_calls: [] },
    ]);
    expect(JSON.stringify(run.tool_calls), "sobrou texto da pessoa no registro da run").not.toMatch(/Maria|5511/);
  });

  it("⭐ run com tool_calls vazio de nascença não é reescrita (#1957)", async () => {
    // `ai_agent_runs.tool_calls` é `not null default '[]'`: uma run que nunca
    // chamou ferramenta nasce com `[]`. O marcador de redação NÃO é o vácuo
    // (senão reescreveria para sempre), é o array-sentinela — aqui provamos
    // que o `[]` legítimo passa intocado.
    alvo = banco([
      contatoAnonimizado(),
      { id: "lead_notes:1", organization_id: ORG, contact_id: "contacts:a", headline: "x", body: "y" },
      { id: "ai_agent_runs:1", organization_id: ORG, contact_id: "contacts:a", tool_calls: [] },
    ]);

    await varrerRedacoesIncompletas(alvo.cliente);
    const run = alvo.linhas.find((l) => l.id === "ai_agent_runs:1")!;
    expect(run.tool_calls, "reescreveu uma run que nunca teve argumentos").toEqual([]);
  });
});

describe("a transcrição da mídia sai junto (0497, triagem do #1988)", () => {
  // O banco redige o body da mensagem na virada de is_anonymized; a transcrição
  // (`media_derived_text`) ficava. A varredura é quem alcança a que o
  // `media-derive-worker` grava DEPOIS da anonimização — nenhum gatilho dispara ali.
  const audio = (sufixo: string, over: Partial<Linha> = {}): Linha => ({
    id: `messages:${sufixo}`,
    organization_id: ORG,
    contact_id: "contacts:a",
    body: MENSAGEM_REDIGIDA,
    media_derived_text: "oi, aqui é a Maria, meu CPF é 123",
    ...over,
  });

  it("⭐ mensagem anonimizada que guardou a transcrição: a varredura apaga", async () => {
    alvo = banco([contatoAnonimizado(), audio("1")]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.completados).toHaveLength(1);
    expect(r.completados[0]!.resultado.transcricoesRedigidas).toBe(1);
    expect(r.completados[0]!.resultado.tabelas).toContain("messages:media_derived_text");
    expect(alvo.linhas.find((l) => l.id === "messages:1")!.media_derived_text).toBeNull();
  });

  it("⭐ poupa quem voltou a escrever, o vizinho e a outra org", async () => {
    alvo = banco([
      contatoAnonimizado(),
      // body de verdade: mensagem NOVA de quem voltou (religado pelo LID).
      audio("nova", { body: null, media_derived_text: "voltei, quero o orçamento" }),
      // mesmo body-sentinela, mas de OUTRO contato da mesma org, não anonimizado.
      audio("vizinho", { contact_id: "contacts:b" }),
      // mesmo contact_id em OUTRA org — só existe se algo já vazou.
      audio("outra-org", { organization_id: OUTRA_ORG }),
    ]);

    const r = await varrerRedacoesIncompletas(alvo.cliente);

    expect(r.completados).toEqual([]);
    expect(alvo.linhas.find((l) => l.id === "messages:nova")!.media_derived_text).toBe("voltei, quero o orçamento");
    expect(alvo.linhas.find((l) => l.id === "messages:vizinho")!.media_derived_text).not.toBeNull();
    expect(alvo.linhas.find((l) => l.id === "messages:outra-org")!.media_derived_text).not.toBeNull();
  });

  it("⭐ idempotente: a segunda passada não escreve nada", async () => {
    alvo = banco([contatoAnonimizado(), audio("1"), audio("2")]);

    const primeira = await varrerRedacoesIncompletas(alvo.cliente);
    expect(primeira.completados[0]!.resultado.transcricoesRedigidas).toBe(2);
    const escritas = alvo.escritas.length;

    const segunda = await varrerRedacoesIncompletas(alvo.cliente);

    expect(segunda.completados).toEqual([]);
    expect(alvo.escritas.length).toBe(escritas);
  });

  it("a rota (completarRedacaoDoContato) apaga pelo mesmo passo", async () => {
    alvo = banco([contatoAnonimizado(), audio("1")]);

    const r = await completarRedacaoDoContato(alvo.cliente, { id: "contacts:a", organizationId: ORG });

    expect(r.transcricoesRedigidas).toBe(1);
    expect(houveRedacao(r)).toBe(true);
    expect(alvo.linhas.find((l) => l.id === "messages:1")!.media_derived_text).toBeNull();
  });
});

describe("o laço de retorno: a varredura deixa rastro por contato", () => {
  function requisicaoAutorizada() {
    return { headers: new Headers({ authorization: "Bearer segredo" }) } as never;
  }

  beforeEach(() => {
    auditou.mockClear();
  });

  it("⭐ o cron completa a cascata e audita NA ORG do contato, não numa linha global", async () => {
    // Esta é a resposta ao DoD 13: a peça aparece em `/app/audit`, que lista as
    // linhas de `api_audit_log` e filtra por `action` digitada — conferido em
    // `app/app/audit/_client.tsx`, que é campo livre e não uma lista fechada, ou
    // seja, a linha aparece sem ninguém cadastrar nada. Uma linha
    // `retention.sweep_run` global não responderia ao titular, e é a auditoria
    // que responde a ele: por isso a org e o contato vão na linha.
    const b = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:a", title: "Orçamento com PII" },
    ]);
    bancoDoCron = b;

    const { GET } = await import("@/app/api/v1/cron/data-retention/route");
    const resposta = await GET(requisicaoAutorizada());
    const corpo = (await resposta.json()) as { data: Record<string, unknown> };

    expect(resposta.status).toBe(200);
    expect(corpo.data.anonimizacoes_completadas).toBe(1);
    const linhas = auditou.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const catchup = linhas.find((l) => l.action === "lgpd.anonymize_catchup");
    expect(catchup, "a varredura consertou e não deixou rastro nenhum").toBeDefined();
    expect(catchup!.organizationId).toBe(ORG);
    expect(catchup!.resourceId).toBe("contacts:a");
    expect(catchup!.metadata).toMatchObject({
      origem: "cron.data-retention",
      redacted_tables: ["crm_leads"],
    });
  });

  it("⭐ rodada sem resíduo NÃO audita — cron que resmunga é o defeito que a poda existe para não ser", async () => {
    // A outra direção do mesmo invariante que `cron-audita-so-quando-ha-efeito`
    // vigia: 365 linhas/ano numa instalação que não tem nada a corrigir.
    // A atividade já redigida entra de propósito: sem ela este caso não
    // discrimina o passo 3. Medido — com o filtro de resíduo das atividades
    // removido, ele passava, e a sabotagem reprovava 4 casos em vez de 5.
    bancoDoCron = banco([
      contatoAnonimizado(),
      { id: "crm_leads:1", organization_id: ORG, contact_id: "contacts:a", title: `Feita${SUFIXO_ANONIMIZADO}` },
      { id: "crm_lead_activities:1", organization_id: ORG, contact_id: "contacts:a", payload: { redacted: true } },
    ]);

    const { GET } = await import("@/app/api/v1/cron/data-retention/route");
    await GET(requisicaoAutorizada());

    expect(auditou, "auditou uma varredura que não fez nada").not.toHaveBeenCalled();
  });
});

describe("a varredura não derruba a poda junto com ela", () => {
  function requisicaoAutorizada() {
    return { headers: new Headers({ authorization: "Bearer segredo" }) } as never;
  }

  it("⭐ varredura que EXPLODE não faz o cron auditar a poda como falha", async () => {
    // Sem um try próprio, uma exceção aqui cairia no catch do handler: o cron
    // responderia 500 e gravaria `retention.sweep_run { falhou: true }` num dia
    // em que o expurgo do audit funcionou — a trilha passaria a mentir sobre a
    // peça que ela existe para vigiar.
    auditou.mockClear();
    bancoDoCron = {
      cliente: {
        from: () => {
          throw new Error("função ausente neste clone");
        },
      } as unknown as ClienteDaCascata,
    };

    const { GET } = await import("@/app/api/v1/cron/data-retention/route");
    const resposta = await GET(requisicaoAutorizada());

    expect(resposta.status, "a poda foi reportada como falha por causa da varredura").toBe(200);
    const acoes = auditou.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acoes).not.toContain("retention.sweep_run");
  });
});

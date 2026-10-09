/**
 * O ARQUIVO DE DADOS QUE O TITULAR RECEBE NÃO LEVA O QUE É DA EQUIPE
 * (doc 103, resposta A).
 *
 * O `data.json` passa a ir por link também no Brasil, e no Brasil e em
 * Portugal ele sai de `copiaDoTitular`. Este arquivo prova três coisas:
 *
 * 1. Nenhum campo da lista proibida sai. A lista está escrita AQUI, à mão, e
 *    não importada de `lib/lgpd/copia-do-titular.ts`: tirar um item de lá tem
 *    de deixar este teste vermelho, e uma lista importada concordaria com
 *    qualquer coisa. Todo valor proibido carrega a marca `SEGREDO`, e o teste
 *    procura a marca no arquivo INTEIRO — um caminho que a lista esqueça ainda
 *    é pego pelo texto.
 * 2. O que é do titular fica (marca `FICA`) — um filtro que apagasse tudo
 *    passaria no item 1.
 * 3. Isolamento: pelo caminho de produção (coletor + cópia), o que é de outro
 *    contato ou de outra organização não entra.
 *
 * E as três respostas do doc 110 ("1A, 2A, 3A"), cada uma com o seu caso:
 *
 * - 1A: das ações da IA fica o nome e a data; nada do que ela digitou (o termo
 *   de busca de contato, a razão de chamar um atendente) — Brasil e Portugal;
 *   e o que ela digitou (marca `IA-DIGITOU`) também não volta pela passagem
 *   que a chamada de atendente grava, nem pelo caso — ao abri-lo, nas notas e
 *   no encerramento por token, nem pelo assunto da demanda copiado do caso;
 * - 2A: o Brasil recebe TODAS as mensagens e a lista das seções no limite;
 * - 3A: em Portugal as seis notas da equipe sobre ele voltam (marca `NOTA`),
 *   com o texto e a data e sem o nome de quem escreveu; no Brasil, não.
 *
 * O PDF não muda: ele é desenhado do payload inteiro, antes da cópia. Quem o
 * trava byte a byte são os fixtures de `lgpd-texto-segue-o-pais.test.tsx`;
 * aqui o teste garante que a cópia não altera o payload de onde o PDF sai.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { copiaDoTitular, O_QUE_FICA, SECOES_DA_EQUIPE } from "@/lib/lgpd/copia-do-titular";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";

/** Seções inteiras que não podem sair. */
const SECOES_PROIBIDAS = ["conversation_notes", "case_chat_messages", "appointment_notices"];

/**
 * As seis notas da equipe SOBRE o titular (doc 110, 3A), escritas à mão: fora
 * no Brasil, dentro em Portugal. `conversation_notes` é seção inteira no Brasil.
 */
const NOTAS: Array<[string, string]> = [
  ["sales", "notes"],
  ["passagens", "content"],
  ["contact_field_proposals", "motivo_recusa"],
  ["b2b.pessoa", "notes"],
  ["b2b.vinculos", "notes"],
];

/** [seção, campo] que não pode sair de nenhuma linha, em país nenhum. */
const CAMPOS_PROIBIDOS: Array<[string, string]> = [
  ["activities", "source_module"],
  ["appointments", "google_base_projection"],
  ["appointments", "google_conflict"],
  ["appointments", "google_pending_write"],
  ["appointments", "meeting_state"],
  ["case_events", "metadata"],
  ["cases", "title"],
  ["cases", "summary"],
  ["cases", "blocker"],
  ["demandas", "assunto"],
  ["passagens", "motor"],
  ["passagens", "origem"],
  ["passagens", "body"],
  ["honorarios_contratos", "repasse_advogado_pct"],
  ["meeting_deliveries", "run_after"],
  ["avisos_de_caso", "destino_mascarado"],
  ["avisos_de_caso", "erro_codigo"],
  ["avisos_de_caso", "tentativas"],
  ["prospecting_candidates", "error"],
  ["b2b.linhas_importadas", "error"],
];

type Obj = Record<string, unknown>;
const linhas = (v: unknown): Obj[] =>
  Array.isArray(v) ? (v as Obj[]) : v && typeof v === "object" ? [v as Obj] : [];
const noCaminho = (raiz: Obj, caminho: string): Obj[] => {
  const [a, b] = caminho.split(".") as [string, string | undefined];
  return linhas(b === undefined ? raiz[a] : (raiz[a] as Obj | undefined)?.[b]);
};

/** Um payload com uma linha em cada seção que importa à lista. */
function payloadCheio(): ExportPayload {
  return {
    request_id: "FICA-protocolo",
    organization_id: "FICA-org",
    organization_legal_name: "FICA-razao",
    generated_at: "2026-10-06T00:00:00.000Z",
    contact: {
      id: "SEGREDO-contato-id",
      name: "FICA-nome",
      custom_fields: { pedido_id: "FICA-dentro-do-jsonb" },
      source_metadata: { ad_id: "FICA-anuncio" },
    },
    messages_recent: [
      { id: "SEGREDO-msg-id", conversation_id: "SEGREDO-conv-id", body: "FICA-mensagem" },
    ],
    leads: [{ id: "SEGREDO-l", pipeline_id: "SEGREDO-p", stage_id: "SEGREDO-s", title: "FICA-lead" }],
    orders: [{ id: "SEGREDO-o", external_id: "FICA-pedido-da-loja", status: "paid" }],
    activities: [{ id: "SEGREDO-a", lead_id: "SEGREDO-al", type: "FICA-tipo", source_module: "SEGREDO-modulo" }],
    appointments: [
      {
        id: "SEGREDO-ag",
        title: "FICA-consulta",
        notes: "FICA-anotacao-que-o-pdf-imprime",
        meeting_url: "FICA-link",
        google_base_projection: { x: "SEGREDO-g1" },
        google_conflict: { x: "SEGREDO-g2" },
        google_pending_write: { x: "SEGREDO-g3" },
        meeting_state: "SEGREDO-estado",
      },
    ],
    sales: [{ id: "SEGREDO-v", number: 7, notes: "NOTA-comanda", cancel_reason: "FICA-cancelou" }],
    // O que a IA digitou ao abrir o caso (`openCase`), para a fila da equipe.
    cases: [
      {
        id: "SEGREDO-caso",
        conversation_id: "SEGREDO-caso-conv",
        status: "FICA-resolved",
        title: "IA-DIGITOU-titulo-do-caso",
        summary: "IA-DIGITOU-resumo-do-caso",
        blocker: "IA-DIGITOU-bloqueio-do-caso",
        source: "FICA-agent",
        opened_at: "FICA-abriu",
      },
    ],
    // `assunto` só existe nas demandas da fila antiga, copiado do `title` do caso.
    demandas: [
      { id: "SEGREDO-dm", agent_case_id: "SEGREDO-dmc", assunto: "IA-DIGITOU-titulo-do-caso", estado: "FICA-resolvida" },
    ],
    case_events: [
      {
        id: "SEGREDO-ce",
        case_id: "SEGREDO-cec",
        kind: "FICA-opened",
        actor_kind: "agent",
        metadata: { destino_mascarado: "SEGREDO-plantao", entrega_id: "SEGREDO-ent" },
      },
      // `crm_add_case_note` / `crm_close_human_case` (escalacao.ts): ator `agent`,
      // chamado com token — IA, integração ou pessoa —, texto para o próximo atendente.
      { kind: "agent_noted", actor_kind: "agent", body: "IA-DIGITOU-nota-do-caso", created_at: "FICA-quando-anotou" },
      // `provideCaseUpdate`: o que ELE informou.
      { kind: "lead_provided", actor_kind: "lead", body: "FICA-o-que-ele-informou" },
      // `human_replied`: a nota de quem resolveu (human-cases.ts) é texto da equipe.
      { id: "SEGREDO-ch", actor_kind: "human", human_action: "FICA-resolved", body: "NOTA-de-quem-resolveu" },
    ],
    honorarios_contratos: [
      { id: "SEGREDO-hc", lead_id: "SEGREDO-hcl", modelo: "FICA-modelo", repasse_advogado_pct: "SEGREDO-repasse" },
    ],
    meeting_deliveries: [
      { id: "SEGREDO-md", status: "FICA-enviado", run_after: "SEGREDO-fila", appointment_id: "SEGREDO-mda" },
    ],
    contact_field_proposals: [
      { id: "SEGREDO-cfp", campo: "FICA-campo", trecho: "FICA-trecho", motivo_recusa: "NOTA-recusa" },
    ],
    appointment_notices: [{ id: "SEGREDO-an", title: "SEGREDO-aviso-da-central" }],
    // A narrativa (`body`) repete entre aspas o `content` de quem passou
    // (`montarBriefingDaPassagem`): se ela ficasse, o texto voltaria por ela.
    passagens: [
      {
        id: "SEGREDO-pa",
        conversation_id: "SEGREDO-pac",
        caso_id: "SEGREDO-paca",
        motor: "SEGREDO-motor",
        origem: "caso_escalado",
        motivo_codigo: "FICA-motivo",
        title: "FICA-o-que-ele-quer",
        body: 'SEGREDO-narrativa: A pessoa que escalou escreveu: "NOTA-razao-de-quem-escalou"',
        notes: "FICA-ultimas-palavras-do-cliente",
        content: "NOTA-razao-de-quem-escalou",
        tentativas: ["FICA-tentativa"],
      },
      {
        id: "SEGREDO-pa2",
        motor: "SEGREDO-motor",
        origem: "ferramenta_do_modelo",
        motivo_codigo: "FICA-motivo-da-ia",
        body: 'SEGREDO-narrativa: Quem passou escreveu: "IA-DIGITOU-por-que"',
        // O que a IA digitou em `request_human_handoff` (`human-handoff.ts` →
        // `montarBriefingDaPassagem`): `cliente_quer` → title, `o_que_tentei` → tentativas.
        title: "IA-DIGITOU-cliente-quer",
        content: "IA-DIGITOU-por-que",
        tentativas: [{ o_que: "IA-DIGITOU-o-que-tentei", desfecho: "IA-DIGITOU-desfecho" }],
        notes: "FICA-palavras-dele-na-passagem-da-ia",
      },
      {
        // `crm_request_human_handoff` por token: a linha não diz se quem chamou é
        // IA, integração ou pessoa — então sai como da IA, também em Portugal.
        origem: "mcp_externo",
        motivo_codigo: "FICA-motivo-do-mcp",
        body: "SEGREDO-narrativa-do-mcp",
        title: "IA-DIGITOU-cliente-quer-mcp",
        content: "IA-DIGITOU-reason-mcp",
        tentativas: [{ o_que: "IA-DIGITOU-o-que-tentei-mcp" }],
      },
    ],
    avisos_de_caso: [
      {
        id: "SEGREDO-av",
        case_id: "SEGREDO-avc",
        destino_mascarado: "SEGREDO-fone-funcionario",
        erro_codigo: "SEGREDO-erro",
        tentativas: "SEGREDO-n",
        status: "FICA-entregue",
      },
    ],
    prospecting_candidates: [
      { id: "SEGREDO-pc", campaign_id: "SEGREDO-pcc", place_id: "SEGREDO-place", error: "SEGREDO-e", phone: "FICA-fone" },
    ],
    conversation_notes: [
      {
        id: "SEGREDO-cn",
        conversation_id: "SEGREDO-cnc",
        body: "NOTA-nota-interna",
        media_storage_path: "SEGREDO-caminho-do-anexo",
        media_mime: "SEGREDO-mime",
        media_size_bytes: 12345,
        created_at: "NOTA-data-da-nota",
        created_by_name: "SEGREDO-funcionario",
      },
    ],
    case_chat_messages: [{ id: "y", body: "SEGREDO-chat-interno" }],
    // A forma de `toolCallsParaOTitular`: passo → chamadas → args. O funcionário da
    // agenda (`owner_user_id`, agendamento.ts) e o do repasse (`target_user_id`,
    // handoff.ts) moram nos argumentos; o termo da busca de contato pode ser o
    // nome de OUTRO cliente, e a razão do repasse é texto para a equipe (doc 110, 1A).
    ai_agent_runs: [
      {
        id: "SEGREDO-run",
        created_at: "FICA-quando-a-ia-rodou",
        tool_calls: [
          {
            step: 1,
            tool_calls: [
              {
                tool_name: "FICA-crm_book_appointment",
                args: {
                  owner_user_id: "SEGREDO-funcionario-uuid",
                  lead_id: "SEGREDO-args-lead",
                  texto: "SEGREDO-args",
                  repasse: { target_user_id: "SEGREDO-alvo-do-repasse" },
                },
              },
              { tool_name: "FICA-crm_search_contacts", args: { query: "SEGREDO-nome-de-outro-cliente" } },
              {
                tool_name: "FICA-handoff_to_human",
                args: { reason: "SEGREDO-razao-para-a-equipe", attempted: "SEGREDO-o-que-a-ia-tentou" },
                result: "SEGREDO-resultado",
              },
            ],
          },
        ],
      },
    ],
    b2b: {
      pessoa: { id: "SEGREDO-pe", full_name: "FICA-pessoa", notes: "NOTA-b2b" },
      vinculos: [{ company_id: "SEGREDO-co", job_title: "FICA-cargo", notes: "NOTA-vinculo" }],
      linhas_importadas: [
        { id: "SEGREDO-li", batch_id: "SEGREDO-lote", raw_data: { nome: "FICA-planilha" }, error: "SEGREDO-imp" },
      ],
    },
  } as unknown as ExportPayload;
}

const PAISES = ["BR", "PT"] as const;

describe("o arquivo do titular (data.json)", () => {
  it.each(PAISES)("%s: não leva nenhuma seção nem campo da lista proibida", (pais) => {
    const copia = copiaDoTitular(payloadCheio(), pais);
    for (const secao of SECOES_PROIBIDAS.filter((s) => pais === "BR" || s !== "conversation_notes"))
      expect(copia, secao).not.toHaveProperty(secao);
    for (const [secao, campo] of CAMPOS_PROIBIDOS) {
      const ls = noCaminho(copia, secao);
      expect(ls.length, `${secao}: a seção sumiu do teste`).toBeGreaterThan(0);
      for (const l of ls) expect(l, `${secao}.${campo}`).not.toHaveProperty(campo);
    }
  });

  it.each(PAISES)("%s: não leva chave de banco de linha nenhuma — e nada marcado SEGREDO, em lugar nenhum", (pais) => {
    const copia = copiaDoTitular(payloadCheio(), pais);
    const secoes = Object.entries(copia).flatMap(([k, v]) =>
      k === "b2b" ? Object.values(v as Obj).flatMap(linhas) : linhas(v),
    );
    for (const l of secoes)
      for (const campo of Object.keys(l))
        expect(campo === "id" || (campo.endsWith("_id") && campo !== "external_id"), campo).toBe(false);
    expect(JSON.stringify(copia).match(/SEGREDO[^"]*/g) ?? []).toEqual([]);
  });

  it.each(PAISES)("%s: leva o que é do titular, inclusive chave dentro de um jsonb dele", (pais) => {
    const tudo = JSON.stringify(payloadCheio());
    const copia = JSON.stringify(copiaDoTitular(payloadCheio(), pais));
    const fica = tudo.match(/FICA-[a-z_-]+/g)!;
    expect(fica.length).toBeGreaterThan(20);
    for (const marca of fica) expect(copia, marca).toContain(marca);
  });

  it.each(PAISES)("%s: não altera o payload de onde o PDF é desenhado", (pais) => {
    const data = payloadCheio();
    const antes = structuredClone(data);
    copiaDoTitular(data, pais);
    expect(data).toEqual(antes);
  });

  it("o worker sobe a cópia do país da organização, desenha o PDF do payload e assina o link para todo país", () => {
    const fonte = readFileSync(join(__dirname, "..", "..", "workers", "lgpd-export-worker.ts"), "utf8");
    // `perfil.codigo`: o MESMO perfil lido uma vez e passado ao coletor e ao e-mail.
    expect(fonte).toContain("partesDoArquivoDoTitular(data, perfil.codigo)");
    expect(fonte).toContain("renderLgpdPdf(data,");
    expect(fonte).toContain(".createSignedUrl(jsonPath, expiresInSec)");
    // O link do arquivo era pedido só fora do Brasil; o país não pode voltar a decidir isso.
    expect(fonte).not.toContain("PAIS_PADRAO");
    // #2576: o arquivo sai em STREAM. A cópia serializada inteira e o Buffer do
    // arquivo inteiro são o defeito — não podem voltar a aparecer aqui.
    expect(fonte).not.toContain("JSON.stringify(copiaDoTitular(");
    expect(fonte).not.toContain("Buffer.from(JSON.stringify(");
  });
});

describe("doc 110 — as três respostas do dono", () => {
  it.each(PAISES)(
    "1A (%s): das ações da IA ficam o nome e quando rodou; nada do que ela digitou",
    (pais) => {
      const copia = copiaDoTitular(payloadCheio(), pais);
      const [run] = linhas(copia.ai_agent_runs);
      expect(run).toEqual({
        created_at: "FICA-quando-a-ia-rodou",
        tool_calls: [
          {
            step: 1,
            tool_calls: [
              { tool_name: "FICA-crm_book_appointment" },
              { tool_name: "FICA-crm_search_contacts" },
              { tool_name: "FICA-handoff_to_human" },
            ],
          },
        ],
      });
    },
  );

  it("3A: no Brasil nenhuma das seis notas da equipe sobre ele sai (doc 103)", () => {
    const copia = copiaDoTitular(payloadCheio(), "BR");
    expect(copia).not.toHaveProperty("conversation_notes");
    for (const [secao, campo] of NOTAS)
      for (const l of noCaminho(copia, secao)) expect(l, `${secao}.${campo}`).not.toHaveProperty(campo);
    expect(JSON.stringify(copia).match(/NOTA-[a-z-]+/g) ?? []).toEqual([]);
  });

  it("3A: em Portugal as seis notas saem com o texto e a data, sem o nome de quem escreveu nem o anexo", () => {
    const copia = copiaDoTitular(payloadCheio(), "PT");
    const texto = JSON.stringify(copia);
    for (const nota of JSON.stringify(payloadCheio()).match(/NOTA-[a-z-]+/g)!) expect(texto, nota).toContain(nota);
    expect(copia.conversation_notes).toEqual([{ body: "NOTA-nota-interna", created_at: "NOTA-data-da-nota" }]);
    for (const [secao, campo] of NOTAS)
      expect(noCaminho(copia, secao).some((l) => campo in l), `${secao}.${campo}`).toBe(true);
    // O nome do funcionário e o caminho do anexo: o art. 15.º, n.º 4 protege OUTRAS pessoas.
    expect(texto).not.toContain("SEGREDO-funcionario");
    expect(texto).not.toContain("SEGREDO-caminho-do-anexo");
  });

  it.each(PAISES)(
    "1A (%s): o `por_que` que a IA escreveu ao chamar um atendente não volta pela passagem, nem pela narrativa",
    (pais) => {
      const copia = copiaDoTitular(payloadCheio(), pais);
      const passagens = linhas(copia.passagens);
      expect(passagens[1]).toEqual({
        motivo_codigo: "FICA-motivo-da-ia",
        notes: "FICA-palavras-dele-na-passagem-da-ia",
      });
      expect(passagens[2]).toEqual({ motivo_codigo: "FICA-motivo-do-mcp" });
      for (const p of passagens) expect(p).not.toHaveProperty("body");
      expect(JSON.stringify(copia).match(/IA-DIGITOU[^"]*/g) ?? []).toEqual([]);
    },
  );

  it.each(PAISES)(
    "1A (%s): na passagem que a IA não digitou, o pedido em uma linha fica",
    (pais) => {
      const [escalado] = linhas(copiaDoTitular(payloadCheio(), pais).passagens);
      expect(escalado).toMatchObject({ title: "FICA-o-que-ele-quer", tentativas: ["FICA-tentativa"] });
    },
  );

  it.each(PAISES)(
    "1A (%s): o que a IA digitou no caso — ao abrir, na nota, no encerramento — não volta; o que ele informou fica",
    (pais) => {
      const copia = copiaDoTitular(payloadCheio(), pais);
      expect(linhas(copia.cases)).toEqual([{ status: "FICA-resolved", source: "FICA-agent", opened_at: "FICA-abriu" }]);
      expect(linhas(copia.demandas)).toEqual([{ estado: "FICA-resolvida" }]);
      const eventos = linhas(copia.case_events);
      expect(eventos[1]).toEqual({ kind: "agent_noted", actor_kind: "agent", created_at: "FICA-quando-anotou" });
      expect(eventos[2]).toEqual({ kind: "lead_provided", actor_kind: "lead", body: "FICA-o-que-ele-informou" });
      expect(JSON.stringify(copia).match(/IA-DIGITOU[^"]*/g) ?? []).toEqual([]);
    },
  );

  it("3A: um país sem decisão segue o Brasil, não Portugal", () => {
    expect(copiaDoTitular(payloadCheio(), "XI")).toEqual(copiaDoTitular(payloadCheio(), "BR"));
  });
});

// ---------------------------------------------------------------------------
// Isolamento, pelo caminho de produção: coletor → cópia
// ---------------------------------------------------------------------------

const ORG = "org-a";
const OUTRA_ORG = "org-b";
const CONTATO = "contato-a";
const OUTRO_CONTATO = "contato-b";

type Row = Record<string, unknown>;
let banco: Record<string, Row[]>;

/** Banco falso que aplica `eq`/`in` como o Postgres; método que não conhece não filtra. */
function consulta(tabela: string): unknown {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let colunas = "";
  let faixa: [number, number] = [0, Number.MAX_SAFE_INTEGER];
  const executar = async () => {
    const data = (banco[tabela] ?? [])
      .filter((r) => eqs.every(([k, v]) => r[k] === v))
      .filter((r) => ins.every(([k, vs]) => vs.includes(r[k])))
      .slice(faixa[0], faixa[1] + 1)
      .map((r) =>
        colunas.includes("*") || colunas === ""
          ? r
          : Object.fromEntries(colunas.split(",").map((c) => c.trim()).map((c) => [c, r[c]])),
      );
    return { data, error: null, count: data.length };
  };
  const q: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then")
          return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => executar().then(ok, erro);
        if (prop === "maybeSingle" || prop === "single")
          return async () => {
            const r = await executar();
            return { ...r, data: r.data[0] ?? null };
          };
        if (prop === "select")
          return (c: string) => {
            colunas = c;
            return q;
          };
        if (prop === "eq")
          return (k: string, v: unknown) => {
            eqs.push([k, v]);
            return q;
          };
        if (prop === "in")
          return (k: string, vs: unknown[]) => {
            ins.push([k, vs]);
            return q;
          };
        if (prop === "limit")
          return (n: number) => {
            faixa = [faixa[0], faixa[0] + n - 1];
            return q;
          };
        if (prop === "range")
          return (de: number, ate: number) => {
            faixa = [de, ate];
            return q;
          };
        return () => q;
      },
    },
  );
  return q;
}

const linha = (dono: { org: string; contato: string }, extra: Row): Row => ({
  organization_id: dono.org,
  contact_id: dono.contato,
  created_at: "2026-10-01T00:00:00Z",
  ...extra,
});

beforeEach(() => {
  const meu = { org: ORG, contato: CONTATO };
  const doVizinho = { org: ORG, contato: OUTRO_CONTATO };
  const daOutraOrg = { org: OUTRA_ORG, contato: CONTATO };
  banco = {
    organizations: [{ id: ORG, legal_name: "Empresa A", display_name: "A", dpo_email: null }],
    contacts: [
      { id: CONTATO, organization_id: ORG, name: "MEU-nome", created_at: "2026-01-01T00:00:00Z" },
      { id: CONTATO, organization_id: OUTRA_ORG, name: "OUTRA-ORG-nome", created_at: "2026-01-01T00:00:00Z" },
    ],
    conversations: [
      linha(meu, { id: "conv-meu", status: "open", channel: "whatsapp" }),
      linha(doVizinho, { id: "conv-vizinho", status: "open", channel: "whatsapp" }),
      linha(daOutraOrg, { id: "conv-outra-org", status: "open", channel: "whatsapp" }),
    ],
    messages: [
      linha(meu, { id: "m1", conversation_id: "conv-meu", body: "MEU-mensagem", direction: "in" }),
      linha(doVizinho, { id: "m2", conversation_id: "conv-vizinho", body: "VIZINHO-mensagem", direction: "in" }),
      linha(daOutraOrg, { id: "m3", conversation_id: "conv-outra-org", body: "OUTRA-ORG-mensagem", direction: "in" }),
    ],
    crm_leads: [
      linha(meu, { id: "l1", title: "MEU-lead" }),
      linha(doVizinho, { id: "l2", title: "VIZINHO-lead" }),
      linha(daOutraOrg, { id: "l3", title: "OUTRA-ORG-lead" }),
    ],
    lead_notes: [
      linha(meu, { id: "n1", headline: "MEU-memoria", body: "MEU-memoria-corpo" }),
      linha(doVizinho, { id: "n2", headline: "VIZINHO-memoria", body: "x" }),
      linha(daOutraOrg, { id: "n3", headline: "OUTRA-ORG-memoria", body: "x" }),
    ],
  };
  mock.admin.mockReturnValue({ from: consulta, rpc: async () => ({ data: null, error: null }) });
});

describe("isolamento do arquivo do titular", () => {
  it("leva o que é dele e nada de outro contato nem de outra organização", async () => {
    const data = await collectExportData({
      organizationId: ORG,
      requestId: "pedido-1",
      contactId: CONTATO,
      externalCustomerId: null,
      pais: "BR",
    });
    const arquivo = JSON.stringify(copiaDoTitular(data, "BR"));
    for (const meu of ["MEU-nome", "MEU-mensagem", "MEU-lead", "MEU-memoria"]) expect(arquivo, meu).toContain(meu);
    expect(arquivo.match(/(VIZINHO|OUTRA-ORG)-[a-z-]+/g) ?? []).toEqual([]);
  });

  it("2A: no Brasil o arquivo leva TODAS as mensagens dele e a lista das seções no limite", async () => {
    // 1.234 mensagens: passa do recorte de 100 e de duas páginas de 500.
    const minhas = Array.from({ length: 1234 }, (_, i) =>
      linha({ org: ORG, contato: CONTATO }, { id: `mm${i}`, conversation_id: "conv-meu", body: `MEU-${i}` }),
    );
    banco.messages = [...(banco.messages ?? []), ...minhas];
    const data = await collectExportData({
      organizationId: ORG,
      requestId: "pedido-1",
      contactId: CONTATO,
      externalCustomerId: null,
      pais: "BR",
    });
    const copia = copiaDoTitular(data, "BR");
    expect(copia.messages_recent, "a amostra do PDF não muda").toHaveLength(100);
    const corpos = linhas(copia.messages_completas).map((m) => m.body);
    expect(corpos, "o recorte de 100 voltou").toHaveLength(1235);
    expect(corpos).toContain("MEU-mensagem");
    expect(corpos).toContain("MEU-1233");
    expect(corpos.filter((b) => /VIZINHO|OUTRA-ORG/.test(String(b)))).toEqual([]);
    expect(copia.secoes_no_limite, "o aviso das seções no limite").toEqual([]);
  });

  it("toda seção que o coletor devolve foi decidida: vai ao titular ou sai, com o motivo", async () => {
    const data = await collectExportData({
      organizationId: ORG,
      requestId: "pedido-1",
      contactId: CONTATO,
      externalCustomerId: null,
      pais: "PT",
    });
    const decididas = new Set([...Object.keys(O_QUE_FICA), ...Object.keys(SECOES_DA_EQUIPE)]);
    const cheio = JSON.parse(
      readFileSync(join(__dirname, "..", "fixtures", "lgpd-brasil-antes-do-doc88", "data-cheio.json"), "utf8"),
    ) as Obj;
    const secoes = new Set([...Object.keys(data), ...Object.keys(cheio), ...Object.keys(payloadCheio())]);
    expect(secoes.size).toBeGreaterThan(40);
    expect([...secoes].filter((s) => !decididas.has(s))).toEqual([]);
  });
});

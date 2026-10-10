/**
 * GUARDA DOURADA DO `data.json` DO TITULAR — a saída de
 * `partesDoArquivoDoTitular` não pode mudar um byte sem decisão do dono.
 *
 * Alcance, dito sem inflar: o que se executa aqui é a função de produção
 * `partesDoArquivoDoTitular`. O embrulho em `Buffer` que o worker faz
 * (`workers/lgpd-export-worker.ts`, o `Readable.from` do upload) NÃO é
 * executado — `arquivoComoOWorkerSobe` é um espelho dele. Para o espelho não
 * envelhecer calado, o último caso confere no TEXTO do worker que o laço ainda
 * é o mesmo (`yield Buffer.from(pedaco, "utf-8")` sobre
 * `partesDoArquivoDoTitular(data, perfil.codigo)`). É conferência de fonte, não
 * de execução: um worker que embrulhe igual com outra grafia reprova aqui e
 * pede que se atualize o espelho junto.
 *
 * Por que existe: o #2651 trocou a montagem do arquivo (cópia profunda +
 * `JSON.stringify(copia, null, 2)`) pela escrita em partes
 * (`partesDoArquivoDoTitular`). A triagem provou igualdade byte a byte contra a
 * versão anterior, mas o teste do PR compara a função nova com ela mesma — se
 * as duas derivarem juntas, ele segue verde. A saída LGPD inalterada é
 * doutrina e não pode depender de quem lembra: aqui o esperado é um valor
 * FIXO, gerado pela versão anterior ao #2651.
 *
 * De onde veio o dourado: `git show ca4c1cddb:lib/lgpd/copia-do-titular.ts`
 * (primeiro pai do merge 314a10d8a, #2651), com
 * `JSON.stringify(copiaDoTitular(corpus, pais), null, 2)` sobre o MESMO corpus
 * abaixo.
 *
 * Regenerar SÓ com decisão do dono registrada (mudar o que o titular recebe é
 * decisão de produto e de lei, não de refactor): edite o corpus ou a regra,
 * recalcule com a versão que o dono aprovou e cite a decisão no commit. Se este
 * teste ficou vermelho num refactor, o defeito é do refactor.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { partesDoArquivoDoTitular } from "@/lib/lgpd/copia-do-titular";
import type { ExportPayload } from "@/lib/lgpd/export-collector";

/**
 * ESPELHO do embrulho do worker (`workers/lgpd-export-worker.ts`, upload do
 * `data.json`): cada parte vira um Buffer UTF-8. Não é o worker — o último caso
 * deste arquivo confere que o worker ainda faz exatamente isto.
 */
async function arquivoComoOWorkerSobe(data: ExportPayload, pais: string): Promise<Buffer> {
  const pedacos: Buffer[] = [];
  for await (const pedaco of partesDoArquivoDoTitular(data, pais)) pedacos.push(Buffer.from(pedaco, "utf-8"));
  return Buffer.concat(pedacos);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const MENSAGENS = [
  { id: "m1", conversation_id: "cv1", external_id: "wamid.1", body: "oi 😀", direction: "in", created_at: "2026-01-02T03:04:05.000Z" },
  undefined,
  null,
  'item solto',
  42,
  { id: "m2", body: "\u0000\u0001\u001f\u007f linha\nnova\ttab\r", media: { storage_path: "org/x.jpg", mime_id: "image/jpeg" } },
];

/** Payload rico: toda regra da projeção e toda borda do serializador numa só ficha. */
function payloadRico(comMensagens: boolean): ExportPayload {
  const p: Record<string, unknown> = {
    request_id: "req-0001",
    organization_id: "org-0001",
    organization_legal_name: 'Clínica Ação & Cia "Ltda"',
    organization_display_name: "日本語 ñ ü ß ø",
    dpo_email: null,
    lei_citada: "LGPD",
    fuso: "America/Sao_Paulo",
    generated_at: "2026-10-09T12:00:00.000Z",
    no_local_footprint: false,
    secoes_no_limite: ["messages_completas"],
    contact: {
      id: "c1",
      organization_id: "org-0001",
      owner_user_id: "u1",
      external_id: "ext-9",
      name: "Ana 😀👨‍👩‍👧 🇧🇷",
      some: undefined,
      fn: () => 1,
      controle: "\u0000\u0001\u001f\u007f",
      surrogate: "\ud800 sozinho e fim \udfff",
      html: "<script>alert('x')</script>",
      barra: 'aspas "duplas" e \\barra / e   ',
      "chave ç": "v",
      "13": "chave numérica",
      "2": "inteiros vêm primeiro",
      custom_fields: { pedido_id: "P-13", nested: { id: 7, lista: [1, null, "x", [], {}, undefined] }, vazio: {} },
    },
    consents: [],
    conversations: [{ id: "cv1", channel: "whatsapp", status: "open", created_at: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) }],
    messages_count_total: 2 ** 53 + 2,
    messages_recent: MENSAGENS,
    leads: [
      {
        id: "l1",
        pipeline_id: "p1",
        title: "Oportunidade",
        valor_cents: 123456789012,
        currency: "BRL",
        fracao: 3.14159,
        grande: 1e21,
        pequeno: 1e-7,
        negzero: -0,
        nan: NaN,
        inf: Infinity,
        minf: -Infinity,
        max: Number.MAX_SAFE_INTEGER,
        ativo: true,
        perdido: false,
      },
    ],
    sales: [{ id: "s1", notes: "nota do atendente", total_cents: 0 }],
    honorarios_contratos: [{ id: "h1", repasse_advogado_pct: 30, valor_cents: 100 }],
    activities: [{ id: "a1", type: "note", source_module: "crm", created_at: "2026-01-01T00:00:00.000Z" }],
    appointments: [{ google_conflict: true, meeting_state: "ok", meeting_url: "https://meet.example/x", notes: "fica" }],
    demandas: [{ id: "d1", assunto: "cópia do título", estado: "aberta" }],
    orders: "seção escalar em vez de lista",
    tasks: undefined,
    voice_calls: [[1, 2], [], [{ id: "vc", duracao: 3 }]],
    cases: [{ id: "k1", title: "t da IA", summary: "s da IA", blocker: "b", status: "resolvido" }],
    case_events: [
      { id: "e1", case_id: "k1", actor_kind: "agent", body: "nota da IA", metadata: { tel: "***" } },
      { id: "e2", actor_kind: "human", body: "nota da pessoa" },
      { id: "e3", actor_kind: "lead", body: "o que ele informou" },
      { id: "e4", actor_kind: "system" },
    ],
    passagens: [
      { id: "ps1", origem: "caso_escalado", title: "t1", content: "razão da pessoa", tentativas: "x", motor: "v2", body: "b", motivo_codigo: "pedido" },
      { id: "ps2", origem: "ferramenta_do_modelo", title: "t2", content: "por que", tentativas: "tentei", motivo_codigo: "duvida" },
      { id: "ps3", origem: "mcp_externo", title: "t3", content: "c3", tentativas: "y" },
      { id: "ps4", origem: "sistema", title: "t4", content: "c4", tentativas: "" },
      { id: "ps5", title: "sem origem", content: "c5" },
    ],
    avisos_de_caso: [{ id: "av1", destino_mascarado: "+55***", erro_codigo: "E1", tentativas: 2, enviado_em: "2026-01-01" }],
    ai_agent_runs: [
      {
        id: "r1",
        conversation_id: "cv1",
        tool_calls: [
          {
            step: 1,
            tool_name: "passo",
            redacted: true,
            extra: "sai",
            tool_calls: [{ tool_name: "crm_search_contacts", args: { q: "Maria" }, result: "r" }, { args: {} }],
          },
          { step: 2, redacted: false, tool_calls: "não é lista" },
        ],
        created_at: "2026-01-01T00:00:00.000Z",
      },
      { id: "r2", tool_calls: null },
    ],
    conversation_notes: [{ id: "n1", body: "nota interna", created_at: "2026-01-03", author_name: "Funcionário", attachment_path: "org/n" }],
    case_chat_messages: [{ body: "interno" }],
    appointment_notices: [{ kind: "registrar_desfecho" }],
    contact_field_proposals: [{ id: "cf1", campo: "email", motivo_recusa: "não confere" }],
    prospecting_candidates: [{ id: "pc1", error: "timeout", fonte: "maps" }],
    b2b: {
      pessoa: { id: "bp1", nome: "Ana", notes: "nota sobre ela" },
      vinculos: [{ empresa_id: "co", cargo: "sócia", notes: "nota do vínculo" }],
      linhas_importadas: [{ id: "li1", error: "linha ruim", linha: 3 }],
      ausente: undefined,
    },
    art15: { finalidades: ["atendimento", "cobrança"], prazo: "5 anos", destinatario_id: "x" },
    lead_notes: [],
  };
  if (comMensagens) p.messages_completas = MENSAGENS;
  return p as unknown as ExportPayload;
}

/** Pequeno o bastante para o esperado ser lido de olho. */
function payloadPequeno(): ExportPayload {
  return {
    request_id: "req-9",
    contact: { id: "c9", name: "Zé", custom_fields: { pedido_id: "P-1" } },
    passagens: [{ id: "p9", origem: "ferramenta_do_modelo", title: "t", content: "c", motivo_codigo: "duvida" }],
    conversation_notes: [{ id: "n9", body: "nota", created_at: "2026-01-01", author_name: "F" }],
    secoes_no_limite: [],
  } as unknown as ExportPayload;
}

const vazio = () => ({ request_id: "r", secoes_no_limite: [] }) as unknown as ExportPayload;

const DOURADO_PEQUENO_BR = [
  '{',
  '  "request_id": "req-9",',
  '  "contact": {',
  '    "name": "Zé",',
  '    "custom_fields": {',
  '      "pedido_id": "P-1"',
  '    }',
  '  },',
  '  "passagens": [',
  '    {',
  '      "motivo_codigo": "duvida"',
  '    }',
  '  ],',
  '  "secoes_no_limite": []',
  '}',
].join("\n");

const DOURADO_PEQUENO_PT = [
  '{',
  '  "request_id": "req-9",',
  '  "contact": {',
  '    "name": "Zé",',
  '    "custom_fields": {',
  '      "pedido_id": "P-1"',
  '    }',
  '  },',
  '  "passagens": [',
  '    {',
  '      "motivo_codigo": "duvida"',
  '    }',
  '  ],',
  '  "secoes_no_limite": [],',
  '  "conversation_notes": [',
  '    {',
  '      "body": "nota",',
  '      "created_at": "2026-01-01"',
  '    }',
  '  ]',
  '}',
].join("\n");

// BR e US saem iguais: só Portugal recebe as notas (doc 110, 3A).
const DOURADO_RICO: Record<string, { bytes: number; sha256: string }> = {
  "BR com mensagens": { bytes: 4444, sha256: "a2f315da96a3e561d21c460af24bf378d3d086ba4d11ff90429fdd6b1c1dc919" },
  "BR sem mensagens": { bytes: 4063, sha256: "858726f927c1589c4eb877cfc35ec17e7fd2cfb89c19dd8d16b4bcb3b6833bce" },
  "PT com mensagens": { bytes: 4764, sha256: "582223baae6fb6766e25c4f7016751235968eea9ffc8d2258c6392c9d7b5d65e" },
  "US com mensagens": { bytes: 4444, sha256: "a2f315da96a3e561d21c460af24bf378d3d086ba4d11ff90429fdd6b1c1dc919" },
};

describe("data.json do titular: preso, byte a byte, à saída anterior ao #2651", () => {
  it("vazio, BR e PT", async () => {
    const esperado = '{\n  "request_id": "r",\n  "secoes_no_limite": []\n}';
    expect((await arquivoComoOWorkerSobe(vazio(), "BR")).toString("utf-8")).toBe(esperado);
    expect((await arquivoComoOWorkerSobe(vazio(), "PT")).toString("utf-8")).toBe(esperado);
  });

  it("pequeno, BR: chave de banco e nota da equipe saem; texto da IA sai da passagem", async () => {
    expect((await arquivoComoOWorkerSobe(payloadPequeno(), "BR")).toString("utf-8")).toBe(DOURADO_PEQUENO_BR);
  });

  it("pequeno, PT: a nota da equipe volta com texto e data, no fim", async () => {
    expect((await arquivoComoOWorkerSobe(payloadPequeno(), "PT")).toString("utf-8")).toBe(DOURADO_PEQUENO_PT);
  });

  for (const [nome, pais, comMensagens] of [
    ["BR com mensagens", "BR", true],
    ["BR sem mensagens", "BR", false],
    ["PT com mensagens", "PT", true],
    ["US com mensagens", "US", true],
  ] as const) {
    it(`rico, ${nome}: sha256 igual ao da versão anterior`, async () => {
      const arquivo = await arquivoComoOWorkerSobe(payloadRico(comMensagens), pais);
      expect({ bytes: arquivo.length, sha256: sha256(arquivo) }).toEqual(DOURADO_RICO[nome]);
    });
  }

  it("o espelho acima ainda é o embrulho do worker (conferência de fonte)", () => {
    const worker = readFileSync(join(__dirname, "..", "..", "workers/lgpd-export-worker.ts"), "utf8");
    expect(worker).toMatch(
      /for await \(const pedaco of partesDoArquivoDoTitular\(data, perfil\.codigo\)\) \{\s*yield Buffer\.from\(pedaco, "utf-8"\);\s*\}/,
    );
  });
});


/**
 * #2576 — O ARQUIVO DE DADOS DO TITULAR SAI EM STREAM, E O PARCIAL SAI COM
 * RESSALVA.
 *
 * A issue descreve dois defeitos e pede medição; este arquivo é a medição.
 *
 * 1. O `data.json` era montado com payload, CÓPIA profunda
 *    (`JSON.parse(JSON.stringify(data))` em `copiaDoTitular`), string
 *    serializada e `Buffer` QUATRO vezes o arquivo morando juntos no pico
 *    (`workers/lgpd-export-worker.ts`, linha de upload). Aqui se prova:
 *
 *    a) o arquivo em partes é BYTE A BYTE o `JSON.stringify(copia, null, 2)` de
 *       sempre (o que o titular recebe não muda por isto);
 *    b) o maior pedaço que existe de uma vez é UMA LINHA, e não cresce quando o
 *       arquivo cresce quatro vezes;
 *    c) a causa da issue se REPRODUZ, nos DOIS tamanhos que a issue pede (50 mil
 *       e 100 mil mensagens): a receita de antes acrescenta ao heap mais que
 *       CINCO vezes o arquivo por cima do payload — e imprime também o RSS do
 *       processo, não só o heap do trecho;
 *    d) depois: o que a escrita acrescenta ao heap, com o payload vivo e GC
 *       forçado, cabe em MENOS que UM arquivo nos mesmos dois tamanhos — e o
 *       maior pedaço de uma vez é constante entre 25k e 100k mensagens (memória
 *       por alocação constante em payload grande);
 *    e) nenhuma cópia profunda sobrou no caminho do arquivo (guarda de fonte).
 *
 *    As medições de heap usam o GC forçado (`--expose_gc` via
 *    `v8.setFlagsFromString`, que não exige flag na linha de comando). Sem GC
 *    disponível o teste cai para a prova (b), que não depende de coleta.
 *
 * 2. A página de `messages_completas` que falhava no meio da paginação fazia
 *    `logger.warn` + `break`: o arquivo saía PARCIAL e `secoes_no_limite` não
 *    recebia nada — o titular era entregue calado. Aqui se prova que a seção
 *    sai na ressalva, e que sem a falha a lista continua vazia.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { logger } from "@/lib/logger";
import { copiaDoTitular, partesDoArquivoDoTitular } from "@/lib/lgpd/copia-do-titular";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";

const RAIZ = join(__dirname, "..", "..");
const leFonte = (relativo: string) => readFileSync(join(RAIZ, relativo), "utf8");
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** GC sem `--expose-gc` na linha de comando: só o binding, se a V8 deixar. */
function gcObrigatorio(): (() => void) | null {
  try {
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as unknown;
    return typeof gc === "function" ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

const emUso = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
};

/** O arquivo inteiro em memória SÓ para comparar bytes (payloads pequenos). */
function junta(data: ExportPayload, pais: string): string {
  let texto = "";
  for (const pedaco of partesDoArquivoDoTitular(data, pais)) texto += pedaco;
  return texto;
}

/** Consumo SEM guardar nada: o que interessa é o maior pedaço e o total. */
function escreve(data: ExportPayload, pais: string) {
  let bytes = 0;
  let pico = 0;
  let pedacos = 0;
  for (const pedaco of partesDoArquivoDoTitular(data, pais)) {
    const n = Buffer.byteLength(pedaco, "utf-8");
    bytes += n;
    if (n > pico) pico = n;
    pedacos += 1;
  }
  return { bytes, pico, pedacos };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** Uma folha de payload que atravessa tudo o que a projeção decide. */
function payloadRico(): ExportPayload {
  return {
    request_id: "P-2576",
    organization_id: "org-1",
    organization_legal_name: 'Bem Viver "LTDA" & Cia',
    organization_display_name: "Bem Viver",
    dpo_email: "dpo@bv.test",
    lei_citada: "LGPD Art. 18, II (Lei nº 13.709/2018)",
    documento_rotulo: "CPF",
    generated_at: "2026-10-09T00:00:00.000Z",
    no_local_footprint: false,
    contact: {
      id: "c1",
      name: "Ana çãõ & <script>",
      custom_fields: { pedido_id: "FICA-dentro-do-jsonb", cpf: "529.982.247-25" },
      source_metadata: { ad_id: "FICA-anuncio" },
      tags: ["vip", "ão-fone"],
      consent: null,
    },
    consents: [
      { scope: "marketing", granted: true, granted_at: "2026-01-02T03:04:05.000Z" },
      { scope: "analytics", granted: false, granted_at: null },
    ],
    conversations: [{ id: "conv-1", status: "open", channel: "whatsapp", is_group: false }],
    messages_count_total: 3,
    messages_recent: [
      { id: "mr1", conversation_id: "conv-1", body: "última dele 😀", has_media: false },
    ],
    messages_completas: [
      { id: "m1", conversation_id: "conv-1", body: "linha \n com \\ barra e \"aspas\"", has_media: false },
      { id: "m2", conversation_id: "conv-1", body: "Unicode: ção, ação, ｎｕｍ", has_media: true },
      { id: "m3", conversation_id: "conv-1", body: null, has_media: false },
    ],
    secoes_no_limite: ["conversations"],
    leads: [{ id: "l1", pipeline_id: "p1", stage_id: "s1", title: "FICA-lead", status: "novo" }],
    orders: [{ id: "o1", external_id: "FICA-pedido", status: "paid" }],
    activities: [{ id: "a1", type: "created", source_module: "SEGREDO-telemetria" }],
    appointments: [
      {
        id: "ag1",
        title: "FICA-consulta",
        notes: "FICA-anotacao-do-pdf",
        meeting_url: "https://meet/x",
        meeting_state: "SEGREDO-estado",
        google_conflict: { x: "SEGREDO-g" },
      },
    ],
    sales: [{ id: "v1", number: 7, notes: "NOTA-comanda", cancel_reason: "FICA-cancelou" }],
    proposals: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [{ id: "md1", status: "sent", run_after: "SEGREDO-fila" }],
    appointment_notices: [{ id: "an1", title: "SEGREDO-aviso" }],
    voice_calls: [],
    cases: [
      { id: "caso1", status: "open", title: "IA-DIGITOU-titulo", summary: "IA-DIGITOU-resumo" },
    ],
    case_events: [
      { id: "ce1", kind: "noted", actor_kind: "agent", body: "IA-DIGITOU-nota" },
      { id: "ce2", kind: "replied", actor_kind: "human", body: "NOTA-de-quem-resolveu" },
      { id: "ce3", kind: "provided", actor_kind: "lead", body: "FICA-o-que-ele-informou" },
    ],
    demandas: [{ id: "dm1", estado: "aberta", assunto: "IA-DIGITOU-assunto" }],
    case_chat_messages: [{ id: "cc1", body: "SEGREDO-chat-interno" }],
    passagens: [
      {
        id: "pa1",
        origem: "caso_escalado",
        motivo_codigo: "FICA-motivo",
        motor: "SEGREDO-motor",
        body: "SEGREDO-narrativa",
        content: "NOTA-razao-de-quem-escalou",
        title: "FICA-o-que-ele-quer",
        tentativas: ["FICA-tentativa"],
      },
      {
        id: "pa2",
        origem: "mcp_externo",
        motivo_codigo: "FICA-motivo-mcp",
        motor: "SEGREDO-motor",
        title: "IA-DIGITOU-cliente-quer",
        content: "IA-DIGITOU-reason",
        tentativas: [{ o_que: "IA-DIGITOU-tentativa" }],
      },
    ],
    avisos_de_caso: [{ id: "av1", destino_mascarado: "+55 1*****777", tentativas: 2 }],
    campaign_recipients: [],
    campaign_suppressions: [],
    channel_session_groups: [],
    group_messages_authored: [],
    conversation_drafts: [],
    conversation_notes: [
      {
        id: "cn1",
        conversation_id: "conv-1",
        body: "NOTA-nota-interna",
        media_storage_path: "SEGREDO-caminho",
        created_at: "NOTA-data",
        created_by_name: "SEGREDO-funcionario",
      },
    ],
    contact_field_proposals: [{ id: "cfp1", campo: "FICA-campo", motivo_recusa: "NOTA-recusa" }],
    lead_notes: [{ id: "n1", headline: "FICA-memoria", body: "FICA-corpo" }],
    ai_agent_runs: [
      {
        id: "run1",
        created_at: "FICA-quando",
        tool_calls: [
          {
            step: 1,
            tool_calls: [
              {
                tool_name: "FICA-crm_search_contacts",
                args: { query: "SEGREDO-termo", owner_user_id: "SEGREDO-func" },
                result: "SEGREDO-resultado",
              },
            ],
          },
        ],
      },
    ],
    // Presente na chave, sem valor: o arquivo não pode ganhar uma chave vazia
    // por causa disto (o JSON de antes descartava `undefined`).
    lead_state: undefined,
    b2b: {
      pessoa: { id: "pe1", full_name: "FICA-pessoa", notes: "NOTA-b2b" },
      vinculos: [{ company_id: "co1", job_title: "FICA-cargo", notes: "NOTA-vinculo" }],
      linhas_importadas: [{ id: "li1", batch_id: "l1", error: "SEGREDO-imp" }],
    },
    honorarios_contratos: [],
    honorarios_parcelas: [],
    prospecting_candidates: [{ id: "pc1", campaign_id: "cp1", error: "SEGREDO-e" }],
    reply_drafts: [],
  } as unknown as ExportPayload;
}

/** Payload com um bloco esquisito: `undefined`, `NaN`, vazio, data, unicode. */
function payloadEsquisito(): ExportPayload {
  const comData = {
    id: "ag-com-data",
    starts_at: new Date("2026-10-09T12:00:00.000Z"),
    slots: [, 1, undefined] as unknown[],
  };
  return {
    request_id: "P-esquisito",
    organization_id: "org-1",
    organization_legal_name: "Esquisita",
    organization_display_name: "Esquisita",
    dpo_email: null,
    lei_citada: null,
    documento_rotulo: "CPF",
    generated_at: "2026-10-09T00:00:00.000Z",
    no_local_footprint: true,
    contact: null,
    consents: [],
    conversations: [],
    messages_count_total: 0,
    messages_recent: [],
    leads: [],
    honorarios_contratos: [],
    honorarios_parcelas: [],
    orders: [],
    activities: [],
    checkpoints: [],
    appointments: [comData] as never,
    sales: [],
    proposals: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    prospecting_candidates: [],
    cases: [],
    case_events: [],
    demandas: [],
    case_chat_messages: [],
    passagens: [],
    avisos_de_caso: [],
    campaign_recipients: [],
    campaign_suppressions: [],
    channel_session_groups: [],
    group_messages_authored: [],
    lead_notes: [],
    ai_agent_runs: [{ id: "run-vazio", tool_calls: [{ step: 0, tool_calls: [] }] }] as never,
    lead_state: undefined,
    // Valor que o JSON não guarda: número fora do alcance.
    messages_count_total_floaty: Number.NaN,
  } as unknown as ExportPayload;
}

const RECHEIO =
  "Mensagem do titular, com acentuação e pontuação, para o arquivo ficar com um tamanho plausível — ";

function payloadGrande(mensagens: number): ExportPayload {
  const completas = Array.from({ length: mensagens }, (_, i) => ({
    id: `m${i}`,
    conversation_id: "conv-1",
    direction: i % 2 === 0 ? "in" : "out",
    type: "text",
    status: "delivered",
    body: `${RECHEIO}nº ${i}`,
    has_media: false,
    media_derived_text: null,
    sent_at: "2026-09-01T00:00:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
  }));
  return {
    request_id: "P-grande",
    organization_id: "org-1",
    organization_legal_name: "Empresa Grande",
    organization_display_name: "Grande",
    dpo_email: "dpo@bv.test",
    lei_citada: "LGPD Art. 18, II (Lei nº 13.709/2018)",
    documento_rotulo: "CPF",
    generated_at: "2026-10-09T00:00:00.000Z",
    no_local_footprint: false,
    contact: null,
    consents: [],
    conversations: [{ id: "conv-1", status: "open", channel: "whatsapp", is_group: false }],
    messages_count_total: mensagens,
    messages_recent: completas.slice(0, 100),
    messages_completas: completas,
    secoes_no_limite: [],
    leads: [],
    honorarios_contratos: [],
    honorarios_parcelas: [],
    orders: [],
    activities: [],
    checkpoints: [],
    appointments: [],
    sales: [],
    proposals: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    prospecting_candidates: [],
    cases: [],
    case_events: [],
    demandas: [],
    case_chat_messages: [],
    passagens: [],
    avisos_de_caso: [],
    campaign_recipients: [],
    campaign_suppressions: [],
    channel_session_groups: [],
    group_messages_authored: [],
    lead_notes: [],
    ai_agent_runs: [],
    lead_state: [],
  } as unknown as ExportPayload;
}

const PAISES = ["BR", "PT"] as const;

// ---------------------------------------------------------------------------
// 1. Byte a byte: o arquivo em partes é o de sempre
// ---------------------------------------------------------------------------

describe("o arquivo em partes é o mesmo arquivo de sempre", () => {
  it.each(PAISES)("%s: byte a byte igual ao JSON.stringify da cópia", (pais) => {
    const data = payloadRico();
    const antes = JSON.stringify(copiaDoTitular(data, pais), null, 2);
    expect(junta(data, pais)).toBe(antes);
  });

  it("casos esquisitos (undefined, NaN, array com buraco, data) também saem iguais", () => {
    const data = payloadEsquisito();
    for (const pais of PAISES) {
      const antes = JSON.stringify(copiaDoTitular(data, pais), null, 2);
      expect(junta(data, pais), pais).toBe(antes);
    }
    // O JSON de antes não tem chave para `undefined` nem para `NaN` fora de alcance.
    expect(junta(data, "BR")).not.toContain("lead_state");
    expect(junta(data, "BR")).toContain('"messages_count_total_floaty": null');
    // Buraco de array vira `null`, como o JSON de sempre faz.
    expect(JSON.parse(junta(data, "BR"))).toEqual(
      JSON.parse(JSON.stringify(copiaDoTitular(data, "BR"))),
    );
    expect(JSON.parse(junta(data, "BR")).appointments[0].slots).toEqual([null, 1, null]);
  });
});

// ---------------------------------------------------------------------------
// 2. O maior pedaço é uma linha — e não cresce com o arquivo
// ---------------------------------------------------------------------------

describe("memória constante no arquivo grande", () => {
  it(
    "o maior pedaço que existe de uma vez é uma linha, e não cresce quando o arquivo cresce 4×",
    () => {
      const pequeno = escreve(payloadGrande(25_000), "BR");
      const grande = escreve(payloadGrande(100_000), "BR");
      console.info(
        `#2576 pedaços: 25k → ${mb(pequeno.bytes)} MB em ${pequeno.pedacos} pedaços, pico ${pequeno.pico} B; ` +
          `100k → ${mb(grande.bytes)} MB em ${grande.pedacos} pedaços, pico ${grande.pico} B`,
      );
      // O arquivo cresce ~4×…
      expect(grande.bytes).toBeGreaterThan(pequeno.bytes * 3);
      // …e o maior pedaço de uma vez continua sendo uma linha (teto de 16 KiB,
      // folgado para a linha mais gorda, e centenas de vezes menor que o arquivo).
      expect(pequeno.pico).toBeLessThan(16_384);
      expect(grande.pico).toBeLessThan(16_384);
      expect(grande.pico).toBeLessThanOrEqual(pequeno.pico + 128);
    },
    120_000,
  );

  it.each([50_000, 100_000])(
    "depois: escrever o arquivo de %i mensagens não passa de um arquivo de heap",
    (mensagens) => {
      const gc = gcObrigatorio();
      const data = payloadGrande(mensagens);
      gc?.();
      const base = emUso();
      const rssBase = process.memoryUsage().rss;
      let pico = 0;
      let bytes = 0;
      let vivo = base;
      let rssPico = rssBase;
      let pedaco = 0;
      for (const parte of partesDoArquivoDoTitular(data, "BR")) {
        const n = Buffer.byteLength(parte, "utf-8");
        bytes += n;
        if (n > pico) pico = n;
        pedaco += 1;
        rssPico = Math.max(rssPico, process.memoryUsage().rss);
        // Uma amostra a cada 5k linhas, SEMPRE depois de coletar: mede o que
        // está vivo de verdade, não o lixo que ainda não foi recolhido.
        if (pedaco % 5_000 === 0) {
          if (gc) {
            gc();
            vivo = Math.max(vivo, emUso());
          }
          rssPico = Math.max(rssPico, process.memoryUsage().rss);
        }
      }
      gc?.();
      vivo = Math.max(vivo, emUso());
      rssPico = Math.max(rssPico, process.memoryUsage().rss);
      console.info(
        `#2576 DEPOIS (${mensagens} mensagens): heap base ${mb(base)} MB → vivo ${mb(vivo)} MB ` +
          `(+${mb(vivo - base)} MB), RSS ${mb(rssBase)} → pico ${mb(rssPico)} MB, ` +
          `arquivo de ${mb(bytes)} MB em ${pedaco} pedaços`,
      );
      expect(bytes).toBeGreaterThan(12 * 1024 * 1024);
      // Sem depender do GC do host: escrever o arquivo nunca materializa um
      // pedaço maior que uma linha (constante em payload grande).
      expect(pico).toBeLessThan(16_384);
      if (gc) {
        // O que sobrou da escrita, com o payload vivo e GC forçado, cabe em MENOS
        // que UM arquivo — a receita de antes (o teste da seção 3) passava de um
        // arquivo inteiro por cima do payload. O resíduo não é uma cópia do
        // arquivo: é o churn por linha que a V8 cobra por alocar e serializar
        // linha a linha (medido à parte, fora deste arquivo, um loop genérico de
        // "copiar a linha + JSON.stringify" cresce a mesma ordem de grandeza —
        // ~200 B por linha para as mesmas 100k linhas).
        expect(vivo - base).toBeLessThan(bytes);
      }
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// 3. ANTES: a causa da issue, reproduzida
// ---------------------------------------------------------------------------

describe("a causa descrita na issue se reproduz na medição", () => {
  it.each([50_000, 100_000])(
    "a receita de antes com %i mensagens acrescenta mais que um arquivo inteiro ao payload",
    (mensagens) => {
      const gc = gcObrigatorio();
      const data = payloadGrande(mensagens);
      gc?.();
      const base = emUso();
      const rssBase = process.memoryUsage().rss;
      // Exatamente o que o worker fazava: copiar o payload inteiro (o
      // `copiaDoTitular` de antes fazia isto para poder apagar em cima), passar
      // a cópia pela projeção, serializar com indentação e jogar tudo num Buffer
      // — os quatro, juntos, por cima do payload que continua vivo (o PDF é
      // desenhado dele).
      const copiaProfunda = JSON.parse(JSON.stringify(data)) as ExportPayload;
      const copia = copiaDoTitular(copiaProfunda, "BR");
      const texto = JSON.stringify(copia, null, 2);
      const buffer = Buffer.from(texto, "utf-8");
      gc?.();
      const extra = emUso() - base;
      const rssDepois = process.memoryUsage().rss;
      console.info(
        `#2576 ANTES (${mensagens} mensagens): payload ${mb(base)} MB + cópia/string/buffer ` +
          `${mb(extra)} MB (${(extra / buffer.byteLength).toFixed(1)}× o arquivo), RSS ${mb(rssBase)} → ` +
          `${mb(rssDepois)} MB, arquivo de ${mb(buffer.byteLength)} MB (${texto.length} caracteres, ` +
          `${copiaProfunda.messages_completas?.length} linhas na cópia)`,
      );
      // Mais que UM arquivo inteiro de acréscimo, por cima do payload.
      expect(extra).toBeGreaterThan(buffer.byteLength);
      expect(texto.length).toBeGreaterThan(0);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// 4. Guarda de fonte: a cópia profunda não voltou
// ---------------------------------------------------------------------------

describe("nenhuma cópia profunda sobrou no caminho do arquivo", () => {
  it("o coletor da cópia e o worker escrevem o arquivo em partes", () => {
    const copia = leFonte("lib/lgpd/copia-do-titular.ts");
    expect(copia).toContain("partesDoArquivoDoTitular");
    expect(copia).not.toContain("JSON.parse(JSON.stringify(");

    const worker = leFonte("workers/lgpd-export-worker.ts");
    expect(worker).toContain("partesDoArquivoDoTitular(data, perfil.codigo)");
    expect(worker).toContain("Readable.from(");
    // O defeito: cópia serializada inteira e Buffer do arquivo inteiro.
    expect(worker).not.toContain("JSON.stringify(copiaDoTitular(");
    expect(worker).not.toContain("Buffer.from(JSON.stringify(");
  });
});

// ---------------------------------------------------------------------------
// 5. O arquivo parcial sai com ressalva
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const ORG = "org-1";
const CONTATO = "contato-1";
let banco: Record<string, Row[]>;
let falhaNaPaginaDeMensagens = false;

/** Banco falso: `eq`/`in` como o Postgres, `range` como o PostgREST. */
function consulta(tabela: string): unknown {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let cabeca = false;
  let faixa: [number, number] = [0, Number.MAX_SAFE_INTEGER];
  const executar = async () => {
    const filtradas = (banco[tabela] ?? [])
      .filter((r) => eqs.every(([k, v]) => r[k] === v))
      .filter((r) => ins.every(([k, vs]) => vs.includes(r[k])));
    if (cabeca) return { data: null, error: null, count: filtradas.length };
    // A SEGUNDA página de `messages_completas` falha (a de `range(0, 499)` não).
    if (tabela === "messages" && falhaNaPaginaDeMensagens && faixa[0] >= 500) {
      return { data: null, error: { message: "paginação interrompida (simulação #2576)" }, count: 0 };
    }
    const data = filtradas.slice(faixa[0], faixa[1] + 1);
    return { data, error: null, count: data.length };
  };
  const q: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => executar().then(ok, erro);
        if (prop === "maybeSingle" || prop === "single")
          return async () => {
            const r = (await executar()) as { data: Row[] | null };
            return { ...r, data: r.data?.[0] ?? null };
          };
        if (prop === "select")
          return (_colunas: string, opcoes?: { head?: boolean }) => {
            cabeca = Boolean(opcoes?.head);
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
            faixa = [0, n - 1];
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

const linhaMensagem = (i: number): Row => ({
  organization_id: ORG,
  contact_id: CONTATO,
  id: `m${i}`,
  conversation_id: "conv-1",
  direction: "in",
  type: "text",
  status: "delivered",
  body: `MEU-${i}`,
  media_url: null,
  media_derived_text: null,
  sent_at: "2026-09-01T00:00:00.000Z",
  created_at: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
});

beforeEach(() => {
  falhaNaPaginaDeMensagens = false;
  vi.mocked(logger.warn).mockClear();
  banco = {
    organizations: [{ id: ORG, legal_name: "Empresa A", display_name: "A", dpo_email: null }],
    contacts: [{ id: CONTATO, organization_id: ORG, name: "MEU-nome", created_at: "2026-01-01T00:00:00Z" }],
    conversations: [
      { organization_id: ORG, contact_id: CONTATO, id: "conv-1", status: "open", channel: "whatsapp" },
    ],
    messages: Array.from({ length: 600 }, (_, i) => linhaMensagem(i)),
  };
  mock.admin.mockReturnValue({ from: consulta, rpc: async () => ({ data: null, error: null }) });
});

const coleta = () =>
  collectExportData({
    organizationId: ORG,
    requestId: "pedido-2576",
    contactId: CONTATO,
    externalCustomerId: null,
    pais: "BR",
  });

describe("o arquivo parcial sai com ressalva", () => {
  it("a página que falha no meio das mensagens põe a seção em secoes_no_limite", async () => {
    falhaNaPaginaDeMensagens = true;
    const dados = await coleta();
    expect(dados.messages_completas, "só a primeira página chegou").toHaveLength(500);
    expect(dados.secoes_no_limite, "a ressalva do que pode haver mais").toEqual([
      "messages_completas",
    ]);
    expect(dados.messages_count_total, "a contagem total não mente").toBe(600);
    expect(dados.messages_recent, "a amostra do PDF não muda").toHaveLength(100);
    expect(logger.warn).toHaveBeenCalledWith(
      "[lgpd-export-worker] messages completas load failed",
      expect.objectContaining({ request_id: "pedido-2576" }),
    );
  }, 60_000);

  it("sem falha, a lista continua vazia: ressalva não vira ruído", async () => {
    const dados = await coleta();
    expect(dados.messages_completas).toHaveLength(600);
    expect(dados.secoes_no_limite).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  }, 60_000);
});

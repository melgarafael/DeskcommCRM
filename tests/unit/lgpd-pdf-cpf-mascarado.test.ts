// @vitest-environment node
/**
 * O PDF DE ACESSO NÃO APONTA MAIS PARA UM ARQUIVO QUE O TITULAR NÃO RECEBE
 * (issue #2341).
 *
 * A linha do documento dizia "Informado na conversa (valor no arquivo de
 * dados)", mas o `data.json` fica no Storage e o e-mail não o entrega: quem
 * lia o relatório era mandado para um arquivo que não tem. A saída escolhida
 * (uma das duas da issue) foi imprimir o valor MASCARADO no próprio
 * `lib/lgpd/pdf-renderer.tsx`.
 *
 * Este arquivo REPROVA com o texto antigo: qualquer volta a "valor no arquivo
 * de dados" derruba o primeiro teste, e o valor bruto nunca pode aparecer.
 */
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";
import { mascaraCpf } from "@/lib/lgpd/mask";
import type { ExportPayload } from "@/lib/lgpd/export-collector";
import { camposLegiveis, perguntasDosGrafos } from "@/lib/lgpd/campos-personalizados";

/** O mesmo payload mínimo que `lgpd-pdf-campos-personalizados.test.ts` renderiza. */
function payload(): ExportPayload {
  return {
    request_id: "3f2a9c10-0000-4000-8000-000000000001",
    organization_id: "8c1d4e20-0000-4000-8000-000000000002",
    organization_legal_name: "Bem Viver Servicos Medicos LTDA",
    organization_display_name: "MARCA_DO_REVENDEDOR_NAO_USAR",
    lei_citada: "LGPD Art. 18, II (Lei nº 13.709/2018)",
    documento_rotulo: "CPF",
    dpo_email: "encarregado@bemviver.test",
    generated_at: "2030-01-02T13:05:00Z",
    no_local_footprint: false,
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
    appointments: [],
    sales: [],
    proposals: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    voice_calls: [],
    prospecting_candidates: [],
    cases: [],
    case_events: [],
    case_chat_messages: [],
    checkpoints: [],
    passagens: [],
    avisos_de_caso: [],
    demandas: [],
    campaign_recipients: [],
    campaign_suppressions: [],
    channel_session_groups: [],
    group_messages_authored: [],
    appointment_notices: [],
  };
}

/** O CPF de exemplo do repositório (529.982.247-25), como o roteiro grava. */
const CPF = "52998224725";
const CPF_MASCARADO = "***.***.*47-25";

function contato(custom_fields: Record<string, unknown>) {
  const { campos, cpfInformado } = camposLegiveis(
    custom_fields,
    perguntasDosGrafos([
      { nodes: [{ type: "collect", config: { key: "cpf", label: "Seu CPF", type: "cpf" } }] },
    ]),
  );
  return {
    id: "contato-1",
    name: "Lia",
    display_name: null,
    email: null,
    phone_number: "5531999990000",
    cpf_present: false,
    birthdate: null,
    is_blocked: false,
    is_anonymized: false,
    consent: null,
    tags: [],
    source: "whatsapp",
    source_metadata: null,
    created_at: "2030-01-02T13:05:00Z",
    last_activity_at: null,
    first_service_at: null,
    custom_fields,
    campos_legiveis: campos,
    cpf_informado_na_conversa: cpfInformado,
  };
}

async function rendered(data: ExportPayload) {
  const bytes = await renderLgpdPdf(data);
  const fonts =
    join(
      dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
      "standard_fonts",
    ) + sep;
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fonts });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return { text: pages.join("\n").replace(/\s+/g, " ") };
  } finally {
    await task.destroy();
  }
}

it("o PDF imprime o CPF mascarado e não aponta para o data.json (#2341)", async () => {
  const data = payload();
  data.contact = contato({ cpf: CPF }) as ExportPayload["contact"];
  const pdf = await rendered(data);

  expect(pdf.text).toContain(`Informado na conversa (${CPF_MASCARADO})`);
  // O ponteiro para o arquivo que o titular não recebe sumiu.
  expect(pdf.text).not.toContain("valor no arquivo de dados");
  expect(pdf.text).not.toContain("arquivo de dados");
  // O valor BRUTO não sai no relatório — só os 4 últimos dígitos, mascarados.
  expect(pdf.text).not.toContain(CPF);
});

it("sem valor nos campos, a frase sai sem ponteiro para arquivo nenhum", async () => {
  const data = payload();
  data.contact = contato({}) as ExportPayload["contact"];
  expect(data.contact?.cpf_informado_na_conversa).toBe(false);

  // A bandeira vinda do coletor, sem o valor em `custom_fields`: a frase não
  // pode voltar a mandar o titular para um arquivo que ele não tem.
  data.contact = { ...(data.contact ?? contato({})), cpf_informado_na_conversa: true } as never;
  const pdf = await rendered(data);
  expect(pdf.text).toContain("Informado na conversa");
  expect(pdf.text).not.toContain("valor no arquivo de dados");
  expect(pdf.text).not.toContain(CPF);
});

it("mascaraCpf: 4 últimos dígitos, e o bruto nunca", () => {
  expect(mascaraCpf(CPF)).toBe(CPF_MASCARADO);
  expect(mascaraCpf("529.982.247-25")).toBe(CPF_MASCARADO);
  // Curto demais para valer como prova: não imprime nada.
  expect(mascaraCpf("1234")).toBeNull();
  expect(mascaraCpf(null)).toBeNull();
  expect(mascaraCpf(CPF)).not.toContain(CPF);
});

/** Outro CPF válido (111.444.777-35): o de um responsável, ou de um paciente. */
const OUTRO_CPF = "11144477735";

it("duas chaves de CPF com valores diferentes: não imprime dígito de ninguém (#2355)", async () => {
  // A chave é o operador que escolhe; numa clínica, `cpf_responsavel` e `cpf`
  // convivem e o relatório não sabe qual delas é do titular.
  const data = payload();
  data.contact = contato({ cpf_responsavel: OUTRO_CPF, cpf: CPF }) as ExportPayload["contact"];
  const pdf = await rendered(data);

  expect(pdf.text).toContain("Informado na conversa (valor não disponível neste relatório)");
  expect(pdf.text).not.toContain("47-25");
  expect(pdf.text).not.toContain("77-35");
});

it("um campo sem dígitos (`tem_cpf: sim`) não esconde o CPF verdadeiro (#2355)", async () => {
  const data = payload();
  data.contact = contato({ tem_cpf: "sim", cpf: CPF }) as ExportPayload["contact"];
  const pdf = await rendered(data);

  expect(pdf.text).toContain(`Informado na conversa (${CPF_MASCARADO})`);
});

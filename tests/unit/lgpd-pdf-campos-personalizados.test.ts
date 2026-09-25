// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";
import type { ExportPayload } from "@/lib/lgpd/export-collector";
import { camposLegiveis, perguntasDosGrafos } from "@/lib/lgpd/campos-personalizados";

/**
 * O que o ROTEIRO de atendimento coletou mora em `contacts.custom_fields` — o
 * CPF inclusive. A anonimização já zera a coluna; o export do titular (Art. 18
 * II) deixava de fora, e o titular pedia acesso sem receber o que foi coletado.
 */

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
    orders: [],
    activities: [],
    appointments: [],
    sales: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [
      {
        id: "envio-pendente",
        appointment_id: "compromisso-confirmado",
        status: "pending",
        created_at: "2030-01-02T13:05:00Z",
        run_after: "2030-01-03T14:00:00Z",
      },
      {
        id: "envio-concluido",
        appointment_id: null,
        status: "done",
        created_at: "2030-01-02T13:05:00Z",
        run_after: "2030-01-03T14:00:00Z",
      },
    ],
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
  appointment_notices: [
      {
        id: "aviso-aberto",
        ref_id: "compromisso-confirmado",
        title: "Reagendar consulta",
        body: "Paciente pediu outro horario.",
        status: "open",
        created_at: "2030-01-02T13:05:00Z",
        resolved_at: null,
      },
      {
        id: "aviso-resolvido",
        ref_id: null,
        title: "Horario confirmado",
        body: null,
        status: "resolved",
        created_at: "2030-01-02T13:05:00Z",
        resolved_at: "2030-01-03T14:00:00Z",
      },
    ],
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
    return { bytes, pages: document.numPages, text: pages.join("\n").replace(/\s+/g, " ") };
  } finally {
    await task.destroy();
  }
}

it("o PDF lista as respostas pelo rótulo da pergunta, e o CPF só na linha do documento", async () => {
  const data = payload();
  const custom_fields = { cpf: "52998224725", modelo_interesse: "XRE 300", cidade_natal: "Uberaba" };
  const { campos, cpfInformado } = camposLegiveis(
    custom_fields,
    perguntasDosGrafos([
      {
        nodes: [
          { type: "collect", config: { key: "cpf", label: "Seu CPF", type: "cpf" } },
          { type: "collect", config: { key: "modelo_interesse", label: "Qual modelo te interessa?", type: "select" } },
        ],
      },
    ]),
  );
  data.contact = {
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
  const pdf = await rendered(data);
  for (const valor of [
    "Respostas e campos personalizados",
    "Qual modelo te interessa?",
    "XRE 300",
    // Chave sem pergunta conhecida: legível, não técnica.
    "Cidade natal",
    "Uberaba",
    "Informado na conversa",
  ])
    expect(pdf.text).toContain(valor);
  for (const valor of ["modelo_interesse", "cidade_natal", "52998224725", "Seu CPF"]) expect(pdf.text).not.toContain(valor);
});

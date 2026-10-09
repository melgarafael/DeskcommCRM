// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";
import type { ExportPayload } from "@/lib/lgpd/export-collector";

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

function mensagem(id: string, texto: string | null): ExportPayload["messages_recent"][number] {
  return {
    id,
    conversation_id: "conv-a",
    direction: "inbound",
    type: "audio",
    status: "delivered",
    body: null,
    has_media: true,
    media_derived_text: texto,
    sent_at: "2030-01-02T13:05:00Z",
    created_at: "2030-01-02T13:05:00Z",
  };
}

// LGPD Art. 18 II (#1990): a transcrição/OCR da mídia entra no relatório, nos
// dois blocos que listam mensagens. O payload é provado em
// lgpd-export-transcricao.test.ts; aqui, a linha que o titular lê no PDF.
it("PDF mostra a transcrição da mídia nas mensagens do titular e nas de grupo", async () => {
  const data = payload();
  data.messages_recent = [mensagem("msg-audio", "TRANSCRICAO-DO-TITULAR")];
  data.group_messages_authored = [mensagem("msg-grupo", "TRANSCRICAO-NO-GRUPO")];
  const pdf = await rendered(data);
  expect(pdf.text).toContain("transcrição/texto extraído da mídia: TRANSCRICAO-DO-TITULAR");
  expect(pdf.text).toContain("transcrição/texto extraído da mídia: TRANSCRICAO-NO-GRUPO");
});

it("PDF não imprime o rótulo quando a mídia não tem transcrição", async () => {
  const data = payload();
  data.messages_recent = [mensagem("msg-audio", null)];
  const pdf = await rendered(data);
  expect(pdf.text).toContain("[mídia]");
  expect(pdf.text).not.toContain("transcrição/texto extraído da mídia");
});

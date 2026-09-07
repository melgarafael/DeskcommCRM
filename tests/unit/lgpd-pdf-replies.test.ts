// @vitest-environment node
import { writeFileSync } from "node:fs";
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

it("PDF entregue inclui revisão pessoal e omite contexto privado", async () => {
  const data = payload();
  data.reply_drafts = [
    {
      id: "draft-pessoal",
      status: "sent",
      original_body: "Sugestão original pessoal",
      edited_body: "Texto corrigido pessoal",
      approved_body: "Texto aprovado pessoal",
      feedback: { decision: "corrected", note: "Preferência por resposta breve" },
      proposals: [{ tool: "save_lead_note", args: { body: "Preferência pessoal" } }],
      created_at: "2030-01-02T13:05:00Z",
    },
  ];
  Object.assign(data.reply_drafts[0]!, {
    job_claim: "CLAIM-PRIVADO",
    service_boundary: "FRONTEIRA-PRIVADA",
    trace: "TRACE-PRIVADO",
  });
  const pdf = await rendered(data);
  for (const value of [
    "Sugestões e respostas revisadas",
    "Sugestão original pessoal",
    "Texto corrigido pessoal",
    "Texto aprovado pessoal",
    "Preferência por resposta breve",
    "Preferência pessoal",
  ])
    expect(pdf.text).toContain(value);
  for (const value of ["CLAIM-PRIVADO", "FRONTEIRA-PRIVADA", "TRACE-PRIVADO"])
    expect(pdf.text).not.toContain(value);
});

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

it("PDF efetivamente entregue contém registros, datas, estados e controlador sem material privado", async () => {
  const data = payload();
  Object.assign(data.meeting_deliveries[0]!, {
    payload: { authorization: "SEGREDO-DO-JOB" },
    locked_by: "CLAIM-PRIVADO",
  });
  const pdf = await rendered(data);
  for (const value of [
    "Entregas de links de reunião",
    "Avisos sobre compromissos",
    "envio-pendente",
    "envio-concluido",
    "compromisso-confirmado",
    "Pendente",
    "Processamento concluído",
    "aviso-aberto",
    "aviso-resolvido",
    "Reagendar consulta",
    "Paciente pediu outro horario.",
    "Horario confirmado",
    "Aberto",
    "Resolvido",
    "02/01/2030",
    "03/01/2030",
    "Controlador: Bem Viver Servicos Medicos LTDA",
    "encarregado@bemviver.test",
  ])
    expect(pdf.text).toContain(value);
  for (const value of [
    "SEGREDO-DO-JOB",
    "CLAIM-PRIVADO",
    "MARCA_DO_REVENDEDOR_NAO_USAR",
    "Link enviado",
    "DeskcommCRM",
  ])
    expect(pdf.text).not.toContain(value);
  // Artefatos opcionais do runner; o teste funciona em qualquer checkout/CI.
  const evidence = process.env.MEET_PDF_EVIDENCE_PATH;
  if (evidence) {
    writeFileSync(evidence, pdf.bytes);
    writeFileSync(`${evidence}.txt`, pdf.text);
  }
});

it("arrays vazios ou ausentes em payload legado não criam seções nem quebram o PDF", async () => {
  for (const arrays of [[], undefined]) {
    const data = {
      ...payload(),
      no_local_footprint: true,
      meeting_deliveries: arrays,
      appointment_notices: arrays,
    } as unknown as ExportPayload;
    const pdf = await rendered(data);
    expect(pdf.text).toContain("Controlador: Bem Viver Servicos Medicos LTDA");
    expect(pdf.text).not.toContain("Entregas de links de reunião");
    expect(pdf.text).not.toContain("Avisos sobre compromissos");
  }
});

it("quebra de páginas conserva todos os avisos e o controlador nas páginas seguintes", async () => {
  const data = payload();
  data.appointment_notices = Array.from({ length: 24 }, (_, n) => ({
    ...data.appointment_notices[0]!,
    id: `registro-${n}`,
    title: `AVISO-PESSOAL-${n}-FIM`,
    body: "Observacao pessoal sobre a consulta. ".repeat(18),
  }));
  const pdf = await rendered(data);
  expect(pdf.pages).toBeGreaterThan(1);
  for (const notice of data.appointment_notices) expect(pdf.text).toContain(notice.title);
  expect(pdf.text.match(/Controlador: Bem Viver Servicos Medicos LTDA/g)).toHaveLength(pdf.pages);
});

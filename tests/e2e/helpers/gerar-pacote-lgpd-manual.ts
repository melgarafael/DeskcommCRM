/**
 * Prepara SOMENTE o pedido próprio da prova: worker, coletor, PDF, projeção,
 * PostgREST e Storage reais. Não usa o dreno global nem transporte de e-mail.
 * A marca de aprovação é fixture declarada; não prova o clique de aprovação.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { EventRow } from "../../../lib/event-log/dispatcher";

const argumento = process.argv.indexOf("--gerar-pacote-manual");
if (argumento >= 0) {
  const executar = async () => {
    const local = (valor: string) =>
      ["127.0.0.1", "localhost"].includes(new URL(valor).hostname);
    if (
      !local(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://invalid.example")
    ) {
      throw new Error("A prova exige o Supabase local do harness.");
    }
    const entrada = z
      .object({ org: z.uuid(), pedido: z.uuid(), aprovador: z.uuid() })
      .parse(JSON.parse(process.argv[argumento + 1] ?? "null"));
    const fetchLocal = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!local(url))
        throw new Error("A prova não pode chamar um destino externo.");
      return fetchLocal(input, init);
    };
    const { processLgpdExport } =
      await import("../../../workers/lgpd-export-worker");
    const evento: EventRow = {
      id: randomUUID(),
      organization_id: entrada.org,
      event_type: "lgpd.data_request_received",
      entity_kind: "lgpd_request",
      entity_id: entrada.pedido,
      payload: {
        request_id: entrada.pedido,
        manually_approved: true,
        approved_by: entrada.aprovador,
      },
      metadata: { fixture: "pacote-manual-3543" },
      consumed_by: [],
      attempts: 0,
      created_at: new Date().toISOString(),
    };
    const resultado = await processLgpdExport(evento);
    if (
      resultado.status !== "ok" ||
      resultado.detail !== "pending_review_no_email"
    ) {
      throw new Error("O worker não gerou o pacote manual esperado.");
    }
    process.stdout.write(
      `LGPD_MANUAL_PROOF=${JSON.stringify({ status: resultado.status, detail: resultado.detail })}\n`,
    );
  };
  void executar().catch(() => {
    process.stderr.write("Falha na preparação do pacote manual sintético.\n");
    process.exitCode = 1;
  });
}

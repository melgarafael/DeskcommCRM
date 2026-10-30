import { describe, expect, it } from "vitest";

import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

/**
 * A REGRA PURA DO ROTEAMENTO COM PESSOA RELACIONADA (#3669, fatia 1).
 *
 * `emitAgentActivityForContact` passa a trazer, além dos negócios em que o
 * contato é o PRINCIPAL, os negócios em que ele está na lista "Pessoas
 * relacionadas" (`via: "relacionado"`). Quem decide é esta função, e a regra
 * cabe numa frase: o principal sempre vence; o relacionado só conta quando não
 * há nenhum negócio aberto como principal.
 *
 * A asserção que mais importa é a do controle: um candidato SEM `via` (todo
 * chamador anterior a este campo) se comporta como principal — senão a mudança
 * mexeria em quem nunca ligou ninguém a negócio nenhum.
 */
const ORG = "org-a";
const PADRAO = "pipe-padrao";

const lead = (over: Partial<LeadCandidate> & { id: string }): LeadCandidate => ({
  organization_id: ORG,
  pipeline_id: PADRAO,
  status: "open",
  last_activity_at: "2026-10-20T10:00:00.000Z",
  created_at: "2026-10-01T10:00:00.000Z",
  ...over,
});

const opts = { defaultPipelineId: PADRAO };

describe("resolveActiveLeadForContact — pessoa relacionada", () => {
  it("⭐ só como relacionado: a atividade vai para o negócio do cliente", () => {
    expect(resolveActiveLeadForContact([lead({ id: "do-cliente", via: "relacionado" })], opts)).toEqual({
      routed: true,
      leadId: "do-cliente",
    });
  });

  it("⭐ o principal vence o relacionado, mesmo o relacionado sendo o mais recente", () => {
    const r = resolveActiveLeadForContact(
      [
        lead({ id: "do-cliente", via: "relacionado", last_activity_at: "2026-10-29T10:00:00.000Z" }),
        lead({ id: "proprio", via: "principal", last_activity_at: "2026-10-01T10:00:00.000Z" }),
      ],
      opts,
    );
    expect(r).toEqual({ routed: true, leadId: "proprio" });
  });

  it("principal FECHADO não conta: o relacionado aberto recebe", () => {
    const r = resolveActiveLeadForContact(
      [
        lead({ id: "proprio-ganho", via: "principal", status: "won" }),
        lead({ id: "do-cliente", via: "relacionado" }),
      ],
      opts,
    );
    expect(r).toEqual({ routed: true, leadId: "do-cliente" });
  });

  it("dois clientes ligaram a mesma pessoa, tocados no mesmo instante: ambíguo, não chuta", () => {
    const r = resolveActiveLeadForContact(
      [lead({ id: "cliente-a", via: "relacionado" }), lead({ id: "cliente-b", via: "relacionado" })],
      opts,
    );
    expect(r).toEqual({
      routed: false,
      reason: "ambiguous_open_leads",
      candidateIds: ["cliente-a", "cliente-b"],
    });
  });

  it("o mesmo negócio como principal E relacionado conta uma vez — não empata consigo mesmo", () => {
    const r = resolveActiveLeadForContact(
      [lead({ id: "l-1", via: "relacionado" }), lead({ id: "l-1", via: "principal" })],
      opts,
    );
    expect(r).toEqual({ routed: true, leadId: "l-1" });
  });

  it("controle: candidato sem `via` é principal — chamador antigo não muda", () => {
    const r = resolveActiveLeadForContact(
      [lead({ id: "antigo" }), lead({ id: "do-cliente", via: "relacionado" })],
      opts,
    );
    expect(r).toEqual({ routed: true, leadId: "antigo" });
  });
});

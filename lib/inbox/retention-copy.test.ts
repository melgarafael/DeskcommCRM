import { describe, expect, it } from "vitest";
import { retentionCopy, type RetentionContext } from "./retention-copy";

const ctx: RetentionContext = {
  window_start_hour: 8,
  window_end_hour: 21,
  allow_sunday: false,
  timezone: "America/Sao_Paulo",
};

describe("retentionCopy — tradução leiga dos vetos before_send", () => {
  it("distingue janela configurada de proteção de volume", () => {
    const r = retentionCopy("outside_window", ctx);
    expect(r.kind).toBe("window");
    expect(r.description).toContain("8h–21h");
    expect(r.description).toContain("sem domingo");
    expect(retentionCopy("mass_identical", ctx).kind).toBe("protection");
  });

  it("classifica stop/LGPD como conformidade", () => {
    expect(retentionCopy("contato_bloqueado", ctx).kind).toBe("compliance");
    expect(retentionCopy("lgpd_anonymized", ctx).kind).toBe("compliance");
    expect(retentionCopy("lgpd_missing_legal_basis", ctx).kind).toBe("compliance");
  });

  it("classifica promise/disclosure como qualidade", () => {
    expect(retentionCopy("promise_out_of_table", ctx).kind).toBe("quality");
    expect(retentionCopy("promise_semantic", ctx).kind).toBe("review");
    expect(retentionCopy("disclosure_required", ctx).kind).toBe("quality");
  });

  it("código/origem desconhecidos ficam neutros sem atribuir proteção", () => {
    expect(retentionCopy(null, ctx).kind).toBe("neutral");
    const unknown = retentionCopy("gate_novo_do_engine", ctx);
    expect(unknown.kind).toBe("neutral");
    expect(unknown.description).toContain("origem do bloqueio não foi identificada");
  });

  it("respeita allow_sunday=true na copy da janela", () => {
    const r = retentionCopy("outside_window", { ...ctx, allow_sunday: true });
    expect(r.description).not.toContain("sem domingo");
  });
});

it('usa o gate semântico registrado e não promete recuperação ou reserva',()=>{
 const r=retentionCopy('agenda_request_mismatch',ctx,undefined,'semantic_promise');
 expect(r).toMatchObject({kind:'review',title:'Resposta bloqueada pela revisão da IA'});
 expect(r.description).toContain('não conseguiu validar');
 expect(r.description).not.toMatch(/será|agendada|automaticamente|agente errou|reserva existe/i);
 expect(retentionCopy('codigo_novo',ctx,undefined,'semantic_promise').kind).toBe('review');
 expect(retentionCopy('warmup_cap',ctx,undefined,'origem_nova').kind).toBe('neutral');
 expect(retentionCopy('warmup_cap',ctx,undefined,'pacing').kind).toBe('protection');
 expect(retentionCopy('contato_bloqueado',ctx,undefined,'stop').kind).toBe('compliance');
});

it.each(['agenda_review_context_incomplete','agenda_review_inconclusive','agenda_review_candidate_misbound'])
('falha técnica %s tem origem neutra, sem acusação semântica ou promessa',code=>{
 const r=retentionCopy(code,ctx,undefined,'semantic_promise');
 expect(r).toMatchObject({kind:'neutral',title:'Resposta não enviada por falha na revisão'});
 expect(r.description).not.toMatch(/agente errou|cliente errou|reserva existe|automaticamente|será enviada/i);
 expect(retentionCopy(code,ctx,undefined,'origem_nova').kind).toBe('neutral');
 expect(retentionCopy('warmup_cap',ctx,undefined,'pacing').title).toBe('Resposta segurada pela proteção do número');
 expect(retentionCopy('agenda_request_mismatch',ctx,undefined,'semantic_promise').kind).toBe('review');
});

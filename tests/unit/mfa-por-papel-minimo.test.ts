/**
 * O SEGUNDO FATOR POR NÍVEL MÍNIMO DE PAPEL (#1533) — e, junto, os dois
 * controles que impedem a mudança de virar uma mudança de comportamento.
 *
 * A regra antiga era um booleano com um ramo só: `role === "admin" &&
 * empresaExige`. O corpo da issue pede uma regra pura de TRÊS saídas —
 * `exige` (a política alcança esta pessoa), `bloqueia` (o prazo acabou, pode
 * travar a tela) e `prazoAte` (a carência, quando ainda corre) — porque
 * "preciso cadastrar" e "posso bloquear agora" deixaram de ser a mesma frase:
 * entre uma e outra existe `mfa_grace_days`.
 *
 * Os dois casos com "controle" no nome são o registro histórico de
 * `lib/auth/politica-mfa.ts:4-18`: o padrão é NÃO exigir, porque o `install.sh`
 * cria o dono como platform admin e toda instalação terminava o assistente num
 * bloqueio de tela inteira. Sem eles, um dia de pressa transforma "dar a
 * organização a opção de ir além" em "toda organização exige".
 */
import { describe, expect, it } from "vitest";

import {
  avaliaPoliticaDeMfa,
  politicaDaEmpresa,
  type PoliticaDeMfa,
} from "@/lib/auth/politica-mfa";

/** Só o que a regra pura precisa receber — sem I/O, sem banco, sem data real. */
const BASE: PoliticaDeMfa = {
  role: "agent",
  isPlatformAdmin: false,
  plataformaExige: null,
  empresaExige: false,
};

const SEM_CONFIG: PoliticaDeMfa = { ...BASE, role: "admin" };

describe("avaliaPoliticaDeMfa — papel mínimo da organização", () => {
  it("min_role 'agent': o agent é obrigado, o viewer não", () => {
    // O caso que só existe depois da mudança — vermelho antes dela.
    const agent = avaliaPoliticaDeMfa({ ...BASE, role: "agent", papelMinimo: "agent" });
    expect(agent.exige).toBe(true);
    // Sem carência configurada, a obrigação BLOQUEIA na hora: é o mesmo
    // comportamento de `mfa_required: true` hoje.
    expect(agent.bloqueia).toBe(true);
    expect(agent.prazoAte).toBeNull();

    const viewer = avaliaPoliticaDeMfa({ ...BASE, role: "viewer", papelMinimo: "agent" });
    expect(viewer.exige).toBe(false);
    expect(viewer.bloqueia).toBe(false);
    expect(viewer.prazoAte).toBeNull();
  });

  it("o papel mínimo alcança todo mundo ACIMA dele, não só o nível exato", () => {
    for (const role of ["agent", "manager", "admin"] as const) {
      const r = avaliaPoliticaDeMfa({ ...BASE, role, papelMinimo: "agent" });
      expect(r.exige, role).toBe(true);
      expect(r.bloqueia, role).toBe(true);
    }
  });

  it("min_role 'admin' reproduz o recorte de hoje: só admin", () => {
    for (const role of ["manager", "agent", "viewer"] as const) {
      expect(avaliaPoliticaDeMfa({ ...BASE, role, papelMinimo: "admin" }).exige, role).toBe(false);
    }
    expect(avaliaPoliticaDeMfa({ ...BASE, role: "admin", papelMinimo: "admin" }).exige).toBe(true);
  });

  it("min_role 'none' não alcança ninguém, mesmo com mfa_required legado ligado", () => {
    // Escrita nova e legado convivendo no mesmo `settings.security`: quem
    // escolheu "não exigir" tem prioridade sobre o booleano antigo.
    expect(
      avaliaPoliticaDeMfa({ ...BASE, role: "admin", papelMinimo: "none", empresaExige: true }).exige,
    ).toBe(false);
  });

  it("`ai_operator` fica de fora — ele nunca é papel de `user_organizations`", () => {
    // Com min_role 'agent' o rank dele (3) passaria na comparação. Não pode:
    // é o papel do agente publicado, do escopo do token, e nenhuma PESSOA o tem.
    expect(avaliaPoliticaDeMfa({ ...BASE, role: "ai_operator", papelMinimo: "agent" }).exige).toBe(
      false,
    );
  });

  it("sem papel resolvido, não cobra por papel", () => {
    expect(
      avaliaPoliticaDeMfa({ ...BASE, role: undefined, papelMinimo: "agent" }).exige,
    ).toBe(false);
  });

  it("CONTROLE — organização sem nenhuma configuração continua NÃO exigindo", () => {
    // É o estado de TODAS as organizações que já existem: `settings` sem
    // `security`. Se este caso virar `true`, a onda inteira passa a exigir
    // TOTP de todo mundo de uma vez.
    for (const role of ["admin", "manager", "agent", "viewer"] as const) {
      const r = avaliaPoliticaDeMfa({ ...SEM_CONFIG, role });
      expect(r.exige, role).toBe(false);
      expect(r.bloqueia, role).toBe(false);
      expect(r.prazoAte, role).toBeNull();
    }
    expect(avaliaPoliticaDeMfa({ ...SEM_CONFIG, role: undefined }).exige).toBe(false);
  });

  it("CONTROLE — mfa_required true SEM min_role continua exigindo do admin, como hoje", () => {
    // Compatibilidade obrigatória: `mfa_required: true` sem a chave nova é
    // lido como min_role 'admin'. Nada muda para quem já ligou a caixa.
    expect(avaliaPoliticaDeMfa({ ...BASE, role: "admin", empresaExige: true })).toEqual({
      exige: true,
      bloqueia: true,
      prazoAte: null,
    });
    for (const role of ["manager", "agent", "viewer"] as const) {
      const r = avaliaPoliticaDeMfa({ ...BASE, role, empresaExige: true });
      expect(r.exige, role).toBe(false);
      expect(r.bloqueia, role).toBe(false);
    }
    expect(avaliaPoliticaDeMfa({ ...BASE, role: undefined, empresaExige: true }).exige).toBe(false);
  });
});

describe("avaliaPoliticaDeMfa — carência", () => {
  const AGORA = new Date("2026-10-01T12:00:00.000Z");
  const MUDOU = "2026-09-24T12:00:00.000Z"; // 7 dias antes de AGORA
  const ACEITOU = "2026-09-20T12:00:00.000Z";

  it("dentro do prazo: já EXIGE mas ainda NÃO bloqueia, e o prazo vem na resposta", () => {
    const r = avaliaPoliticaDeMfa({
      ...BASE,
      role: "agent",
      papelMinimo: "agent",
      diasDeCarencia: 7,
      mudouEm: MUDOU,
      aceitoEm: ACEITOU,
      agora: AGORA,
    });
    expect(r.exige).toBe(true);
    expect(r.bloqueia).toBe(false);
    // Âncora = max(mfa_policy_changed_at, accepted_at) + 7 dias.
    expect(r.prazoAte?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("o accepted_at mais novo da pessoa é quem ancora a carência dela", () => {
    const r = avaliaPoliticaDeMfa({
      ...BASE,
      role: "agent",
      papelMinimo: "agent",
      diasDeCarencia: 7,
      mudouEm: MUDOU,
      // Entrou na empresa 2 dias atrás: a carência dele começa na entrada.
      aceitoEm: "2026-09-29T12:00:00.000Z",
      agora: AGORA,
    });
    expect(r.bloqueia).toBe(false);
    expect(r.prazoAte?.toISOString()).toBe("2026-10-06T12:00:00.000Z");
  });

  it("depois do prazo, passa a bloquear", () => {
    const r = avaliaPoliticaDeMfa({
      ...BASE,
      role: "agent",
      papelMinimo: "agent",
      diasDeCarencia: 7,
      mudouEm: MUDOU,
      aceitoEm: ACEITOU,
      agora: new Date("2026-10-01T12:00:01.000Z"),
    });
    expect(r.exige).toBe(true);
    expect(r.bloqueia).toBe(true);
    expect(r.prazoAte).toBeNull();
  });

  it("carência 0 (ou ausente) é bloqueio imediato", () => {
    for (const dias of [0, undefined, null] as const) {
      const r = avaliaPoliticaDeMfa({
        ...BASE,
        role: "admin",
        papelMinimo: "admin",
        diasDeCarencia: dias,
        mudouEm: MUDOU,
        agora: AGORA,
      });
      expect(r.bloqueia, String(dias)).toBe(true);
      expect(r.prazoAte, String(dias)).toBeNull();
    }
  });

  it("a plataforma não tem carência: o platform admin bloqueia na hora", () => {
    // `platform_admins.mfa_required` não tem `mfa_policy_changed_at` nem
    // accepted_at — não há âncora onde pendurar uma carência, e inventar uma
    // seria dar ao tenant o poder de adiar a exigência da plataforma.
    expect(
      avaliaPoliticaDeMfa({
        ...BASE,
        role: "viewer",
        isPlatformAdmin: true,
        plataformaExige: true,
        diasDeCarencia: 30,
        mudouEm: MUDOU,
        agora: AGORA,
      }),
    ).toEqual({ exige: true, bloqueia: true, prazoAte: null });
  });

  it("carência sem âncora (sem mudouEm nem aceitoEm) não adia: bloqueia na hora", () => {
    // Carência que não sabe quando começou não tem como terminar — sem
    // âncora, a regra cai em exigir bloqueando, nunca em adiar para sempre.
    expect(
      avaliaPoliticaDeMfa({
        ...BASE,
        role: "agent",
        papelMinimo: "agent",
        diasDeCarencia: 7,
        agora: AGORA,
      }),
    ).toEqual({ exige: true, bloqueia: true, prazoAte: null });
  });

  it("CONTROLE — a carência legada não muda: mfa_required true sem min_role bloqueia já", () => {
    expect(
      avaliaPoliticaDeMfa({
        ...BASE,
        role: "admin",
        empresaExige: true,
        diasDeCarencia: 0,
        aceitoEm: ACEITOU,
        agora: AGORA,
      }),
    ).toEqual({ exige: true, bloqueia: true, prazoAte: null });
  });
});

describe("politicaDaEmpresa — a leitura de `settings.security`", () => {
  it("sem a chave, devolve o padrão: ninguém obrigado e carência zero", () => {
    // Ausente é "não exige", exatamente como o `mfa_required` — se o default
    // fosse 'admin', toda organização existente passaria a exigir.
    expect(politicaDaEmpresa(null)).toEqual({ papelMinimo: null, diasDeCarencia: 0, mudouEm: null });
    expect(politicaDaEmpresa({})).toEqual({
      papelMinimo: null,
      diasDeCarencia: 0,
      mudouEm: null,
    });
    expect(politicaDaEmpresa({ security: {} })).toEqual({
      papelMinimo: null,
      diasDeCarencia: 0,
      mudouEm: null,
    });
    expect(politicaDaEmpresa({ llm: { provider: "anthropic" } })).toEqual({
      papelMinimo: null,
      diasDeCarencia: 0,
      mudouEm: null,
    });
  });

  it("lê as três chaves novas", () => {
    expect(
      politicaDaEmpresa({
        security: {
          mfa_required: true,
          mfa_required_min_role: "agent",
          mfa_grace_days: 7,
          mfa_policy_changed_at: "2026-09-24T12:00:00.000Z",
        },
      }),
    ).toEqual({
      papelMinimo: "agent",
      diasDeCarencia: 7,
      mudouEm: new Date("2026-09-24T12:00:00.000Z"),
    });
  });

  it("fora da lista de papéis vira o padrão, e a carência é cortada na faixa 0..30", () => {
    // `settings` é jsonb livre: nada impede uma escrita à mão de pôr lixo, e
    // lixo não pode virar obrigação de ninguém nem prazo infinito.
    expect(
      politicaDaEmpresa({ security: { mfa_required_min_role: "owner", mfa_grace_days: 99 } }),
    ).toEqual({ papelMinimo: null, diasDeCarencia: 30, mudouEm: null });
    expect(
      politicaDaEmpresa({ security: { mfa_required_min_role: "agent", mfa_grace_days: -3 } }),
    ).toEqual({ papelMinimo: "agent", diasDeCarencia: 0, mudouEm: null });
    expect(
      politicaDaEmpresa({
        security: { mfa_required_min_role: "agent", mfa_grace_days: 400, mfa_policy_changed_at: "ontem" },
      }),
    ).toEqual({ papelMinimo: "agent", diasDeCarencia: 30, mudouEm: null });
    expect(politicaDaEmpresa("nada")).toEqual({
      papelMinimo: null,
      diasDeCarencia: 0,
      mudouEm: null,
    });
  });

  it("mfa_required true SEM min_role continua legado: papelMinimo fica null (o fallback é da regra)", () => {
    // O fallback "true sem min_role = admin" mora na regra pura, não aqui:
    // esta leitura só diz o que está escrito.
    expect(politicaDaEmpresa({ security: { mfa_required: true } })).toEqual({
      papelMinimo: null,
      diasDeCarencia: 0,
      mudouEm: null,
    });
  });
});

/**
 * #3813 — "QUANDO O CONTATO TIVER HORÁRIO MARCADO": a escolha, a decisão e a
 * guarda.
 *
 * ═══ O defeito medido na main ═══
 *
 * A proteção de agenda adia TODO envio automático de quem tem compromisso
 * `pending`/`confirmed` (`lib/agenda/protecao-followup.ts:26`), sem escolha por
 * regra nem por fluxo — e um horário daqui a três meses já segura. Este arquivo
 * prova as três respostas e, principalmente, que a PADRÃO não mudou.
 *
 * ═══ O que este arquivo NÃO dubla ═══
 *
 * `protecaoAgendaSupabase` e a guarda (`assertAgendaEffectSupabase`) rodam DE
 * VERDADE sobre um cliente falso: o que se mede é a decisão de quem consome a
 * leitura, não que uma função foi chamada. Dublar a guarda provaria só que a
 * escolha atravessa um `if`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import {
  AgendaPuladoError,
  CHAVE_DA_ESCOLHA,
  ESCOLHA_PADRAO,
  MOTIVO_DO_PULO,
  decidirNoEnvio,
  lerEscolhaNoEnvio,
} from "@/lib/agenda/escolha-no-envio";
import { escolhaDoFluxo } from "@/lib/agenda/escolha-no-envio-leitura";
import { AgendaDeferredError, type ProtecaoAgenda } from "@/lib/agenda/protecao-followup";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";

/** Um compromisso daqui a TRÊS MESES — o caso que a issue cita. */
const COMPROMISSO = {
  id: "appointment-futuro",
  contact_id: CONTATO,
  revision: 1,
  status: "confirmed",
  starts_at: "2027-01-31T12:00:00.000Z",
  ends_at: "2027-01-31T13:00:00.000Z",
};

const PROTECAO_ADIADA: ProtecaoAgenda = {
  adiar: true,
  motivo: "agendado",
  appointment_id: COMPROMISSO.id,
  reavaliar_em: "2027-01-31T12:00:00.000Z",
};

/**
 * Cliente falso do PostgREST: cada tabela devolve a página que o caso precisa.
 * A paginação por keyset de `protecaoAgendaSupabase` só termina com página
 * VAZIA (o comentário do módulo explica por que), então depois do primeiro
 * `gt(...)` a tabela responde vazia — senão a leitura gira para sempre.
 */
function bancoFalso(opcoes: {
  compromissos?: Record<string, unknown>[];
  settings?: unknown;
  falharAgenda?: boolean;
  followup?: unknown;
  falharFollowup?: boolean;
}): SupabaseClient {
  const tabela = (nome: string) => {
    let paginado = false;
    const pagina = () => {
      if (nome === "calendar_appointments") {
        if (opcoes.falharAgenda) return { data: null, error: new Error("agenda_fora") };
        return { data: paginado ? [] : (opcoes.compromissos ?? []), error: null };
      }
      if (nome === "organizations") {
        return { data: { settings: opcoes.settings ?? {} }, error: null };
      }
      if (nome === "followup_enrollments") {
        if (opcoes.falharFollowup) return { data: null, error: new Error("enrollment_fora") };
        return { data: { agent_id: "agente-1" }, error: null };
      }
      if (nome === "ai_agents") return { data: { published_version_id: "versao-1" }, error: null };
      if (nome === "ai_agent_versions") return { data: { followup: opcoes.followup ?? null }, error: null };
      return { data: null, error: null };
    };
    const elo: Record<string, unknown> = {
      select: () => elo,
      eq: () => elo,
      in: () => elo,
      order: () => elo,
      limit: () => elo,
      gt: () => {
        paginado = true;
        return elo;
      },
      single: async () => pagina(),
      maybeSingle: async () => pagina(),
      // `await query` é o que a leitura paginada faz: o elo é "thenable".
      then: (resolver: (v: unknown) => unknown) => Promise.resolve(pagina()).then(resolver),
    };
    return elo;
  };
  return { from: (nome: string) => tabela(nome) } as unknown as SupabaseClient;
}

describe("#3813 — a decisão, sem banco", () => {
  it("padrão (`adiar`) conserva o adiamento de hoje: mesmo motivo, mesmo instante", () => {
    // Anti-regressão: é a asserção que JÁ passa na main. Se o padrão mudasse,
    // toda regra que nunca configurou nada passaria a enviar durante o
    // atendimento — o oposto do que a proteção existe para fazer.
    expect(decidirNoEnvio(PROTECAO_ADIADA, ESCOLHA_PADRAO)).toEqual({
      acao: "adiar",
      motivo: "agendado",
      appointment_id: COMPROMISSO.id,
      reavaliar_em: PROTECAO_ADIADA.reavaliar_em,
    });
  });

  it("`enviar mesmo assim` não adia — o compromisso deixa de segurar o envio", () => {
    expect(decidirNoEnvio(PROTECAO_ADIADA, "enviar")).toEqual({
      acao: "enviar",
      motivo: "agendado",
      appointment_id: COMPROMISSO.id,
    });
  });

  it("`não enviar` PULA com o motivo registrável — não adia e não falha", () => {
    expect(decidirNoEnvio(PROTECAO_ADIADA, "nao_enviar")).toEqual({
      acao: "pular",
      motivo: MOTIVO_DO_PULO,
      appointment_id: COMPROMISSO.id,
    });
  });

  it("sem compromisso, as três escolhas enviam (a escolha não inventa bloqueio)", () => {
    const semCompromisso: ProtecaoAgenda = {
      adiar: false,
      motivo: "sem_compromisso",
      appointment_id: null,
      reavaliar_em: null,
    };
    for (const escolha of ["adiar", "enviar", "nao_enviar"] as const) {
      expect(decidirNoEnvio(semCompromisso, escolha), escolha).toMatchObject({ acao: "enviar" });
    }
  });

  it("leitura indisponível continua FECHADA em qualquer escolha", () => {
    // "enviar mesmo assim" é resposta sobre um compromisso CONHECIDO; agenda que
    // não respondeu não autoriza nada. Quem chama segue tratando como falha.
    const indisponivel: ProtecaoAgenda = {
      adiar: true,
      motivo: "leitura_indisponivel",
      appointment_id: null,
      reavaliar_em: "2026-10-31T12:01:00.000Z",
    };
    for (const escolha of ["adiar", "enviar", "nao_enviar"] as const) {
      expect(decidirNoEnvio(indisponivel, escolha), escolha).toMatchObject({
        acao: "adiar",
        motivo: "leitura_indisponivel",
      });
    }
  });
});

describe("#3813 — leitura tolerante a configuração velha/ausente", () => {
  it.each([
    ["ausente", undefined],
    ["objeto vazio", {}],
    ["null", null],
    ["lista", [{ [CHAVE_DA_ESCOLHA]: "enviar" }]],
    ["string torta", { [CHAVE_DA_ESCOLHA]: "enviar_mesmo_assim" }],
    ["booleano (o `proteger_pela_agenda` de outra tela)", { [CHAVE_DA_ESCOLHA]: true }],
    ["maiúsculas", { [CHAVE_DA_ESCOLHA]: "ENVIAR" }],
  ])("%s cai no padrão e NUNCA lança", (_rotulo, bruto) => {
    expect(lerEscolhaNoEnvio(bruto)).toBe("adiar");
  });

  it.each(["adiar", "enviar", "nao_enviar"] as const)("`%s` é lido como está", (valor) => {
    expect(lerEscolhaNoEnvio({ [CHAVE_DA_ESCOLHA]: valor })).toBe(valor);
  });
});

describe("#3813 — a guarda de envio respeita a escolha", () => {
  const ctx = (escolhaNoEnvio?: "adiar" | "enviar" | "nao_enviar") => ({
    organizationId: ORG,
    contactId: CONTATO,
    ...(escolhaNoEnvio ? { escolhaNoEnvio } : {}),
  });

  it("sem escolha: adia como sempre (AgendaDeferredError)", async () => {
    const admin = bancoFalso({ compromissos: [COMPROMISSO] });
    await expect(assertAgendaEffectSupabase(admin, ctx())).rejects.toBeInstanceOf(AgendaDeferredError);
  });

  it("`enviar`: NÃO lança — o envio segue mesmo com compromisso futuro", async () => {
    const admin = bancoFalso({ compromissos: [COMPROMISSO] });
    await expect(assertAgendaEffectSupabase(admin, ctx("enviar"))).resolves.toBeUndefined();
  });

  it("`nao_enviar`: lança o PULO (com motivo), nunca AgendaDeferredError", async () => {
    const admin = bancoFalso({ compromissos: [COMPROMISSO] });
    const erro = await assertAgendaEffectSupabase(admin, ctx("nao_enviar")).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(AgendaPuladoError);
    expect(erro).not.toBeInstanceOf(AgendaDeferredError);
    expect((erro as AgendaPuladoError).protection.appointment_id).toBe(COMPROMISSO.id);
    expect((erro as AgendaPuladoError).message).toContain(MOTIVO_DO_PULO);
  });
});

describe("#3813 — a escolha do FLUXO de follow-up", () => {
  it("lê a configuração publicada do agente (`ai_agent_versions.followup`)", async () => {
    const admin = bancoFalso({ followup: { enabled: true, [CHAVE_DA_ESCOLHA]: "enviar" } });
    await expect(escolhaDoFluxo(admin, ORG, "enr-1")).resolves.toBe("enviar");
  });

  it("configuração antiga, sem a chave, cai no padrão", async () => {
    const admin = bancoFalso({ followup: { enabled: true, flow_pointer_ids: [], send_window: null } });
    await expect(escolhaDoFluxo(admin, ORG, "enr-1")).resolves.toBe(ESCOLHA_PADRAO);
  });

  it("leitura que falha cai no padrão em vez de derrubar o envio", async () => {
    const admin = bancoFalso({ falharFollowup: true });
    await expect(escolhaDoFluxo(admin, ORG, "enr-1")).resolves.toBe(ESCOLHA_PADRAO);
  });
});

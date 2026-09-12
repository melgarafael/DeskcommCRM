/**
 * A QUARTA PORTA DO AVISO DE RECUPERAÇÃO RECUSA CONTATO ANONIMIZADO.
 *
 * `appointment_recovery_review` nasce em quatro lugares. Três guardam
 * anonimização, e todas as três moram em SQL: o trigger `fn_meet_redact_contact`
 * resolve os avisos abertos, `fn_appointment_recover` recusa contato
 * anonimizado, e há um bloco de cura para o histórico. A quarta é o adaptador
 * TypeScript — `abrirAvisoRecuperacaoEsgotada`, no engine (PostgREST) e no
 * turn-bridge (pg) — e nascia sem nenhuma (issue #701).
 *
 * O turn-bridge já guarda dentro da própria escrita (`insert ... select ... and
 * not c.is_anonymized`, merged no #657). Aqui se prova a do engine, que é o
 * caminho em que o PostgREST não expressa `insert ... select`.
 *
 * As duas direções estão medidas, porque uma guarda que nunca deixa passar não é
 * uma guarda, é uma porta fechada: o contato anonimizado NÃO gera aviso, e o
 * contato comum gera — com o mesmo conteúdo de antes.
 *
 * `createSupabaseAdminClient` recebe o client por parâmetro exatamente para isto:
 * o dublê registra as escritas, e o que se afirma é sobre o que foi escrito (ou
 * não), não sobre a presença de um `if` no código.
 */
import { describe, expect, it } from "vitest";

import { createSupabaseAdminClient } from "@/lib/followup/engine";
import type { AvisoRecuperacaoEsgotada } from "@/lib/followup/no-show-recuperacao-esgotada";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const COMPROMISSO = "55555555-5555-4555-8555-555555555555";
const MATRICULA = "66666666-6666-4666-8666-666666666666";

const AVISO: AvisoRecuperacaoEsgotada = {
  organization_id: ORG,
  appointment_id: COMPROMISSO,
  appointment_revision: 3,
  ref_enrollment_id: MATRICULA,
};

interface Escrita {
  tabela: string;
  linha: Record<string, unknown>;
}

/**
 * O pedaço de PostgREST que o adaptador usa, com a resposta que o teste quer.
 *
 * `compromisso` é o que `calendar_appointments` devolve (ou `null`, quando o
 * compromisso não existe mais) e `contato` o que `contacts` devolve.
 */
function cliente(opcoes: {
  compromisso?: { contact_id: string | null } | null;
  contato?: { is_anonymized: boolean | null } | null;
  erroNaLeitura?: boolean;
}) {
  const inseridos: Escrita[] = [];
  const colunasLidas: string[] = [];
  const consultas: string[] = [];

  const q = {
    select: (colunas: string) => {
      consultas.push(colunas);
      return q;
    },
    eq: () => q,
    maybeSingle: async () => {
      if (opcoes.erroNaLeitura) return { data: null, error: { message: "permissão negada" } };
      const ultima = consultas[consultas.length - 1] ?? "";
      if (ultima.includes("contact_id")) return { data: opcoes.compromisso ?? null, error: null };
      return { data: opcoes.contato ?? null, error: null };
    },
    insert: async (linha: Record<string, unknown>) => {
      inseridos.push({ tabela: "agent_inbox_items", linha });
      return { error: null };
    },
  };

  const cliente = {
    from: (tabela: string) => {
      colunasLidas.push(tabela);
      return q;
    },
    // O adaptador inteiro é devolvido; este teste só exercita o método do aviso.
    rpc: async () => ({ data: null, error: null }),
  };

  return { cliente, inseridos, colunasLidas };
}

async function abrir(alvo: ReturnType<typeof cliente>): Promise<void> {
  const admin = createSupabaseAdminClient(alvo.cliente as never);
  await admin.abrirAvisoRecuperacaoEsgotada?.(AVISO);
}

describe("a quarta porta do aviso de recuperação", () => {
  it("⭐ contato anonimizado NÃO gera aviso — o vínculo não ressuscita", async () => {
    const alvo = cliente({
      compromisso: { contact_id: CONTATO },
      contato: { is_anonymized: true },
    });

    await abrir(alvo);

    expect(
      alvo.inseridos,
      "o aviso nasceu apontando para o compromisso que a anonimização desligou",
    ).toEqual([]);
  });

  it("⭐ contato comum gera o aviso de sempre — a guarda não fecha a porta para quem não exerceu o direito", async () => {
    const alvo = cliente({
      compromisso: { contact_id: CONTATO },
      contato: { is_anonymized: false },
    });

    await abrir(alvo);

    expect(alvo.inseridos).toHaveLength(1);
    expect(alvo.inseridos[0]!.linha).toMatchObject({
      organization_id: ORG,
      kind: "appointment_recovery_review",
      ref_kind: "appointment",
      ref_id: COMPROMISSO,
      appointment_revision: 3,
    });
  });

  it("a checagem consulta a anonimização do contato do COMPROMISSO", async () => {
    const alvo = cliente({
      compromisso: { contact_id: CONTATO },
      contato: { is_anonymized: false },
    });

    await abrir(alvo);

    // O contato vem do compromisso, e não do enrollment: é o vínculo que a
    // anonimização de fato percorre (`fn_meet_redact_contact` desliga o
    // compromisso, e o `ref_id` do aviso é ele).
    expect(alvo.colunasLidas).toContain("calendar_appointments");
    expect(alvo.colunasLidas).toContain("contacts");
  });

  it("leitura que falha vira erro — a dúvida não vira aviso", async () => {
    const alvo = cliente({ erroNaLeitura: true });

    await expect(abrir(alvo)).rejects.toThrow();
    expect(alvo.inseridos).toEqual([]);
  });
});

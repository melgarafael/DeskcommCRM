import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PROPRIEDADE: a mensagem para a equipe não leva NENHUM texto livre da conversa
 * (#2642, decisão do dono no doc 176, opção A).
 *
 * Todo campo de texto livre que a IA escreve a partir da conversa é preenchido
 * com um MARCADOR único — título, descrição, motivo do ganho, tags, campos
 * personalizados, motivo e evidência da pontuação, o checkpoint inteiro
 * (resumo, compromissos, objeções, próxima ação, declaração). O teste dirige as DUAS saídas reais — o corpo que `notify_team`
 * entrega ao transporte e o `{{resumo}}` que `send_email` entrega ao roteador —
 * e afirma que nenhum marcador aparece, que os dados de forma fixa e o atalho
 * aparecem, e que toda linha do texto tem um rótulo conhecido. A última
 * asserção é a que pega o campo NOVO de amanhã: uma linha que ninguém listou
 * aqui reprova, mesmo sem marcador.
 *
 * Só transporte, ritmo do canal e roteador de e-mail são dublês; montagem,
 * leitura e saneamento são o código de produção.
 */
const transporte = vi.hoisted(() => {
  // O atalho só sai com endereço PÚBLICO; o padrão `localhost` não gera link.
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.acme.com.br";
  return {
    configurado: vi.fn(async () => true),
    resolveDestino: vi.fn(async (_org: string, _canal: unknown, telefone: string) => telefone),
    envia: vi.fn(async () => ({ externalId: "wamid.PROPRIEDADE" })),
  };
});
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: vi.fn(async () => transporte),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: vi.fn(async () => ({
    decide: vi.fn(async () => ({ liberado: true })),
    registraEnvio: vi.fn(async () => undefined),
  })),
}));
vi.mock("@/lib/channels/capabilities", () => ({
  capabilitiesOf: vi.fn(() => ({ freeformOutsideWindow: true })),
}));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: vi.fn() }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/notify-team";
import "@/lib/automation/actions/send-email";
import type { ActionCtx } from "@/lib/automation/types";
import { sendEmail } from "@/lib/email/roteador";
import { formatarMoeda } from "@/lib/propostas/moeda";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBRO = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CANAL = "55555555-5555-4555-8555-555555555555";

/** Um marcador por campo livre: o nome diz de onde ele vazou. */
const M = {
  descricao: "MKR_DESCRICAO_q1",
  motivoDoGanho: "MKR_MOTIVO_DO_GANHO_q2",
  motivoDaPontuacao: "MKR_MOTIVO_DA_PONTUACAO_q3",
  resumoDaConversa: "MKR_ROLLING_SUMMARY_q4",
  compromisso: "MKR_COMPROMISSO_q5",
  objecao: "MKR_OBJECAO_q6",
  proximaAcao: "MKR_NEXT_ACTION_q7",
  declaracao: "MKR_DECLARACAO_q8",
  motivoDaPerda: "MKR_LOST_REASON_q9",
  titulo: "MKR_TITULO_q10",
  tag: "MKR_TAG_q11",
  campoPersonalizado: "MKR_CUSTOM_FIELD_q12",
  evidenciaDaPontuacao: "MKR_EVIDENCIA_q13",
} as const;

const TABELAS: Record<string, Array<Record<string, unknown>>> = {
  organizations: [{ id: ORG, locale: "pt-BR" }],
  user_organizations: [{ organization_id: ORG, user_id: MEMBRO, revoked_at: null }],
  crm_lead_scores: [
    {
      organization_id: ORG,
      lead_id: LEAD,
      ai_probability: 72,
      ai_probability_reason: M.motivoDaPontuacao,
      ai_probability_evidence: { sinais: [M.evidenciaDaPontuacao] },
    },
  ],
  lead_checkpoints: [
    {
      organization_id: ORG,
      contact_id: CONTATO,
      seq: 9,
      rolling_summary: M.resumoDaConversa,
      commitments: [M.compromisso],
      objections: [M.objecao],
      next_action: M.proximaAcao,
      declaracao: { texto: M.declaracao },
    },
  ],
  config_aviso_de_caso: [
    { organization_id: ORG, channel_session_id: CANAL, telefone_destino: "+5511999990000", ligado: true },
  ],
  channel_sessions: [
    { id: CANAL, organization_id: ORG, status: "WORKING", archived_at: null, provider: "whatsapp-cloud-api", metadata: {} },
  ],
};

/** PostgREST em memória que aplica os filtros pedidos. */
function adminFake(): ActionCtx["admin"] {
  function builder(nome: string) {
    const filtros: Array<[string, unknown]> = [];
    const consulta = {
      select: () => consulta,
      eq: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return consulta;
      },
      is: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return consulta;
      },
      order: () => consulta,
      limit: () => consulta,
      maybeSingle: async () => ({
        data: (TABELAS[nome] ?? []).find((l) => filtros.every(([c, v]) => l[c] === v)) ?? null,
        error: null,
      }),
    };
    return consulta;
  }
  return {
    from: (nome: string) => builder(nome),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "closer@acme.com.br" } } }) } },
  } as unknown as ActionCtx["admin"];
}

function ctx(): ActionCtx {
  return {
    admin: adminFake(),
    organizationId: ORG,
    ruleId: "rule-1",
    ruleName: "Avisa o closer quando o negócio for ganho",
    event: {} as ActionCtx["event"],
    context: {
      lead: {
        id: LEAD,
        contact_id: CONTATO,
        title: M.titulo,
        description: M.descricao,
        tags: [M.tag],
        custom_fields: { observacao: M.campoPersonalizado },
        status: "won",
        value_cents: 120_000,
        currency: "BRL",
        won_reason: M.motivoDoGanho,
        lost_reason: M.motivoDaPerda,
      },
      contact: { name: "Maria da Silva", display_name: "Maria da Silva", phone_number: "+5511988887777" },
    },
    requestId: "req-1",
  };
}

async function textoDoWhatsApp(): Promise<string> {
  const r = await getAction("notify_team")!.execute(ctx(), { canal: "whatsapp" });
  expect(r.status).toBe("success");
  return (transporte.envia.mock.calls[0] as unknown as [string, unknown, string, string])[3];
}

async function textoDoEmail(): Promise<string> {
  const r = await getAction("send_email")!.execute(ctx(), {
    destinatario: "membro_da_equipe",
    membro_id: MEMBRO,
    assunto: "Negócio ganho",
    corpo: "{{resumo}}",
    formato: "texto",
  });
  expect(r.status).toBe("success");
  return vi.mocked(sendEmail).mock.calls[0]![0].text as string;
}

/** Os únicos rótulos que uma linha pode ter. Linha fora daqui é campo novo não decidido. */
const ROTULOS = [
  "Resumo automático",
  "Resumo do lead para a equipe",
  "Regra: ",
  "Cliente: ",
  "Telefone: ",
  "Valor: ",
  "Pontuação: ",
  "Abrir negócio: ",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "e-mail-1", via: "smtp" });
});

describe.each([
  ["notify_team (WhatsApp de Avisos)", textoDoWhatsApp],
  ["send_email ({{resumo}})", textoDoEmail],
])("%s — só dado de forma fixa (doc 176, A)", (_nome, texto) => {
  it("nenhum texto livre da conversa chega à mensagem", async () => {
    const saida = await texto();
    for (const [campo, marcador] of Object.entries(M)) {
      expect(saida, `o campo livre "${campo}" vazou para a mensagem`).not.toContain(marcador);
    }
    expect(saida).not.toContain("MKR_");
  });

  it("os dados de forma fixa e o atalho para a ficha estão lá", async () => {
    const saida = await texto();
    expect(saida).toContain("Regra: Avisa o closer quando o negócio for ganho");
    expect(saida).toContain("Cliente: Maria");
    expect(saida).not.toContain("da Silva");
    expect(saida).toContain("Telefone: +5511988887777");
    expect(saida, "o título do negócio é texto livre").not.toContain("Negócio: ");
    expect(saida).toContain(`Valor: ${formatarMoeda(120_000, "BRL")}`);
    expect(saida.split("\n")).toContain("Pontuação: 72%");
    expect(saida).toContain(`Abrir negócio: https://crm.acme.com.br/app/leads/${LEAD}`);
  });

  it("toda linha tem um rótulo conhecido", async () => {
    const saida = await texto();
    const intrusas = saida
      .split("\n")
      .filter((l) => l.trim() !== "" && !ROTULOS.some((r) => l.startsWith(r)));
    expect(intrusas, "linha sem rótulo de forma fixa").toEqual([]);
  });
});

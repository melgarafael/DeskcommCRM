/**
 * A FICHA QUE "ABRIR CONVERSA COM O CONTATO" CRIA NÃO AFIRMA QUE O NÚMERO TEM WHATSAPP.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `POST /api/v1/conversations/open-with-contact`, a tool MCP
 * `crm_start_conversation_and_send` e `POST /api/v1/messages` por telefone
 * passam por `openSharedContactConversation`. Quando o telefone não era de
 * ficha nenhuma, ela criava a ficha pela RPC do WEBHOOK, `fn_upsert_wa_contact`,
 * cujo INSERT grava `phone_whatsapp = 'sim'` fixo (`supabase/baseline.sql`, a
 * última definição da função). Para o webhook isso é verdade: o número acabou de
 * escrever pelo WhatsApp. Para quem abre por token (uma ligação do DeskVoice,
 * um cadastro), ninguém sabe ainda, e a ficha mentia "tem WhatsApp".
 *
 * ─── O que se mede aqui ─────────────────────────────────────────────────────
 *
 * Dublê, não banco. O dublê imita as DUAS gravações possíveis como o banco as
 * faz: a RPC do webhook grava `'sim'`, e o INSERT direto passa pelo gatilho
 * `fn_contacts_um_numero_uma_ficha`, que põe `coalesce(new.phone_whatsapp,
 * 'nao_sei')`. O teste lê a ficha que nasceu, e não o argumento da chamada.
 *
 * O outro lado (a mensagem RECEBIDA pelo WhatsApp continua marcando `'sim'`)
 * é regra de Postgres e está em `tests/invariants/whatsapp-da-ficha-criada-por-token.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { openConversationWithContactSchema } from "@/lib/schemas/messaging";

import { openSharedContactConversation } from "./open-shared-contact-conversation";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const TELEFONE = "+5532999990000";
const ID_NOVO = "55555555-5555-4555-8555-555555555555";
const ID_DO_VENCEDOR = "66666666-6666-4666-8666-666666666666";

type Linha = Record<string, unknown>;

const SESSAO_WHATSAPP: Linha = {
  id: SESSAO,
  organization_id: ORG,
  provider: PROVIDERS_DE_TELEFONE[0],
  phone_number: "+5532999991111",
  status: "WORKING",
  metadata: null,
  archived_at: null,
  created_at: "2026-06-01T00:00:00Z",
};

/**
 * `vencedorDaCorrida`: outra porta grava a ficha do mesmo número entre a busca e
 * o INSERT desta função. O INSERT então leva `23505`, como no banco.
 */
function bancoDeMentira(opts: { vencedorDaCorrida?: Linha } = {}) {
  const contatos: Linha[] = [];
  const rpcs: string[] = [];
  let buscasDeContato = 0;

  function linhasDe(nome: string): Linha[] {
    if (nome === "channel_sessions") return [SESSAO_WHATSAPP];
    if (nome === "contacts") return contatos;
    return [];
  }

  const from = (nome: string) => {
    let atual = [...linhasDe(nome)];
    let teto: number | null = null;
    let inserindo: Linha | null = null;
    const resolver = () => (teto === null ? atual : atual.slice(0, teto));
    const cadeia = {
      select: () => cadeia,
      order: () => cadeia,
      eq: (c: string, v: unknown) => {
        atual = atual.filter((l) => l[c] === v);
        return cadeia;
      },
      is: (c: string, v: unknown) => {
        atual = atual.filter((l) => (l[c] ?? null) === v);
        return cadeia;
      },
      in: (c: string, vs: unknown[]) => {
        if (nome === "contacts" && c === "phone_number") {
          buscasDeContato += 1;
          // A corrida: a SEGUNDA busca (a de depois do 23505) já acha o vencedor.
          if (opts.vencedorDaCorrida && buscasDeContato > 1) atual = [opts.vencedorDaCorrida];
        }
        atual = atual.filter((l) => vs.includes(l[c]));
        return cadeia;
      },
      limit: (n: number) => {
        teto = n;
        return cadeia;
      },
      insert: (linha: Linha) => {
        inserindo = linha;
        return cadeia;
      },
      single: async () => {
        if (inserindo && nome === "contacts") {
          if (opts.vencedorDaCorrida) {
            contatos.push(opts.vencedorDaCorrida);
            return { data: null, error: { code: "23505", message: "uniq_contacts_org_phone" } };
          }
          // O gatilho `fn_contacts_um_numero_uma_ficha` no INSERT com telefone.
          const nova = {
            id: ID_NOVO,
            is_personal: false,
            is_merged_into: null,
            ...inserindo,
            phone_whatsapp: (inserindo.phone_whatsapp as string | null | undefined) ?? "nao_sei",
          };
          contatos.push(nova);
          return { data: { id: nova.id }, error: null };
        }
        return { data: resolver()[0] ?? null, error: null };
      },
      maybeSingle: async () => ({ data: resolver()[0] ?? null, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => ok({ data: resolver(), error: null }),
    };
    return cadeia;
  };

  const rpc = async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push(nome);
    if (nome === "fn_upsert_wa_contact") {
      // O INSERT da RPC do webhook: `case when v_phone is not null then 'sim' end`.
      contatos.push({
        id: ID_NOVO,
        organization_id: args.p_org,
        phone_number: args.p_phone,
        phone_whatsapp: "sim",
        is_personal: false,
        is_merged_into: null,
      });
      return { data: ID_NOVO, error: null };
    }
    return {
      data: {
        organization_id: ORG,
        contact_id: args.p_contact,
        conversation_id: CONVERSA,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  };

  return { db: { from, rpc } as unknown as SupabaseClient, contatos, rpcs };
}

describe("abrir conversa por telefone: a ficha nova não nasce com WhatsApp = sim (DES-1950)", () => {
  it("⭐ sem informar nada, a ficha criada nasce `nao_sei`", async () => {
    const { db, contatos } = bancoDeMentira();

    const res = await openSharedContactConversation(db, ORG, {
      channel_session_id: SESSAO,
      phone_number: TELEFONE,
      name: "Quem ligou",
    });

    expect(res.contact_id).toBe(ID_NOVO);
    const ficha = contatos.find((c) => c.id === ID_NOVO);
    expect(ficha?.phone_whatsapp).toBe("nao_sei");
    expect(ficha?.phone_number).toBe(TELEFONE);
    expect(ficha?.organization_id).toBe(ORG);
    expect(ficha?.display_name).toBe("Quem ligou");
  });

  it.each(["sim", "nao", "nao_sei"] as const)("quem chama informa `%s`: é o que a ficha nova grava", async (valor) => {
    const { db, contatos } = bancoDeMentira();

    await openSharedContactConversation(db, ORG, {
      channel_session_id: SESSAO,
      phone_number: TELEFONE,
      phone_whatsapp: valor,
    });

    expect(contatos.find((c) => c.id === ID_NOVO)?.phone_whatsapp).toBe(valor);
  });

  it("corrida perdida (23505): devolve a ficha que venceu e não mexe no WhatsApp dela", async () => {
    const vencedor: Linha = {
      id: ID_DO_VENCEDOR,
      organization_id: ORG,
      phone_number: TELEFONE,
      phone_whatsapp: "sim",
      is_personal: false,
      is_merged_into: null,
    };
    const { db, contatos } = bancoDeMentira({ vencedorDaCorrida: vencedor });

    const res = await openSharedContactConversation(db, ORG, {
      channel_session_id: SESSAO,
      phone_number: TELEFONE,
      phone_whatsapp: "nao",
    });

    expect(res.contact_id).toBe(ID_DO_VENCEDOR);
    expect(contatos).toHaveLength(1);
    expect(contatos[0]!.phone_whatsapp).toBe("sim");
  });

  it("ficha que já existe não é tocada: o valor informado só vale para a ficha nova", async () => {
    const { db, contatos, rpcs } = bancoDeMentira();
    contatos.push({
      id: ID_DO_VENCEDOR,
      organization_id: ORG,
      phone_number: TELEFONE,
      phone_whatsapp: "sim",
      is_personal: false,
      is_merged_into: null,
    });

    const res = await openSharedContactConversation(db, ORG, {
      channel_session_id: SESSAO,
      phone_number: TELEFONE,
      phone_whatsapp: "nao",
    });

    expect(res.contact_id).toBe(ID_DO_VENCEDOR);
    expect(contatos).toHaveLength(1);
    expect(contatos[0]!.phone_whatsapp).toBe("sim");
    expect(rpcs).not.toContain("fn_upsert_wa_contact");
  });
});

describe("o corpo de open-with-contact valida `phone_whatsapp`", () => {
  it.each(["sim", "nao", "nao_sei"])("aceita `%s`", (valor) => {
    const r = openConversationWithContactSchema.safeParse({ phone_number: TELEFONE, phone_whatsapp: valor });
    expect(r.success).toBe(true);
  });

  it("recusa valor fora do vocabulário do banco (seria 23514 na gravação)", () => {
    const r = openConversationWithContactSchema.safeParse({ phone_number: TELEFONE, phone_whatsapp: "talvez" });
    expect(r.success).toBe(false);
  });

  it("continua opcional", () => {
    expect(openConversationWithContactSchema.safeParse({ phone_number: TELEFONE }).success).toBe(true);
  });
});

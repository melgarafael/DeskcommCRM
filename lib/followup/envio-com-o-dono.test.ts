/**
 * A RÉGUA da opção por fluxo "enviar mesmo com a conversa atribuída" (#3974).
 *
 * A decisão pura (`opcaoLiberaEnvio`) é uma só; este arquivo a prende junto dos
 * dois leitores `supabase-js` do atalho inline (o `pg` do worker é provado
 * contra o Postgres do baseline, em `tests/invariants/`). O que se mede aqui é a
 * fronteira da exceção:
 *
 *   • posse (conversa aberta com `assigned_to_user_id`) libera;
 *   • `force_human`, opt-out de IA, contato bloqueado e etiqueta interna NÃO;
 *   • silêncio sem dono (5 min da resposta pela tela, pausa manual) NÃO;
 *   • conversa encerrada não conta como posse viva;
 *   • opção desligada (ou ilegível) NUNCA libera — o comportamento de hoje.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  lerEstadoDoComandoViaSupabase,
  lerOpcaoDaInscricaoViaSupabase,
  liberaEnvioComODonoViaSupabase,
  opcaoLiberaEnvio,
  type EstadoDoComando,
} from "./envio-com-o-dono";

const ORG = "org-1";
const CONTATO = "contato-1";
const INSCRICAO = "enr-1";

type Linhas = {
  pointer?: { send_when_assigned?: boolean | null } | null;
  contato?: Record<string, unknown> | null;
  conversas?: Record<string, unknown>[];
  falha?: string;
};

/** Stub mínimo do `supabase-js`: só o que a régua lê. */
function admin(linhas: Linhas) {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => {
        if (linhas.falha) return Promise.resolve({ data: null, error: { message: linhas.falha } });
        if (table === "followup_enrollments") {
          return Promise.resolve({ data: { pointer_id: "ptr-1" }, error: null });
        }
        if (table === "followup_flow_pointers") {
          return Promise.resolve({ data: linhas.pointer ?? null, error: null });
        }
        if (table === "contacts") return Promise.resolve({ data: linhas.contato ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (linhas.falha) return Promise.resolve({ data: null, error: { message: linhas.falha } }).then(resolve);
        if (table === "conversations") {
          return Promise.resolve({ data: linhas.conversas ?? [], error: null }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t) } as unknown as Pick<SupabaseClient, "from">;
}

const contatoComum = {
  force_human: false,
  ai_opt_out: false,
  is_blocked: false,
  tags: [] as string[],
  organizations: { settings: { crm: { internal_contact_tags: ["equipe"] } } },
};

const conversaComDono = {
  assigned_to_user_id: "user-1",
  bot_silenced_until: "infinity",
  status: "open",
};

const estado = (p: Partial<EstadoDoComando>): EstadoDoComando => ({
  contatoVetado: false,
  conversaComDono: true,
  conversaSilenciadaSemDono: false,
  ...p,
});

describe("opcaoLiberaEnvio — a regra pura", () => {
  it("opção desligada nunca libera, nem com conversa com dono", () => {
    expect(opcaoLiberaEnvio(false, estado({}))).toBe(false);
  });

  it("opção ligada + posse, sem outro veto → libera", () => {
    expect(opcaoLiberaEnvio(true, estado({}))).toBe(true);
  });

  it("opção ligada + veto de CONTATO → não libera", () => {
    expect(opcaoLiberaEnvio(true, estado({ contatoVetado: true }))).toBe(false);
  });

  it("opção ligada + silêncio SEM dono → não libera", () => {
    expect(opcaoLiberaEnvio(true, estado({ conversaSilenciadaSemDono: true }))).toBe(false);
  });

  it("opção ligada + nenhuma conversa com dono → não libera", () => {
    expect(opcaoLiberaEnvio(true, estado({ conversaComDono: false }))).toBe(false);
  });

  it("estado ilegível (contato sumiu) → não libera: exceção sem o dado não existe", () => {
    expect(opcaoLiberaEnvio(true, null)).toBe(false);
  });
});

describe("lerOpcaoDaInscricaoViaSupabase", () => {
  it("lê a coluna do fluxo da inscrição", async () => {
    await expect(
      lerOpcaoDaInscricaoViaSupabase(admin({ pointer: { send_when_assigned: true } }), {
        organizationId: ORG,
        enrollmentId: INSCRICAO,
      }),
    ).resolves.toBe(true);
    await expect(
      lerOpcaoDaInscricaoViaSupabase(admin({ pointer: { send_when_assigned: false } }), {
        organizationId: ORG,
        enrollmentId: INSCRICAO,
      }),
    ).resolves.toBe(false);
  });

  it("fluxo antigo, coluna nula/ausente → desligada (comportamento de hoje)", async () => {
    await expect(
      lerOpcaoDaInscricaoViaSupabase(admin({ pointer: {} }), {
        organizationId: ORG,
        enrollmentId: INSCRICAO,
      }),
    ).resolves.toBe(false);
  });

  it("sem inscrição no payload → desligada, sem consultar o banco", async () => {
    await expect(
      lerOpcaoDaInscricaoViaSupabase(admin({}), { organizationId: ORG, enrollmentId: null }),
    ).resolves.toBe(false);
  });

  it("falha de leitura sobe — quem chama decide (o atalho trata como não liberar)", async () => {
    await expect(
      lerOpcaoDaInscricaoViaSupabase(admin({ falha: "offline" }), {
        organizationId: ORG,
        enrollmentId: INSCRICAO,
      }),
    ).rejects.toThrow(/offline/);
  });
});

describe("lerEstadoDoComandoViaSupabase", () => {
  it("conversa aberta com dono → conversaComDono", async () => {
    const e = await lerEstadoDoComandoViaSupabase(
      admin({ contato: contatoComum, conversas: [conversaComDono] }),
      { organizationId: ORG, contactId: CONTATO },
    );
    expect(e).toEqual({
      contatoVetado: false,
      conversaComDono: true,
      conversaSilenciadaSemDono: false,
    });
  });

  it("conversa ENCERRADA com dono não conta como posse viva", async () => {
    const e = await lerEstadoDoComandoViaSupabase(
      admin({
        contato: contatoComum,
        conversas: [{ ...conversaComDono, status: "closed" }],
      }),
      { organizationId: ORG, contactId: CONTATO },
    );
    expect(e?.conversaComDono).toBe(false);
  });

  it("silêncio de 5 min sem dono é outro comando (pessoa digitando), não posse", async () => {
    const e = await lerEstadoDoComandoViaSupabase(
      admin({
        contato: contatoComum,
        conversas: [
          conversaComDono,
          {
            assigned_to_user_id: null,
            bot_silenced_until: new Date(Date.now() + 5 * 60_000).toISOString(),
            status: "open",
          },
        ],
      }),
      { organizationId: ORG, contactId: CONTATO },
    );
    expect(e).toMatchObject({ conversaComDono: true, conversaSilenciadaSemDono: true });
  });

  it("silêncio já vencido sem dono não conta", async () => {
    const e = await lerEstadoDoComandoViaSupabase(
      admin({
        contato: contatoComum,
        conversas: [
          conversaComDono,
          {
            assigned_to_user_id: null,
            bot_silenced_until: new Date(Date.now() - 60_000).toISOString(),
            status: "open",
          },
        ],
      }),
      { organizationId: ORG, contactId: CONTATO },
    );
    expect(e?.conversaSilenciadaSemDono).toBe(false);
  });

  it.each([
    ["force_human", { ...contatoComum, force_human: true }],
    ["ai_opt_out", { ...contatoComum, ai_opt_out: true }],
    ["is_blocked", { ...contatoComum, is_blocked: true }],
    ["etiqueta interna", { ...contatoComum, tags: ["EQUIPE"] }],
  ])("%s veta o contato e a opção não vence", async (_nome, contato) => {
    const e = await lerEstadoDoComandoViaSupabase(admin({ contato, conversas: [conversaComDono] }), {
      organizationId: ORG,
      contactId: CONTATO,
    });
    expect(e?.contatoVetado).toBe(true);
  });

  it("contato ausente → null (fail-closed)", async () => {
    await expect(
      lerEstadoDoComandoViaSupabase(admin({ contato: null }), {
        organizationId: ORG,
        contactId: CONTATO,
      }),
    ).resolves.toBeNull();
  });
});

describe("liberaEnvioComODonoViaSupabase", () => {
  const args = { organizationId: ORG, contactId: CONTATO, enrollmentId: INSCRICAO };

  it("opção ligada + posse → libera", async () => {
    await expect(
      liberaEnvioComODonoViaSupabase(
        admin({ pointer: { send_when_assigned: true }, contato: contatoComum, conversas: [conversaComDono] }),
        args,
      ),
    ).resolves.toBe(true);
  });

  it("opção desligada + posse → NÃO libera (o padrão é o de hoje)", async () => {
    await expect(
      liberaEnvioComODonoViaSupabase(
        admin({ pointer: { send_when_assigned: false }, contato: contatoComum, conversas: [conversaComDono] }),
        args,
      ),
    ).resolves.toBe(false);
  });

  it("opção ligada + force_human → não libera", async () => {
    await expect(
      liberaEnvioComODonoViaSupabase(
        admin({
          pointer: { send_when_assigned: true },
          contato: { ...contatoComum, force_human: true },
          conversas: [conversaComDono],
        }),
        args,
      ),
    ).resolves.toBe(false);
  });

  it("opção ligada + contato bloqueado → não libera", async () => {
    await expect(
      liberaEnvioComODonoViaSupabase(
        admin({
          pointer: { send_when_assigned: true },
          contato: { ...contatoComum, is_blocked: true },
          conversas: [conversaComDono],
        }),
        args,
      ),
    ).resolves.toBe(false);
  });

  it("opção ligada + silêncio sem dono → não libera", async () => {
    await expect(
      liberaEnvioComODonoViaSupabase(
        admin({
          pointer: { send_when_assigned: true },
          contato: contatoComum,
          conversas: [
            conversaComDono,
            {
              assigned_to_user_id: null,
              bot_silenced_until: "infinity",
              status: "open",
            },
          ],
        }),
        args,
      ),
    ).resolves.toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { linhaDoEspelho } from "@/lib/channels/linha-do-espelho";

// O sync do canal oficial grava `meta_templates` por `waba_id`, com
// `channel_session_id` NULO; os parceiros gravam a conexão. Desde que o envio
// passou a filtrar pela conexão da conversa, o canal oficial não achava a
// própria linha: todo envio de modelo lançava `template_missing`.

const ORG = "org-1";
const OFICIAL = "sessao-oficial";
const PARCEIRO = "sessao-parceiro";
const WABA = "waba-oficial";

type Linha = Record<string, unknown>;

/** Supabase mínimo que APLICA os filtros `eq`/`is`, com uma tabela por nome. */
function banco(tabelas: Record<string, Linha[]>) {
  return {
    from: (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => (filtros.push((l) => l[col] === val), q),
        is: (col: string, val: null) => (filtros.push((l) => l[col] === val), q),
        maybeSingle: async () => {
          const achadas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
          if (achadas.length > 1) return { data: null, error: { message: "multiple rows" } };
          return { data: achadas[0] ?? null, error: null };
        },
      };
      return q;
    },
  } as never;
}

const sessoes: Linha[] = [
  { organization_id: ORG, id: OFICIAL, provider: "meta_cloud", meta_waba_id: WABA },
  { organization_id: ORG, id: PARCEIRO, provider: "datafy", meta_waba_id: null },
];

const modelo = (over: Linha): Linha => ({
  organization_id: ORG,
  name: "retomada",
  language: "pt_BR",
  channel_session_id: null,
  waba_id: WABA,
  status: "APPROVED",
  ...over,
});

const buscar = (db: never, channelSessionId: string | null) =>
  linhaDoEspelho<Linha>(db, "*", { organizationId: ORG, name: "retomada", language: "pt_BR", channelSessionId });

describe("a definição do modelo para uma conexão", () => {
  it("canal oficial: acha a linha do sync, gravada sem conexão, na WABA da sessão", async () => {
    const r = await buscar(banco({ channel_sessions: sessoes, meta_templates: [modelo({})] }), OFICIAL);
    expect(r.error).toBeNull();
    expect(r.data?.status).toBe("APPROVED");
  });

  it("oficial + parceiro com o mesmo nome: cada conexão acha a SUA linha, sem ambiguidade", async () => {
    const db = banco({
      channel_sessions: sessoes,
      meta_templates: [modelo({}), modelo({ channel_session_id: PARCEIRO, waba_id: "waba-parceiro", status: "PENDING" })],
    });
    expect((await buscar(db, OFICIAL)).data?.channel_session_id).toBeNull();
    expect((await buscar(db, PARCEIRO)).data?.status).toBe("PENDING");
  });

  it("parceiro SEM linha própria nunca herda a definição do canal oficial", async () => {
    const r = await buscar(banco({ channel_sessions: sessoes, meta_templates: [modelo({})] }), PARCEIRO);
    expect(r.data).toBeNull();
  });

  it("linha órfã sem conexão de outra conta (parceiro apagado) não serve ao canal oficial", async () => {
    const r = await buscar(
      banco({ channel_sessions: sessoes, meta_templates: [modelo({ waba_id: "waba-parceiro-apagado" })] }),
      OFICIAL,
    );
    expect(r.data).toBeNull();
  });

  it("duas contas oficiais com o mesmo modelo: cada sessão acha a da SUA conta, sem ambiguidade", async () => {
    const db = banco({
      channel_sessions: [...sessoes, { organization_id: ORG, id: "sessao-2", provider: "meta_cloud", meta_waba_id: "waba-2" }],
      meta_templates: [modelo({}), modelo({ waba_id: "waba-2", status: "PAUSED" })],
    });
    expect((await buscar(db, OFICIAL)).data?.status).toBe("APPROVED");
    expect((await buscar(db, "sessao-2")).data?.status).toBe("PAUSED");
  });

  it("linha de OUTRA organização nunca serve — nem a da conexão, nem a sem conexão", async () => {
    const db = banco({
      channel_sessions: sessoes,
      meta_templates: [modelo({ organization_id: "org-2", channel_session_id: OFICIAL }), modelo({ organization_id: "org-2" })],
    });
    expect((await buscar(db, OFICIAL)).data).toBeNull();
    expect((await buscar(db, null)).data).toBeNull();
  });

  it("sem conexão (base anterior à 0144): busca como sempre buscou", async () => {
    const r = await buscar(banco({ meta_templates: [modelo({})] }), null);
    expect(r.data?.status).toBe("APPROVED");
  });
});

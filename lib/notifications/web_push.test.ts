/**
 * O funil do Web Push (`web_push.ts`).
 *
 * - Todo envio alcança só inscrições de quem tem vínculo ATIVO na organização
 *   (`user_organizations.revoked_at` nulo) — os três caminhos passam por aí.
 * - `enviarPushAQuemVeAConversa` (push de `message.received`) só sai para as
 *   inscrições que o banco devolveu como capazes de ver a conversa; a lista de
 *   quem deve ser avisado (responsável + admins) só estreita esse conjunto.
 * - Só sai para serviço de push conhecido (`servicos-de-push.ts`), qualquer
 *   que seja o caminho por onde a inscrição foi gravada.
 * - A faxina 404/410 continua valendo.
 *
 * Roda com: npx vitest run lib/notifications/web_push.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendNotification, deletados } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  deletados: [] as Array<Array<[string, unknown]>>,
}));

vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }));
vi.mock("./vapid", () => ({
  vapidPronto: () => true,
  vapidPublica: () => "pub",
  vapidSubject: async () => "mailto:x@example.com",
}));
vi.mock("@/lib/env", () => ({ env: { VAPID_PRIVATE_KEY: "priv" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";

import { enviarPushAoUsuario, enviarPushAQuemVeAConversa, enviarPushDaOrg } from "./web_push";

type Inscricao = { id: string; user_id: string; endpoint: string; organization_id?: string };
type Membro = { user_id: string; role: string; revoked_at: string | null; organization_id?: string };

const TODOS_ATIVOS: Membro[] = ["u-ana", "u-admin", "u-bruno", "u-carla"].map((user_id) => ({
  user_id,
  role: "agent",
  revoked_at: null,
}));

const ORG_PADRAO = { data: { settings: {}, locale: "pt-BR" }, error: null };

/**
 * Banco falso: aplica `eq`/`is` de verdade sobre as linhas, por tabela; a
 * leitura da opção da empresa em `organizations` devolve `org`.
 */
function adminFalso(opts: {
  visiveis?: Inscricao[];
  inscricoes?: Inscricao[];
  membros?: Membro[];
  erroRpc?: { message: string } | null;
  erroMembros?: { message: string } | null;
  org?: { data: unknown; error: { message: string } | null };
}) {
  const chamadas: Array<[string, unknown]> = [];
  const tabelasLidas: string[] = [];
  const filtrosDaLista: Array<[string, unknown]> = [];
  const tabelas: Record<string, Array<Record<string, unknown>>> = {
    push_subscriptions: (opts.inscricoes ?? []).map((l) => ({ organization_id: "org-1", p256dh: "k", auth: "a", ...l })),
    user_organizations: (opts.membros ?? TODOS_ATIVOS).map((m) => ({ organization_id: "org-1", ...m })),
  };
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      chamadas.push([fn, args]);
      return opts.erroRpc
        ? { data: null, error: opts.erroRpc }
        : { data: (opts.visiveis ?? []).map((l) => ({ ...l, p256dh: "k", auth: "a" })), error: null };
    },
    from: (tabela: string) => {
      tabelasLidas.push(tabela);
      if (tabela === "organizations") {
        const o = { select: () => o, eq: () => o, maybeSingle: async () => opts.org ?? ORG_PADRAO };
        return o;
      }
      const filtros: Array<[string, unknown]> = [];
      let apagando = false;
      const q = {
        select: () => q,
        delete: () => {
          apagando = true;
          return q;
        },
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        is: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        then: (resolve: (r: unknown) => void) => {
          if (apagando) {
            deletados.push(filtros);
            return resolve({ error: null });
          }
          if (tabela === "push_subscriptions") filtrosDaLista.push(...filtros);
          if (tabela === "user_organizations" && opts.erroMembros) {
            return resolve({ data: null, error: opts.erroMembros });
          }
          const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
          return resolve({ data: linhas, error: null });
        },
      };
      return q;
    },
  };
  return { admin, chamadas, tabelasLidas, filtrosDaLista };
}

const payload = { title: "t", body: "b" } as never;
const enviados = () => sendNotification.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockResolvedValue(undefined);
  deletados.length = 0;
});

describe("o push segue o vínculo de quem recebe", () => {
  const inscricoes: Inscricao[] = [
    { id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/ana" },
    { id: "s2", user_id: "u-bruno", endpoint: "https://fcm.googleapis.com/fcm/send/bruno" },
  ];

  it("envio da organização: só às inscrições de quem tem vínculo ativo nela", async () => {
    const { admin } = adminFalso({
      inscricoes,
      membros: [
        { user_id: "u-ana", role: "agent", revoked_at: null },
        { user_id: "u-bruno", role: "agent", revoked_at: "2026-10-01T00:00:00Z" },
      ],
    });
    const r = await enviarPushDaOrg("org-1", payload, {}, admin as never);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/ana"]);
  });

  it("vínculo em OUTRA organização não conta", async () => {
    const { admin } = adminFalso({
      inscricoes,
      membros: [{ user_id: "u-bruno", role: "admin", revoked_at: null, organization_id: "org-2" }],
    });
    const r = await enviarPushDaOrg("org-1", payload, {}, admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("envio a uma pessoa: sem vínculo ativo, nada sai", async () => {
    const { admin } = adminFalso({
      inscricoes,
      membros: [{ user_id: "u-bruno", role: "agent", revoked_at: "2026-10-01T00:00:00Z" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const r = await enviarPushAoUsuario("org-1", "u-bruno", payload);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("envio a uma pessoa: com vínculo ativo, só as inscrições dela", async () => {
    const { admin } = adminFalso({ inscricoes });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const r = await enviarPushAoUsuario("org-1", "u-bruno", payload);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/bruno"]);
  });

  it("conversa: quem o banco devolve como capaz de ver, mas sem vínculo ativo, não recebe", async () => {
    const { admin } = adminFalso({
      visiveis: inscricoes,
      membros: [{ user_id: "u-ana", role: "agent", revoked_at: null }],
    });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/ana"]);
  });

  it("com papel mínimo, só quem o alcança recebe (papel desconhecido não alcança)", async () => {
    const { admin } = adminFalso({
      inscricoes: [
        { id: "s1", user_id: "u-viewer", endpoint: "https://fcm.googleapis.com/fcm/send/viewer" },
        { id: "s2", user_id: "u-agent", endpoint: "https://fcm.googleapis.com/fcm/send/agent" },
        { id: "s3", user_id: "u-admin", endpoint: "https://fcm.googleapis.com/fcm/send/admin" },
        { id: "s4", user_id: "u-x", endpoint: "https://fcm.googleapis.com/fcm/send/x" },
      ],
      membros: [
        { user_id: "u-viewer", role: "viewer", revoked_at: null },
        { user_id: "u-agent", role: "agent", revoked_at: null },
        { user_id: "u-admin", role: "admin", revoked_at: null },
        { user_id: "u-x", role: "dono", revoked_at: null },
      ],
    });
    const r = await enviarPushDaOrg("org-1", payload, { papelMinimo: "agent" }, admin as never);
    expect(r).toEqual({ sent: 2, gone: 0 });
    expect(enviados().sort()).toEqual(["https://fcm.googleapis.com/fcm/send/admin", "https://fcm.googleapis.com/fcm/send/agent"]);
  });

  it("só sai para serviço de push conhecido, mesmo com a inscrição já gravada", async () => {
    const { admin } = adminFalso({
      inscricoes: [
        { id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/ana" },
        { id: "s2", user_id: "u-ana", endpoint: "https://exemplo.invalid/ana" },
        { id: "s3", user_id: "u-bruno", endpoint: "https://fcm.googleapis.com:8443/fcm/send/bruno" },
      ],
    });
    const r = await enviarPushDaOrg("org-1", payload, {}, admin as never);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/ana"]);
  });

  it("falha ao ler os vínculos → ninguém recebe", async () => {
    const { admin } = adminFalso({ inscricoes, erroMembros: { message: "banco fora" } });
    const r = await enviarPushDaOrg("org-1", payload, {}, admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("enviarPushAQuemVeAConversa", () => {
  it("pergunta ao banco quem vê a conversa DO EVENTO e envia só a essas inscrições", async () => {
    const { admin, chamadas } = adminFalso({
      visiveis: [
        { id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/1" },
        { id: "s2", user_id: "u-admin", endpoint: "https://fcm.googleapis.com/fcm/send/2" },
      ],
    });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 2, gone: 0 });
    expect(chamadas).toEqual([
      ["fn_push_inscricoes_que_veem_a_conversa", { p_org: "org-1", p_conversation: "conv-1" }],
    ]);
  });

  it("a lista de quem deve ser avisado só estreita: quem não pode ver não entra por ela", async () => {
    const { admin } = adminFalso({ visiveis: [{ id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/ana" }] });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, ["u-ana", "u-bruno"], admin as never);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/ana"]);
  });

  it("quem pode ver mas não está na lista decidida não recebe", async () => {
    const { admin } = adminFalso({
      visiveis: [
        { id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/ana" },
        { id: "s2", user_id: "u-carla", endpoint: "https://fcm.googleapis.com/fcm/send/carla" },
      ],
    });
    await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, ["u-ana"], admin as never);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("inscrição morta (410) é apagada, com a organização no filtro", async () => {
    sendNotification.mockReset();
    sendNotification.mockRejectedValueOnce({ statusCode: 410 }).mockResolvedValueOnce(undefined);
    const { admin } = adminFalso({
      visiveis: [
        { id: "morta", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/1" },
        { id: "viva", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/2" },
      ],
    });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 1, gone: 1 });
    expect(deletados).toEqual([[["id", "morta"], ["organization_id", "org-1"]]]);
  });

  it("lista decidida vazia não consulta nem envia nada", async () => {
    const { admin, chamadas } = adminFalso({ visiveis: [{ id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/1" }] });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, [], admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(chamadas).toEqual([]);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("falha ao perguntar quem vê → ninguém recebe", async () => {
    const { admin } = adminFalso({ erroRpc: { message: "banco fora" } });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

/** O que de fato chegou ao serviço de push (o 2º argumento de `sendNotification`). */
function enviado(i = 0): Record<string, unknown> {
  return JSON.parse(sendNotification.mock.calls[i]![1] as string) as Record<string, unknown>;
}

const doCliente = {
  title: "Ana",
  body: "texto do cliente",
  icon: "https://avatar",
  corpoSemPrevia: "Nova mensagem",
  tag: "msg:c1",
  href: "/app/inbox?id=c1",
};

const UMA: Inscricao[] = [{ id: "s1", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/1" }];

const comOpcao = (valor: string) => ({
  data: { settings: { notificacoes: { conteudo_na_tela_bloqueada: valor } }, locale: "pt-BR" },
  error: null,
});

const entradas = [
  [
    "enviarPushDaOrg",
    (admin: unknown) => enviarPushDaOrg("org-1", doCliente, {}, admin as never),
  ],
  [
    "enviarPushAoUsuario",
    (admin: unknown) => {
      vi.mocked(createAdminClient).mockReturnValue(admin as never);
      return enviarPushAoUsuario("org-1", "u-ana", doCliente);
    },
  ],
  [
    "enviarPushAQuemVeAConversa",
    (admin: unknown) => enviarPushAQuemVeAConversa("org-1", "conv-1", doCliente, undefined, admin as never),
  ],
] as const;

describe.each(entradas)("o funil da tela bloqueada — %s", (_nome, enviar) => {
  it("modo oculto: sem corpo, sem ícone, título neutro, e o corpo sem prévia nunca sai", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso({ inscricoes: UMA, visiveis: UMA, org: comOpcao("oculto") });
    await enviar(admin);
    const saida = enviado();
    expect(saida.body).toBe("");
    expect(saida.title).toBe("Novo aviso");
    expect(saida).not.toHaveProperty("icon");
    expect(saida).not.toHaveProperty("corpoSemPrevia");
    expect(saida).toMatchObject({ tag: "msg:c1", href: "/app/inbox?id=c1" });
  });

  it("modo nome: o corpo é o declarado sem prévia e o ícone fica", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso({ inscricoes: UMA, visiveis: UMA, org: comOpcao("nome") });
    await enviar(admin);
    expect(enviado()).toStrictEqual({
      title: "Ana",
      body: "Nova mensagem",
      icon: "https://avatar",
      tag: "msg:c1",
      href: "/app/inbox?id=c1",
    });
  });

  it("leitura da opção falha → sai no modo oculto", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso({ inscricoes: UMA, visiveis: UMA, org: { data: null, error: { message: "fora" } } });
    await enviar(admin);
    expect(enviado()).toMatchObject({ title: "Novo aviso", body: "" });
  });

  it("sem inscrição nenhuma não lê a opção da empresa", async () => {
    const { admin, tabelasLidas } = adminFalso({});
    expect(await enviar(admin)).toEqual({ sent: 0, gone: 0 });
    expect(tabelasLidas).not.toContain("organizations");
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("as listas de inscrição", () => {
  it("da organização filtra pela organização; do usuário, por organização e usuário", async () => {
    sendNotification.mockResolvedValue(undefined);
    const org = adminFalso({ inscricoes: UMA });
    await enviarPushDaOrg("org-1", doCliente, {}, org.admin as never);
    expect(org.filtrosDaLista).toEqual([["organization_id", "org-1"]]);

    const usuario = adminFalso({ inscricoes: UMA });
    vi.mocked(createAdminClient).mockReturnValue(usuario.admin as never);
    await enviarPushAoUsuario("org-1", "u-ana", doCliente);
    expect(usuario.filtrosDaLista).toEqual([
      ["organization_id", "org-1"],
      ["user_id", "u-ana"],
    ]);
  });
});

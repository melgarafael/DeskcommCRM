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

import {
  enviarPushAoUsuario,
  enviarPushAQuemVeAConversa,
  enviarPushDaEtapaAQuemVeONegocio,
  enviarPushDaOrg,
} from "./web_push";

type Inscricao = { id: string; user_id: string; endpoint: string; organization_id?: string; tipos_calados?: string[] };
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
  /** As inscrições que o banco devolve como capazes de ver; `ampla` só vem do RPC de negócio. */
  visiveis?: Array<Inscricao & { ampla?: boolean }>;
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
    push_subscriptions: (opts.inscricoes ?? opts.visiveis ?? []).map((l) => ({
      organization_id: "org-1",
      p256dh: "k",
      auth: "a",
      tipos_calados: [],
      ...l,
    })),
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
      let dentroDe: [string, readonly unknown[]] | null = null;
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
        in: (c: string, v: readonly unknown[]) => {
          dentroDe = [c, v];
          return q;
        },
        contains: (c: string, v: unknown) => {
          filtros.push([`contains:${c}`, v]);
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
          const linhas = (tabelas[tabela] ?? [])
            .filter((l) =>
              filtros.every(([c, v]) =>
                c.startsWith("contains:")
                  ? (v as unknown[]).every((x) => (l[c.slice("contains:".length)] as unknown[] | undefined)?.includes(x))
                  : l[c] === v,
              ),
            )
            .filter((l) => !dentroDe || dentroDe[1].includes(l[dentroDe[0]]));
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

  it("envio a uma lista de pessoas: só as inscrições delas", async () => {
    const { admin } = adminFalso({ inscricoes });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const r = await enviarPushDaOrg("org-1", payload, { soUsuarios: ["u-bruno", "u-ana"] });
    expect(r).toEqual({ sent: 2, gone: 0 });
    expect(enviados().sort()).toEqual(
      inscricoes.filter((i) => ["u-bruno", "u-ana"].includes(i.user_id)).map((i) => i.endpoint).sort(),
    );
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


describe("enviarPushDaEtapaAQuemVeONegocio", () => {
  const FIXO = "Negócio entrou em «Pago»";
  const COM_VALOR = `${FIXO} · R$ 1.250,00`;
  const textos = {
    ampla: { title: COM_VALOR, body: "Hoje nesta etapa: 2 (R$ 1.500,00)", corpoSemPrevia: FIXO, tag: "aviso:i1", href: "/app/pipelines/p1?lead=l1" },
    daCarteira: { title: COM_VALOR, body: FIXO, corpoSemPrevia: FIXO, tag: "aviso:i1", href: "/app/pipelines/p1?lead=l1" },
    semValor: { title: FIXO, body: FIXO, corpoSemPrevia: FIXO, tag: "aviso:i1", href: "/app/pipelines/p1?lead=l1" },
  };
  const MED = "https://fcm.googleapis.com/fcm/send/med";
  const DONO = "https://fcm.googleapis.com/fcm/send/dono";
  const ALHEIO = "https://fcm.googleapis.com/fcm/send/alheio";
  // Os três têm vínculo ativo na organização (TODOS_ATIVOS, papel `agent`): o
  // que separa o que cada um recebe é só `fn_can_view_lead`, não o papel.
  const INSCRICOES: Inscricao[] = [
    { id: "s-med", user_id: "u-admin", endpoint: MED },
    { id: "s-dono", user_id: "u-bruno", endpoint: DONO },
    { id: "s-alheio", user_id: "u-ana", endpoint: ALHEIO },
  ];

  /** O que chegou a cada inscrição, por endpoint (as chamadas são concorrentes). */
  function porEndpoint(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      sendNotification.mock.calls.map((c) => [
        (c[0] as { endpoint: string }).endpoint,
        JSON.parse(c[1] as string) as Record<string, unknown>,
      ]),
    );
  }

  it("o valor vai a quem VÊ o negócio; quem não vê recebe a mesma frase de antes", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin, chamadas, filtrosDaLista } = adminFalso({
      inscricoes: INSCRICOES,
      visiveis: [
        { id: "s-med", user_id: "u-admin", endpoint: MED, ampla: true },
        { id: "s-dono", user_id: "u-bruno", endpoint: DONO, ampla: false },
      ],
      org: comOpcao("nome_e_previa"),
    });
    const r = await enviarPushDaEtapaAQuemVeONegocio("org-1", "l1", textos, "agent", admin as never);
    expect(r).toEqual({ sent: 3, gone: 0 });
    expect(chamadas).toEqual([["fn_push_inscricoes_que_veem_o_negocio", { p_org: "org-1", p_lead: "l1" }]]);
    // Service role: a organização vai junto na leitura das inscrições.
    expect(filtrosDaLista).toContainEqual(["organization_id", "org-1"]);

    const chegou = porEndpoint();
    expect(chegou[MED]).toMatchObject({ title: COM_VALOR, body: "Hoje nesta etapa: 2 (R$ 1.500,00)" });
    expect(chegou[DONO]).toMatchObject({ title: COM_VALOR, body: FIXO });
    expect(chegou[ALHEIO]).toMatchObject({ title: FIXO, body: FIXO });
    // A carteira alheia não vaza para quem não vê o negócio.
    expect(JSON.stringify(chegou[ALHEIO])).not.toContain("R$");
  });

  it("quem vê, mas não alcança o papel mínimo, continua fora (a régua não alarga a audiência)", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso({
      inscricoes: INSCRICOES,
      membros: INSCRICOES.map((i) => ({ user_id: i.user_id, role: "agent", revoked_at: null })),
      visiveis: [
        { id: "s-med", user_id: "u-admin", endpoint: MED, ampla: true },
        { id: "s-dono", user_id: "u-bruno", endpoint: DONO, ampla: false },
      ],
      org: comOpcao("nome_e_previa"),
    });
    const r = await enviarPushDaEtapaAQuemVeONegocio("org-1", "l1", textos, "manager", admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("falha ao perguntar quem vê: a frase fixa para todos, valor para ninguém", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso({ inscricoes: INSCRICOES, erroRpc: { message: "banco fora" }, org: comOpcao("nome_e_previa") });
    const r = await enviarPushDaEtapaAQuemVeONegocio("org-1", "l1", textos, "agent", admin as never);
    expect(r).toEqual({ sent: 3, gone: 0 });
    const chegou = porEndpoint();
    for (const endpoint of [MED, DONO, ALHEIO]) expect(chegou[endpoint]).toMatchObject({ title: FIXO, body: FIXO });
    expect(JSON.stringify(chegou)).not.toContain("R$");
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

describe("o aparelho escolhe os tipos de aviso (push_subscriptions.tipos_calados)", () => {
  // O caso do Adilson (09/11/2026): o celular dele calou "Nova mensagem" e quer
  // só "Lead atribuído a você"; o computador dele não calou nada.
  const inscricoes: Inscricao[] = [
    { id: "s1", user_id: "u-ana", endpoint: "https://web.push.apple.com/celular", tipos_calados: ["message", "handoff"] },
    { id: "s2", user_id: "u-ana", endpoint: "https://fcm.googleapis.com/fcm/send/computador" },
  ];

  it("aviso de um tipo calado não vai ao aparelho que o calou, e vai ao outro", async () => {
    const { admin } = adminFalso({ visiveis: inscricoes });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", { title: "t", body: "b", tipo: "message" }, undefined, admin as never);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/computador"]);
  });

  it("tipo que o aparelho NÃO calou chega aos dois (controle)", async () => {
    const { admin } = adminFalso({ inscricoes });
    const r = await enviarPushDaOrg("org-1", { title: "t", body: "b", tipo: "lead_assigned" }, { soUsuario: "u-ana" }, admin as never);
    expect(r).toEqual({ sent: 2, gone: 0 });
  });

  it("aviso sem tipo (sem saldo, proposta para revisar) chega sempre, e nem consulta os calados", async () => {
    const { admin, filtrosDaLista } = adminFalso({ inscricoes });
    const r = await enviarPushDaOrg("org-1", { title: "t", body: "b" }, {}, admin as never);
    expect(r).toEqual({ sent: 2, gone: 0 });
    expect(filtrosDaLista.some(([c]) => c.startsWith("contains:"))).toBe(false);
  });

  it("a consulta dos calados filtra a organização do envio", async () => {
    const { admin, filtrosDaLista } = adminFalso({ inscricoes });
    await enviarPushDaOrg("org-1", { title: "t", body: "b", tipo: "handoff" }, {}, admin as never);
    expect(filtrosDaLista).toContainEqual(["contains:tipos_calados", ["handoff"]]);
    expect(filtrosDaLista.filter(([c]) => c === "organization_id").every(([, v]) => v === "org-1")).toBe(true);
    expect(enviados()).toEqual(["https://fcm.googleapis.com/fcm/send/computador"]);
  });
});

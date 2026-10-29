/**
 * Semeia a empresa de demonstração do curso ("Clínica Bem Viver") numa
 * instalação FRESCA (baseline.sql + scripts/bootstrap-owner.ts): equipe, número
 * de WhatsApp, agente de IA publicado, respostas rápidas e 12 conversas nos
 * estados que as lições fotografam. Grava curso/saida/contas.json.
 *
 *   set -a; . ./.env.e2e; set +a; pnpm exec tsx curso/semear-demonstracao.ts [modulo]
 *
 * Com [modulo], depois da base roda curso/semear/<modulo>.ts — os dados que só
 * aquela tela precisa (agenda, tarefas, casos…). Ela recebe o Contexto abaixo,
 * limpa SÓ as próprias linhas e recria: um módulo nunca apaga o dado de outro.
 *
 * Idempotente: apaga as conversas e os contatos da organização e recria tudo
 * com os mesmos ids — as lições mudam o estado (assumir, fechar, transferir),
 * então o capturador roda isto antes de cada lição (CURSO_ANTES_DA_LICAO).
 *
 * Recusa qualquer Supabase que não seja local. Rode com o worker PARADO: com ele
 * de pé, as mensagens semeadas acordam a IA. Horários são relativos ao seed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type User, createClient } from "@supabase/supabase-js";
import pg from "pg";

import { exigirBancoLocal, exigirHttpLocal, validarOrganizacoesExtras } from "./seguranca";
import { commitDaFoto, idiomaDaCaptura } from "./configuracao";
import { textoDaDemonstracao as demo } from "./espanhol-demonstracao";

const SENHA = process.env.CURSO_SENHA ?? "Curso!Demo2026";
let db: ReturnType<typeof criarBanco>;
/** Importar ajudantes não abre conexão nem exige credenciais. */
function criarBanco() {
  const url = exigirHttpLocal(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!chave) throw new Error("defina SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, chave, { auth: { autoRefreshToken: false, persistSession: false } });
}
const MIN = 60_000;
const agora = Date.now();
export const ha = (minutos: number) => new Date(agora - minutos * MIN).toISOString();
/** "Ontem às HH:MM" no fuso de São Paulo (UTC-3, sem horário de verão). */
export function ontemAs(h: number, m: number) {
  const sp = new Date(agora - 3 * 60 * MIN);
  return new Date(
    Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - 1, h + 3, m),
  ).toISOString();
}
export const conversaId = (n: number) => `be100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const contatoId = (n: number) => `be200000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function exigir<T>(
  r: { data: T | null; error: { message: string } | null },
  onde: string,
): T {
  if (r.error) throw new Error(`${onde}: ${r.error.message}`);
  if (r.data === null) throw new Error(`${onde}: sem dados`);
  return r.data;
}
/** Respostas do GoTrue: no erro o `user` vem null, então o tipo não cabe no `exigir`. */
function usuarioDe(
  r: { data: { user: User | null }; error: { message: string } | null },
  onde: string,
): User {
  if (r.error || !r.data.user) throw new Error(`${onde}: ${r.error?.message ?? "sem usuário"}`);
  return r.data.user;
}
async function todosOsUsuarios(): Promise<User[]> {
  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);
  return r.data.users;
}
/** Para chamadas que não devolvem linha (RPC void, delete): só o erro importa. */
export function semErro(r: { error: { message: string } | null }, onde: string) {
  if (r.error) throw new Error(`${onde}: ${r.error.message}`);
}

const EMAIL = {
  helena: "helena@clinicabemviver.com.br",
  ana: "ana@clinicabemviver.com.br",
  carlos: "carlos@clinicabemviver.com.br",
};

async function membro(email: string, nome: string, papel: "manager" | "agent", orgId: string) {
  let u = (await todosOsUsuarios()).find((x) => x.email === email);
  if (!u) {
    u = usuarioDe(
      await db.auth.admin.createUser({
        email,
        password: SENHA,
        email_confirm: true,
        user_metadata: { full_name: nome, locale: idiomaDaCaptura() },
      }),
      `createUser ${email}`,
    );
  } else {
    // sem senha aqui: trocar a senha encerra as sessões abertas, e o capturador entra uma vez só
    usuarioDe(
      await db.auth.admin.updateUserById(u.id, {
        user_metadata: { full_name: nome, locale: idiomaDaCaptura() },
      }),
      `updateUser ${email}`,
    );
  }
  semErro(
    await db.from("user_organizations").upsert(
      {
        user_id: u.id,
        organization_id: orgId,
        role: papel,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: "user_id,organization_id" },
    ),
    `user_organizations ${email}`,
  );
  return u.id;
}

type Quem = "cliente" | "ia" | "helena" | "ana";
type Msg = {
  em: string;
  quem: Quem;
  texto: string;
  status?: "read" | "delivered" | "failed";
  grupo?: { name: string; phone: string };
};
const m = (minutos: number, quem: Quem, texto: string, extra: Partial<Msg> = {}): Msg => ({
  em: ha(minutos),
  quem,
  texto,
  ...extra,
});

type Conversa = {
  n: number;
  nome: string;
  telefone: string | null;
  etiquetasContato?: string[];
  etiquetasConversa?: string[];
  contato?: { force_human?: boolean; is_blocked?: boolean };
  mensagens: Msg[];
  dono?: "helena" | "ana" | "carlos";
  motivoDono?: "claim" | "routing";
  status?: "ai_handling" | "claimed" | "closed" | "archived";
  silencio?: boolean;
  naoLidas: number;
  exemplo?: boolean;
  grupo?: string;
};

const CONVERSAS: Conversa[] = [
  {
    n: 1,
    nome: "Mariana Souza",
    telefone: "+5511987650001",
    etiquetasContato: ["primeira-consulta", "particular"],
    etiquetasConversa: ["agendamento"],
    mensagens: [
      m(45, "cliente", "Oi, boa tarde! Queria marcar uma consulta com a nutricionista."),
      m(
        44,
        "ia",
        "Olá, Mariana! Posso te ajudar com o agendamento. Você já é paciente da clínica?",
      ),
      m(
        40,
        "cliente",
        "Na verdade prefiro falar com uma pessoa, tenho umas dúvidas sobre o plano alimentar.",
      ),
      m(38, "cliente", "Pode ser?"),
    ],
    silencio: true,
    naoLidas: 2,
  },
  {
    n: 2,
    nome: "Roberto Almeida",
    telefone: "+5511987650002",
    contato: { force_human: true },
    mensagens: [
      m(
        12,
        "cliente",
        "Bom dia, preciso remarcar a fisioterapia de amanhã, surgiu um imprevisto no trabalho.",
      ),
    ],
    naoLidas: 1,
  },
  {
    n: 3,
    nome: "Juliana Castro",
    telefone: "+5511987650003",
    etiquetasContato: ["convenio"],
    mensagens: [
      m(92, "cliente", "Vocês atendem pelo convênio Unimed?"),
      m(
        90,
        "ia",
        "Atendemos sim, Juliana! Para fisioterapia e nutrição. Quer que eu veja um horário para você?",
      ),
    ],
    status: "ai_handling",
    naoLidas: 0,
  },
  {
    n: 4,
    nome: "Pedro Henrique Lima",
    telefone: "+5511987650004",
    mensagens: [
      m(6, "cliente", "Qual o valor da consulta particular com a nutricionista?"),
      m(5, "ia", "A consulta particular custa R$ 280,00, Pedro, e inclui o retorno em 30 dias."),
      m(3, "cliente", "E aceitam Pix?"),
    ],
    status: "ai_handling",
    naoLidas: 1,
  },
  {
    n: 5,
    nome: "Fernanda Oliveira",
    telefone: "+5511987650005",
    etiquetasContato: ["retorno", "convenio", "pos-operatorio"],
    mensagens: [
      {
        em: ontemAs(16, 2),
        quem: "cliente",
        texto:
          "Boa tarde! Fiz a cirurgia semana passada e preciso marcar o retorno com o Dr. Paulo.",
      },
      {
        em: ontemAs(16, 3),
        quem: "ia",
        texto:
          "Oi, Fernanda! Que bom ter notícias suas. Vou verificar os horários do Dr. Paulo para você.",
      },
      { em: ontemAs(16, 10), quem: "cliente", texto: "Pode ser na quinta de manhã?" },
      m(130, "helena", "Bom dia, Fernanda! Tenho quinta às 9h30 com o Dr. Paulo. Posso confirmar?"),
      m(125, "cliente", "Pode sim! Preciso levar algum exame?"),
      m(123, "helena", "Traga o laudo da cirurgia e a lista de remédios que está tomando.", {
        status: "delivered",
      }),
      m(122, "helena", "Endereço: Rua das Acácias, 120 — 3º andar.", { status: "failed" }),
    ],
    dono: "helena",
    status: "claimed",
    silencio: true,
    naoLidas: 0,
  },
  {
    n: 6,
    nome: "Lucas Martins",
    telefone: "+5511987650006",
    mensagens: [
      m(185, "ana", "Combinado, Lucas! Sua sessão fica para sexta às 18h."),
      m(180, "cliente", "Obrigado, Ana! Até sexta."),
    ],
    dono: "ana",
    status: "claimed",
    silencio: true,
    naoLidas: 0,
  },
  {
    n: 7,
    nome: "Camila Rocha",
    telefone: "+5511987650007",
    mensagens: [
      m(52, "cliente", "Oi! A avaliação postural é feita no mesmo dia da primeira sessão?"),
      m(
        50,
        "ia",
        "Oi, Camila! Sim, a avaliação acontece no início da primeira sessão e leva uns 20 minutos.",
      ),
    ],
    dono: "helena",
    motivoDono: "routing",
    status: "claimed",
    naoLidas: 0,
  },
  {
    n: 8,
    nome: "Beatriz Nogueira",
    telefone: "+5511987650008",
    mensagens: [m(2 * 24 * 60, "cliente", "Muito obrigada pelo atendimento, até a próxima!")],
    dono: "carlos",
    status: "closed",
    naoLidas: 0,
  },
  {
    n: 9,
    nome: "Antônio Ferreira",
    telefone: "+5511987650009",
    mensagens: [m(6 * 24 * 60, "cliente", "Vou ver com minha esposa e depois retorno.")],
    status: "archived",
    naoLidas: 0,
  },
  {
    n: 10,
    nome: "Turma de Pilates — Terça 19h",
    telefone: null,
    grupo: "120363025000000001@g.us",
    mensagens: [
      m(5, "cliente", "Gente, amanhã alguém consegue trocar de horário comigo?", {
        grupo: { name: "Sônia Prado", phone: "+5511987650020" },
      }),
    ],
    naoLidas: 1,
  },
  {
    n: 11,
    nome: "Osvaldo Pires",
    telefone: "+5511987650011",
    contato: { is_blocked: true },
    mensagens: [m(24 * 60, "cliente", "Parem de me mandar mensagem.")],
    status: "closed",
    naoLidas: 0,
  },
  {
    n: 12,
    nome: "Tereza Gomes",
    telefone: "+5511987650012",
    mensagens: [
      m(305, "cliente", "Consegui fazer os exercícios em casa, obrigada pelas dicas!"),
      m(300, "ana", "Que ótimo, Tereza! Continue 3 vezes por semana e me conte na próxima sessão."),
    ],
    dono: "ana",
    status: "closed",
    exemplo: true,
    naoLidas: 0,
  },
];

/** O que a base deixa pronto para a semente de um módulo. */
export type Contexto = {
  db: typeof db;
  org: string;
  pessoa: { helena: string; ana: string; carlos: string };
  sessao: string;
  agenteId: string;
  funil: { id: string; etapas: string[] };
};

/**
 * Estado de fábrica da instalação: o que um módulo pode ligar/desligar e que vale
 * para TODAS as telas (recursos opcionais, marca, cadastro, credenciais da
 * instalação, configurações da organização). A primeira rodada numa instalação
 * fresca guarda; as seguintes devolvem tudo a ele antes de cada lição. Sem isto,
 * o módulo que liga "Propostas" muda o menu nas fotos de todos os outros.
 */
const DA_INSTALACAO = {
  platform_config: "chave",
  platform_settings: "id",
  platform_branding: "id",
  modulos_instalados: "modulo",
  // quem administra a plataforma (e se exige verificação em duas etapas): uma lição que tirasse a
  // Helena daqui, ou ligasse o MFA dela, trancaria o capturador fora de todas as lições seguintes
  platform_admins: "user_id",
} as const;
/** Colunas da organização que uma tela pode mudar (fuso, idioma, retenção, marca, suspensão…). */
const DA_ORGANIZACAO = [
  "slug",
  "legal_name",
  "display_name",
  "cnpj",
  "status",
  "timezone",
  "locale",
  "ai_budget_cents",
  "country",
  "currency",
  "media_retention_enforced",
  "media_retention_days",
  "settings",
  "dpo_email",
  "privacy_policy_url",
  "suspended_at",
  "redacted_at",
  "suspended_reason",
  "suspended_by",
] as const;
type Linha = Record<string, unknown>;

async function voltarAoEstadoDeFabrica(org: string, saida: string) {
  const arquivo = path.join(saida, ".fabrica.json");
  if (!existsSync(arquivo)) {
    const tabelas: Record<string, Linha[]> = {};
    for (const t of Object.keys(DA_INSTALACAO))
      tabelas[t] = exigir(await db.from(t).select("*"), `fábrica ${t}`) as Linha[];
    // lê a linha inteira e guarda só as colunas da lista que existem: o baseline remove colunas em apêndice
    const linha = exigir(
      await db.from("organizations").select("*").eq("id", org).single(),
      "fábrica org",
    ) as Linha;
    const organizacao = Object.fromEntries(
      DA_ORGANIZACAO.filter((c) => c in linha).map((c) => [c, linha[c]]),
    );
    mkdirSync(saida, { recursive: true });
    const appMeta = exigir(await db.from("platform_meta_app").select("*"), "fábrica App da Meta");
    writeFileSync(arquivo, JSON.stringify({ tabelas, organizacao, appMeta }, null, 2));
    console.info("estado de fábrica guardado");
    return;
  }
  const fabrica = JSON.parse(readFileSync(arquivo, "utf8")) as {
    tabelas: Record<string, Linha[]>;
    organizacao: Linha;
    appMeta?: Linha[];
  };
  // Snapshot antigo não contém estas colunas. Defaults do baseline, nunca o valor já alterado
  // por uma lição: copiar o estado atual aqui perpetuaria a contaminação que queremos desfazer.
  const organizacao = {
    country: null,
    currency: "BRL",
    media_retention_enforced: true,
    ...fabrica.organizacao,
  };
  for (const [t, chave] of Object.entries(DA_INSTALACAO)) {
    const guardadas = fabrica.tabelas[t] ?? [];
    const agora = exigir(await db.from(t).select(chave), `estado ${t}`) as unknown as Linha[];
    const sobrando = agora
      .map((l) => l[chave])
      .filter((k) => !guardadas.some((g) => g[chave] === k));
    if (sobrando.length)
      semErro(
        await db
          .from(t)
          .delete()
          .in(chave, sobrando as string[]),
        `voltar ${t}`,
      );
    if (guardadas.length)
      semErro(await db.from(t).upsert(guardadas, { onConflict: chave }), `voltar ${t}`);
  }
  semErro(await db.from("organizations").update(organizacao).eq("id", org), "voltar a organização");
  // A Meta não concede DELETE ao service_role. Como no módulo admin-meta, só a bancada local
  // pode restaurar a linha inteira (incluindo o estado "Nunca configurado por aqui").
  const metaAtual = exigir(
    await db.from("platform_meta_app").select("*"),
    "App da Meta atual",
  ) as Linha[];
  const appMeta = fabrica.appMeta ?? [];
  if (JSON.stringify(metaAtual) !== JSON.stringify(appMeta)) {
    const cli = new pg.Client({ connectionString: exigirBancoLocal(process.env.SUPABASE_DB_URL) });
    await cli.connect();
    try {
      // SUPABASE_DB_URL pode apontar por engano para OUTRO Postgres local. A organização
      // resolvida pelo client precisa existir também na conexão direta antes do DELETE.
      const identidade = await cli.query("select id from public.organizations where id = $1", [
        org,
      ]);
      if (identidade.rowCount !== 1)
        throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
      await cli.query("delete from public.platform_meta_app where id = 1");
      if (appMeta.length)
        semErro(await db.from("platform_meta_app").upsert(appMeta), "restaurar App da Meta");
    } finally {
      await cli.end();
    }
  }
}

/**
 * A bancada não tem o agente do servidor, então o rodapé diria "Execução não confirmada" em toda
 * foto. Grava a observação que o agente de uma instalação saudável envia (lib/system/runtime-identity):
 * a versão das fotos, nos três serviços, recolhida agora. Ela vale 15 minutos, e a semente roda
 * antes de cada aula. A aula da Atualização muda este estado na própria semente.
 */
export function versaoDasFotos(): string {
  const versao = (process.env.CURSO_VERSAO_FOTOS ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(versao)) throw new Error("CURSO_VERSAO_FOTOS precisa da versão fotografada (ex.: 1.94.0)");
  return versao;
}

export async function confirmarVersaoDaInstalacao(
  versao = versaoDasFotos(),
  publicada = versao,
  changelog = "",
) {
  const revisao = commitDaFoto();
  const agora = new Date().toISOString();
  // A aula da Atualização pede uma, e um pedido aberto trava as extensões
  // (fn_extensions_core_update_in_progress): toda aula começa sem pedido.
  semErro(
    await db.from("system_update_runs").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
    "pedidos de atualização",
  );
  const hex = (n: number) => String(n).repeat(64);
  semErro(
    await db
      .from("system_version")
      .update({
        current_version: versao,
        latest_version: publicada,
        changelog_raw: changelog,
        has_known_release: true,
        off_release: false,
        compare_failed: false,
        agent_last_seen_at: agora,
        update_requested_at: null,
        update_requested_by: null,
        runtime_confirmation: {
          schema: 1,
          collected_at: agora,
          project: "deskcomm",
          supports_forced_update: true,
          published_release: publicada,
          services: (["app", "worker", "scheduler"] as const).map((role, i) => ({
            role,
            container_id: hex(i + 1),
            image_id: `sha256:${hex(i + 4)}`,
            revision: revisao,
            base_version: versao,
            base_revision: revisao,
            source_verified: true,
            running: true,
            healthy: true,
          })),
          issues: [],
        },
      } as never)
      .eq("id", 1),
    "versão da instalação",
  );
}

export async function semearBase(): Promise<Contexto> {
  db = criarBanco();
  // ---------- organização ----------
  // A da instalação é a do dono (a Helena), NUNCA "a mais antiga": sementes do Admin criam empresas
  // e admins de exemplo com datas no passado, e por created_at a base chegou a escolher uma delas e
  // tentar apagar a Clínica. O dono é achado pelo e-mail que a própria base grava; na primeira rodada
  // de uma instalação fresca (antes da troca de e-mail) ele é o único admin da plataforma.
  const helena = (await todosOsUsuarios()).find((u) => u.email === EMAIL.helena);
  const donoId =
    helena?.id ??
    (
      exigir(
        await db.from("platform_admins").select("user_id").order("granted_at").limit(1).single(),
        "dono da instalação",
      ) as { user_id: string }
    ).user_id;
  const vinculos = exigir(
    await db
      .from("user_organizations")
      .select("organization_id")
      .eq("user_id", donoId)
      .eq("role", "admin"),
    "organização do dono",
  ) as Array<{ organization_id: string }>;
  if (vinculos.length !== 1)
    throw new Error(
      `o dono devia ser admin de UMA organização, é de ${vinculos.length} — semente de módulo pôs a Helena noutra empresa?`,
    );
  const org = vinculos[0]!.organization_id;
  // as outras são de sementes de módulo e somem aqui — senão apareceriam no seletor de empresa de
  // todas as fotos. Saem pelo caminho do produto (fn_excluir_organizacao desarma as armadilhas da
  // cascata), depois de tirar a assinatura de exemplo que trava a exclusão.
  const extras = exigir(
    await db.from("organizations").select("id, slug").neq("id", org),
    "organizações extras",
  ) as Array<{ id: string; slug: string }>;
  // Recusar dados desconhecidos ANTES do primeiro DELETE: este script só limpa a bancada do curso.
  // Todos os ids de empresas de exemplo são declarados nestas sementes.
  validarOrganizacoesExtras(org, extras);
  for (const x of extras) {
    semErro(
      await db.from("cobranca_assinaturas").delete().eq("organization_id", x.id),
      `assinatura de ${x.slug}`,
    );
    semErro(
      await db
        .from("organizations")
        .update({
          status: "suspended",
          suspended_kind: "administrativa",
          suspended_at: new Date().toISOString(),
        })
        .eq("id", x.id),
      `suspender ${x.slug}`,
    );
    semErro(
      await db.rpc("fn_excluir_organizacao", {
        p_org: x.id,
        p_actor: donoId,
        p_confirmacao: x.slug,
        p_motivo: "curso: empresa de exemplo de outro módulo",
      }),
      `excluir ${x.slug}`,
    );
  }
  const saida = path.join(path.dirname(new URL(import.meta.url).pathname), "saida");
  await voltarAoEstadoDeFabrica(org, saida);
  await confirmarVersaoDaInstalacao();
  semErro(
    await db
      .from("organizations")
      .update({
        locale: idiomaDaCaptura(),
        display_name: "Clínica Bem Viver",
        legal_name: "Clínica Bem Viver Saúde Integrada Ltda",
        status: "active",
        onboarded_at: new Date().toISOString(),
      })
      .eq("id", org),
    "organização",
  );

  // ---------- equipe: o dono do bootstrap vira a Helena, da recepção ----------
  const dono = exigir(
    await db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", org)
      .eq("role", "admin")
      .order("created_at")
      .limit(1)
      .single(),
    "dono",
  ) as { user_id: string };
  const atual = usuarioDe(await db.auth.admin.getUserById(dono.user_id), "dono");
  // e-mail e senha só na primeira vez: trocar a senha encerra as sessões abertas do capturador
  usuarioDe(
    await db.auth.admin.updateUserById(dono.user_id, {
      user_metadata: { full_name: "Helena Prado", locale: idiomaDaCaptura() },
      ...(atual.email === EMAIL.helena
        ? {}
        : { email: EMAIL.helena, email_confirm: true, password: SENHA }),
    }),
    "Helena",
  );
  const pessoa = {
    helena: dono.user_id,
    ana: await membro(EMAIL.ana, "Ana Ribeiro", "agent", org),
    carlos: await membro(EMAIL.carlos, "Carlos Mendes", "manager", org),
  };

  // ---------- recomeça do zero ----------
  // O plaintext desta chave aparece numa foto pública. Mesmo numa rodada parcial ela não
  // pode continuar válida depois que a bancada for preparada para a próxima lição.
  semErro(
    await db
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString(), revoked_by: pessoa.helena })
      .eq("organization_id", org)
      .eq("name", "Prontuário eletrônico da clínica")
      .is("revoked_at", null),
    "revogar chave fotografada",
  );
  // Só ids próprios do curso: pedidos e regras não podem contaminar a próxima tela, nem
  // acordar efeitos externos quando uma lição de outro módulo cria um lead de teste.
  semErro(
    await db
      .from("lgpd_requests")
      .delete()
      .eq("organization_id", org)
      .in("id", [
        "7c41e9a2-5b10-4d3e-9f21-be7000000001",
        "2a8f03d6-91c4-4e7a-8b55-be7000000002",
        "d415b7e0-3a62-4f19-a8c3-be7000000003",
        "9e06c2f8-7d35-4b81-b6e4-be7000000004",
      ]),
    "limpar pedidos LGPD da demonstração",
  );
  semErro(
    await db
      .from("automation_rules")
      .update({ is_active: false })
      .eq("organization_id", org)
      .eq("id", "a0d00000-0000-4000-8000-000000000001"),
    "desarmar regra de IA de outro módulo",
  );
  semErro(
    await db
      .from("followup_flow_pointers")
      .update({ status: "disabled" })
      .eq("organization_id", org)
      .in(
        "id",
        [1, 2, 3].map((n) => `be300000-0000-4000-8000-${String(n).padStart(12, "0")}`),
      ),
    "desarmar fluxos da demonstração",
  );
  semErro(await db.from("conversations").delete().eq("organization_id", org), "limpar conversas");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org), "limpar leads");
  // `calendar_appointments.contact_id` é `on delete restrict`: as histórias do "em ação" deixam
  // compromissos com cliente, e eles travariam a limpeza dos contatos de toda aula seguinte.
  semErro(
    await db.from("calendar_appointments").delete().eq("organization_id", org).not("contact_id", "is", null),
    "limpar compromissos com cliente",
  );
  semErro(await db.from("contacts").delete().eq("organization_id", org), "limpar contatos");
  semErro(
    await db.from("message_templates").delete().eq("organization_id", org),
    "limpar respostas rápidas",
  );
  semErro(
    await db.from("channel_session_groups").delete().eq("organization_id", org),
    "limpar grupos",
  );

  // ---------- número de WhatsApp (um só: sem seletor de número nem faixa de queda) ----------
  // reaproveita o canal que já existir (o agente publicado aponta para ele) e arquiva os demais
  const sessoes = exigir(
    await db
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org)
      .is("archived_at", null)
      .order("created_at"),
    "sessões",
  ) as Array<{ id: string }>;
  const sessao =
    sessoes[0]?.id ??
    (
      exigir(
        await db
          .from("channel_sessions")
          .insert({
            organization_id: org,
            provider: "waha",
            waha_session_name: "bemviver-recepcao",
            webhook_secret_encrypted: "\\x00",
            status: "WORKING",
            phone_number: "+551140028922",
            display_name: demo("Recepção Bem Viver"),
          })
          .select("id")
          .single(),
        "channel_sessions",
      ) as { id: string }
    ).id;
  for (const outra of sessoes.slice(1))
    semErro(
      await db
        .from("channel_sessions")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", outra.id),
      "arquivar canal",
    );
  semErro(
    await db
      .from("channel_sessions")
      .update({
        status: "WORKING",
        display_name: demo("Recepção Bem Viver"),
        waha_session_name: "bemviver-recepcao",
        phone_number: "+551140028922",
      })
      .eq("id", sessao),
    "sessão no ar",
  );

  // ---------- agente de IA publicado (liga a aba Automático; nunca é chamado) ----------
  const PROMPT = "Você é a Bia, recepcionista virtual da Clínica Bem Viver.";
  // o formato que a tela do agente conhece; com o prefixo do gateway, o campo "Modelo" aparecia vazio
  const MODELO = "claude-sonnet-4-6";
  const agentes = exigir(
    await db.from("ai_agents").select("id, published_version_id").eq("organization_id", org),
    "ai_agents",
  ) as Array<{ id: string; published_version_id: string | null }>;
  const agenteId =
    agentes[0]?.id ??
    (
      exigir(
        await db
          .from("ai_agents")
          .insert({
            organization_id: org,
            name: demo("Bia — Recepção virtual"),
            system_prompt: demo(PROMPT),
            is_default: true,
            is_active: true,
          })
          .select("id")
          .single(),
        "agente",
      ) as { id: string }
    ).id;
  semErro(
    await db
      .from("ai_agents")
      .update({ name: demo("Bia — Recepção virtual") })
      .eq("id", agenteId),
    "nome do agente",
  );
  if (!agentes[0]?.published_version_id) {
    const versao = exigir(
      await db
        .from("ai_agent_versions")
        .insert({
          organization_id: org,
          agent_id: agenteId,
          version_number: 1,
          system_prompt: demo(PROMPT),
          provider: "anthropic",
          model: MODELO,
          credential_id: null,
          channel_session_id: sessao,
          status: "published",
          published_at: new Date().toISOString(),
        })
        .select("id")
        .single(),
      "versão do agente",
    ) as { id: string };
    semErro(
      await db.from("ai_agents").update({ published_version_id: versao.id }).eq("id", agenteId),
      "publicar agente",
    );
  }

  // ---------- respostas rápidas ----------
  semErro(
    await db.from("message_templates").insert(
      [
        {
          title: "Horários da nutricionista",
          shortcut: "horarios",
          body: "Oi, {{primeiro_nome}}! A Dra. Lívia atende às terças e quintas, das 8h às 12h. Qual dia fica melhor para você?",
        },
        {
          title: "Endereço da clínica",
          shortcut: "endereco",
          body: "Estamos na Rua das Acácias, 120 — 3º andar, Vila Mariana. Temos estacionamento conveniado no prédio ao lado.",
        },
        {
          title: "Preparo para exame de sangue",
          shortcut: "jejum",
          body: "Para o exame, é preciso jejum de 8 horas. Pode beber água normalmente.",
        },
      ].map((t) => ({
        ...t,
        title: demo(t.title),
        body: demo(t.body),
        organization_id: org,
        created_by_user_id: pessoa.helena,
      })),
    ),
    "respostas rápidas",
  );

  // ---------- funil: o "Pedidos" que a org ganha ao nascer vira "Pacientes" ----------
  const funil = exigir(
    await db
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", org)
      .eq("is_default", true)
      .limit(1)
      .single(),
    "funil",
  ) as { id: string };
  semErro(
    await db
      .from("crm_pipelines")
      .update({ name: demo("Pacientes") })
      .eq("id", funil.id),
    "nome do funil",
  );
  const etapas = exigir(
    await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).order("position"),
    "etapas",
  ) as Array<{ id: string }>;
  const NOMES = ["Primeiro contato", "Consulta agendada", "Em tratamento", "Retorno"];
  for (const [i, nome] of NOMES.entries()) {
    if (etapas[i])
      semErro(
        await db
          .from("crm_stages")
          .update({ name: demo(nome) })
          .eq("id", etapas[i]!.id),
        `etapa ${nome}`,
      );
  }

  // ---------- conversas ----------
  for (const c of CONVERSAS) {
    const contato = contatoId(c.n),
      conversa = conversaId(c.n);
    semErro(
      await db.from("contacts").insert({
        id: contato,
        organization_id: org,
        name: c.grupo ? demo(c.nome) : c.nome,
        phone_number: c.telefone,
        tags: c.etiquetasContato ?? [],
        ...c.contato,
      }),
      `contato ${c.nome}`,
    );
    semErro(
      await db.from("conversations").insert({
        id: conversa,
        organization_id: org,
        contact_id: contato,
        channel_session_id: sessao,
        status: "open",
        tags: c.etiquetasConversa ?? [],
        is_group: Boolean(c.grupo),
        group_chat_id: c.grupo ?? null,
      }),
      `conversa ${c.nome}`,
    );
    if (c.grupo) {
      semErro(
        await db.from("channel_session_groups").insert({
          organization_id: org,
          channel_session_id: sessao,
          group_chat_id: c.grupo,
          subject: c.nome,
          enabled: true,
          enabled_at: ha(60 * 24 * 7),
          enabled_by_user_id: pessoa.helena,
          contact_id: contato,
          conversation_id: conversa,
        }),
        "grupo",
      );
    }
    // mensagens ANTES de dono e status: uma recebida reabre conversa fechada
    for (const msg of c.mensagens) {
      const recebida = msg.quem === "cliente";
      const humano = msg.quem === "helena" || msg.quem === "ana";
      semErro(
        await db.from("messages").insert({
          organization_id: org,
          conversation_id: conversa,
          channel_session_id: sessao,
          contact_id: contato,
          type: "text",
          body: demo(msg.texto),
          direction: recebida ? "inbound" : "outbound",
          status: recebida ? "received" : (msg.status ?? "read"),
          sent_via: recebida ? "external_device" : humano ? "user" : "ai",
          sent_by_user_id: humano ? pessoa[msg.quem as "helena" | "ana"] : null,
          sent_at: msg.em,
          created_at: msg.em,
          ...(msg.status === "failed"
            ? { error_message: demo("Não foi possível enviar esta mensagem.") }
            : {}),
          ...(msg.quem === "ia" ? { metadata: { ai_generated: true } } : {}),
          ...(msg.grupo ? { metadata: { group_sender: msg.grupo } } : {}),
        }),
        `mensagem de ${c.nome}`,
      );
      semErro(
        await db.rpc("fn_mark_conversation_message", {
          p_conv: conversa,
          p_direction: recebida ? "inbound" : "outbound",
          p_preview: demo(msg.texto),
          p_at: msg.em,
        }),
        `carimbo de ${c.nome}`,
      );
    }
    if (c.dono) {
      semErro(
        await db.rpc("fn_conversation_assign", {
          p_organization_id: org,
          p_conversation_id: conversa,
          p_to_user_id: pessoa[c.dono],
          p_reason: c.motivoDono ?? "claim",
        }),
        `atribuir ${c.nome}`,
      );
    }
    const ultima = c.mensagens.at(-1)!.em;
    semErro(
      await db
        .from("conversations")
        .update({
          ...(c.status ? { status: c.status } : {}),
          // claim também cala o robô; só o silêncio pedido pelo roteiro fica
          bot_silenced_until: c.silencio ? "infinity" : null,
          ...(c.silencio && !c.dono
            ? { last_handoff_at: ha(39), last_handoff_reason: "requested_human" }
            : {}),
          ...(c.exemplo
            ? {
                usable_for_rag: true,
                usable_for_rag_marked_at: ultima,
                usable_for_rag_marked_by: pessoa.ana,
              }
            : {}),
          unread_count_for_assignee: c.naoLidas,
        })
        .eq("id", conversa),
      `estado de ${c.nome}`,
    );
  }

  // ---------- extras das lições ----------
  semErro(
    await db.from("passagens_de_atendimento").insert({
      organization_id: org,
      contact_id: contatoId(1),
      conversation_id: conversaId(1),
      criado_em: ha(39),
      motor: "engine",
      origem: "pedido_explicito",
      motivo_codigo: "requested_human",
      title: demo("Marcar a primeira consulta com a nutricionista"),
      body: demo(
        "Paciente quer marcar a primeira consulta com a nutricionista e pediu para falar com uma pessoa sobre o plano alimentar.",
      ),
      notes: demo(
        "Na verdade prefiro falar com uma pessoa, tenho umas dúvidas sobre o plano alimentar.",
      ),
      tentativas: [{ o_que: demo("Perguntou se ela já é paciente da clínica") }],
      cliente_avisado: true,
    }),
    "passagem",
  );
  semErro(
    await db.from("conversation_notes").insert({
      organization_id: org,
      conversation_id: conversaId(5),
      created_at: ha(110),
      created_by_user_id: pessoa.carlos,
      created_by_name: "Carlos Mendes",
      body: demo(
        "Paciente pós-operatória. Confirmar com o Dr. Paulo se precisa trocar o curativo no retorno.",
      ),
    }),
    "nota",
  );
  // a demanda da Fernanda fica sem próximo passo: é o destaque que a lição da ficha ensina a resolver
  const c5 = exigir(
    await db.from("conversations").select("current_demanda_id").eq("id", conversaId(5)).single(),
    "demanda C05",
  ) as { current_demanda_id: string | null };
  if (c5.current_demanda_id)
    semErro(
      await db.from("demandas").update({ proximo_passo: null }).eq("id", c5.current_demanda_id),
      "próximo passo",
    );
  for (const [n, titulo, etapa, reais] of [
    [1, "Primeira consulta nutricional — Mariana", 0, 280],
    [5, "Retorno pós-cirúrgico — Fernanda Oliveira", 1, 350],
  ] as const) {
    semErro(
      await db.from("crm_leads").insert({
        organization_id: org,
        pipeline_id: funil.id,
        stage_id: etapas[etapa]!.id,
        title: demo(titulo),
        contact_id: contatoId(n),
        value_cents: reais * 100,
        currency: "BRL",
        status: "open",
      }),
      `lead ${titulo}`,
    );
  }

  mkdirSync(saida, { recursive: true });
  writeFileSync(
    path.join(saida, "contas.json"),
    JSON.stringify(
      {
        admin: { email: EMAIL.helena, senha: SENHA },
        manager: { email: EMAIL.carlos, senha: SENHA },
        agent: { email: EMAIL.ana, senha: SENHA },
      },
      null,
      2,
    ),
  );
  console.info(`demonstração semeada: ${CONVERSAS.length} conversas na org ${org}`);
  return {
    db,
    org,
    pessoa,
    sessao,
    agenteId,
    funil: { id: funil.id, etapas: etapas.map((e) => e.id) },
  };
}

/**
 * A semente de um módulo fica no banco depois da aula dele, e uma linha que sobra
 * pode mudar a tela de outro módulo (o acervo de Conhecimento apagava o aviso de
 * "sem acervo" da aula de Agentes). A base não conhece as tabelas de cada módulo,
 * então quem sabe o que apagar é a própria semente: a que exporta `limpar` tem a
 * limpeza chamada antes de QUALQUER aula. Cada `limpar` apaga só as próprias linhas.
 */
async function limparSementesDeModulo(ctx: Contexto) {
  const pasta = path.join(path.dirname(new URL(import.meta.url).pathname), "semear");
  for (const arquivo of readdirSync(pasta).filter((f) => f.endsWith(".ts")).sort()) {
    const semente = (await import(path.join(pasta, arquivo))) as { limpar?: (c: Contexto) => Promise<void> };
    if (typeof semente.limpar === "function") await semente.limpar(ctx);
  }
}

async function rodar() {
  const ctx = await semearBase();
  await limparSementesDeModulo(ctx);
  const modulo = process.argv[2];
  if (!modulo || modulo === "inbox") return;
  if (!/^[a-z0-9-]+$/.test(modulo)) throw new Error(`módulo inválido: ${modulo}`);
  const arquivo = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "semear",
    `${modulo}.ts`,
  );
  if (!existsSync(arquivo)) return;
  const semente = (await import(arquivo)) as { semear: (c: Contexto) => Promise<void> };
  await semente.semear(ctx);
  console.info(`semente do módulo ${modulo} aplicada`);
}

// só roda quando chamado direto; as sementes de módulo importam os ajudantes daqui
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  rodar().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

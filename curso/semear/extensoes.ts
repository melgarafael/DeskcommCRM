/**
 * Semente do módulo "Extensões" (/app/extensions).
 *
 * Extensões são da INSTALAÇÃO (catálogo, pacote e instalação não têm
 * organization_id) e o service_role só tem SELECT nessas tabelas: não há como
 * apagar e recriar. Então a semente é CONVERGENTE: lê o estado e chama as
 * mesmas funções do banco que a tela usa (fn_extensions_admit_catalog,
 * fn_extensions_prepare_install + fn_extensions_finish_install,
 * fn_extensions_configure) só quando falta alguma coisa. Ids de recibo são
 * derivados do conteúdo, então repetir a semente não cria recibo novo.
 *
 * Estado que cada lição encontra:
 *   - catálogo "https://catalogo.guiasdeclinica.com.br" com 4 entradas;
 *   - "Roteiro da primeira consulta" instalado na 1.1.0, com a 1.0.0 como
 *     versão anterior (dá o "Desfazer a última troca");
 *   - "Retorno de pacientes" instalado na 1.0.0;
 *   - "Orientações pós-consulta" só no catálogo (nunca instalar: baixaria do
 *     endereço do catálogo, que é fictício);
 *   - as duas instaladas DESATIVADAS na Clínica Bem Viver. A lição de ativar
 *     liga uma; a semente da lição seguinte desliga de novo, e a última lição
 *     do módulo não ativa nada — assim o hub do CRM das outras telas não
 *     ganha a seção de guias.
 */
import { createHash } from "node:crypto";

import { type Contexto, exigir } from "../semear-demonstracao";

const ORIGEM = "https://catalogo.guiasdeclinica.com.br";
const EDITOR = "guias-clinica";
const HOST_API = { min: 1, max: 2 };
const PADRAO = { density: "comfortable", show_description: true } as const;

type Texto = { "pt-BR": string };
const pt = (s: string): Texto => ({ "pt-BR": s });

type Card = {
  id: string;
  title: Texto;
  description: Texto;
  icon: "ListChecks" | "BookOpen" | "Lightbulb";
  blocks: Array<{ heading: Texto; body: Texto }>;
  action: { label: Texto; capability: string };
};
type Pacote = {
  name: string;
  version: string;
  permissions: string[];
  display: { title: Texto; summary: Texto; category: "productivity" | "sales" | "service"; icon: Card["icon"] };
  cards: Card[];
  tags: string[];
  published_at: string;
};

const ROTEIRO_DISPLAY: Pacote["display"] = {
  title: pt("Roteiro da primeira consulta"),
  summary: pt("Passo a passo para a recepção marcar e preparar a primeira consulta de um paciente novo."),
  category: "service",
  icon: "ListChecks",
};
const roteiroCards = (comPreparo: boolean): Card[] => [
  {
    id: "marcar-primeira-consulta",
    title: pt("Marcar a primeira consulta"),
    description: pt("O que confirmar com o paciente antes de reservar o horário."),
    icon: "ListChecks",
    blocks: [
      { heading: pt("Antes de marcar"), body: pt("Confirme o nome completo, o telefone com WhatsApp e se a consulta é particular ou por convênio.") },
      { heading: pt("Na hora de marcar"), body: pt("Ofereça dois horários livres da especialidade e anote a preferência do paciente.") },
      ...(comPreparo
        ? [{ heading: pt("Depois de marcar"), body: pt("Envie o endereço da clínica e o preparo da consulta, se houver.") }]
        : []),
    ],
    action: { label: pt("Abrir a Agenda"), capability: "agenda.open" },
  },
];

const PACOTES: Pacote[] = [
  {
    name: "roteiro-primeira-consulta", version: "1.0.0", permissions: ["navigation.agenda"],
    display: ROTEIRO_DISPLAY, cards: roteiroCards(false), tags: ["recepcao", "agenda"], published_at: "2026-08-12",
  },
  {
    name: "roteiro-primeira-consulta", version: "1.1.0", permissions: ["navigation.agenda"],
    display: ROTEIRO_DISPLAY, cards: roteiroCards(true), tags: ["recepcao", "agenda"], published_at: "2026-10-02",
  },
  {
    name: "retorno-de-pacientes", version: "1.0.0", permissions: ["navigation.tasks", "navigation.contacts"],
    display: {
      title: pt("Retorno de pacientes"),
      summary: pt("Lembra a equipe de chamar quem precisa voltar: revisão da nutrição, reavaliação da fisioterapia e limpeza odontológica."),
      category: "sales",
      icon: "Lightbulb",
    },
    cards: [
      {
        id: "chamar-para-retorno",
        title: pt("Chamar para o retorno"),
        description: pt("Quem precisa voltar e quando falar com cada um."),
        icon: "Lightbulb",
        blocks: [
          { heading: pt("Nutrição"), body: pt("Revisão do plano alimentar 30 dias depois da primeira consulta.") },
          { heading: pt("Fisioterapia"), body: pt("Reavaliação a cada 10 sessões.") },
          { heading: pt("Odontologia"), body: pt("Limpeza a cada 6 meses.") },
        ],
        action: { label: pt("Abrir Tarefas"), capability: "tasks.open" },
      },
      {
        id: "atualizar-cadastro",
        title: pt("Atualizar o cadastro"),
        description: pt("Confira telefone e convênio antes de chamar."),
        icon: "BookOpen",
        blocks: [{ heading: pt("O que conferir"), body: pt("Telefone com WhatsApp, convênio e a data do último atendimento.") }],
        action: { label: pt("Abrir Contatos"), capability: "contacts.open" },
      },
    ],
    tags: ["retorno", "fidelizacao"],
    published_at: "2026-09-05",
  },
  {
    name: "orientacoes-pos-consulta", version: "1.0.0", permissions: ["navigation.inbox"],
    display: {
      title: pt("Orientações pós-consulta"),
      summary: pt("Textos de apoio para responder dúvidas comuns depois do atendimento, como dieta, exercícios em casa e cuidados após a limpeza."),
      category: "productivity",
      icon: "BookOpen",
    },
    cards: [
      {
        id: "duvidas-depois-da-consulta",
        title: pt("Dúvidas depois da consulta"),
        description: pt("Respostas curtas para as perguntas que mais chegam."),
        icon: "BookOpen",
        blocks: [{ heading: pt("Fisioterapia"), body: pt("Lembre o paciente de repetir os exercícios de casa duas vezes por dia.") }],
        action: { label: pt("Abrir Conversas"), capability: "inbox.open" },
      },
    ],
    tags: ["pos-consulta"],
    published_at: "2026-09-20",
  },
];

/** O documento do pacote: os bytes que o catálogo anuncia e que a instalação grava. */
function documento(p: Pacote) {
  const manifesto = {
    format_version: 1, profile: "declarative", publisher: EDITOR, name: p.name, version: p.version, license: "MIT",
    host_api: HOST_API, permissions: p.permissions, dependencies: [], data: { mode: "none" }, display: p.display,
    configuration: PADRAO, contributions: { crm_cards: p.cards },
  };
  const texto = JSON.stringify(manifesto);
  const bytes = Buffer.from(texto, "utf8");
  return { manifesto, texto, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

/** Id de recibo estável para o mesmo pedido (formato UUID v4, que a tela confere). */
function idDe(chave: string) {
  const h = createHash("sha256").update(`curso-extensoes:${chave}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

type Instalacao = { id: string; version: string; revision: number; removed_at: string | null };

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  const ator = pessoa.helena;
  const docs = new Map(PACOTES.map((p) => [`${p.name}@${p.version}`, documento(p)]));

  // ---------- catálogo admitido ----------
  const entradas = PACOTES.map((p) => {
    const d = docs.get(`${p.name}@${p.version}`)!;
    return {
      publisher: EDITOR, name: p.name, version: p.version, license: "MIT", host_api: HOST_API, display: p.display,
      permissions: p.permissions, sha256: d.sha256, byte_length: d.bytes,
      publisher_label: "Guias de Clínica", tags: p.tags, published_at: p.published_at,
    };
  });
  const atual = exigir(await db.from("extension_catalogs").select("id, revision, digest, snapshot").eq("origin", ORIGEM), "catálogo") as Array<{
    id: string; revision: number; digest: string; snapshot: { entries: unknown };
  }>;
  let catalogoId = atual[0]?.id;
  // o banco devolve o jsonb com as chaves reordenadas: compara na forma canônica
  if (!atual[0] || canonico(atual[0].snapshot.entries) !== canonico(entradas)) {
    const revisao = (atual[0]?.revision ?? 0) + 1;
    const snapshot = { format_version: 1, origin: ORIGEM, revision: revisao, entries: entradas };
    const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const r = exigir(await db.rpc("fn_extensions_admit_catalog", {
      p_actor: ator, p_operation: idDe(`admitir:${digest}`), p_snapshot: snapshot, p_digest: digest,
    }), "admitir catálogo") as { catalog_id: string };
    catalogoId = r.catalog_id;
  }

  // ---------- instalações (instalar ou trocar até a versão-alvo) ----------
  async function lerInstalacao(name: string): Promise<Instalacao | null> {
    const linhas = exigir(await db.from("extension_installations").select("id, version, revision, removed_at")
      .eq("catalog_id", catalogoId!).eq("publisher", EDITOR).eq("name", name), `instalação ${name}`) as Instalacao[];
    return linhas[0] ?? null;
  }
  async function instalar(name: string, version: string, inst: Instalacao | null) {
    const esperada = inst?.revision ?? null;
    const op = idDe(`instalar:${name}@${version}:${esperada ?? "nenhuma"}`);
    const preparo = exigir(await db.rpc("fn_extensions_prepare_install", {
      p_actor: ator, p_operation: op, p_catalog: catalogoId, p_publisher: EDITOR, p_name: name, p_version: version,
      p_expected_installation_revision: esperada,
    }), `preparar ${name}@${version}`) as { status: string };
    if (preparo.status !== "preparing") return;
    const d = docs.get(`${name}@${version}`)!;
    exigir(await db.rpc("fn_extensions_finish_install", {
      p_actor: ator, p_operation: op, p_manifest: d.manifesto, p_sha256: d.sha256, p_byte_length: d.bytes, p_document: d.texto,
    }), `concluir ${name}@${version}`);
  }
  // [nome, versões na ordem em que entram] — a última é a vigente, a penúltima fica como anterior
  const ALVOS: Array<[string, string[]]> = [
    ["roteiro-primeira-consulta", ["1.0.0", "1.1.0"]],
    ["retorno-de-pacientes", ["1.0.0"]],
  ];
  const ids: string[] = [];
  for (const [name, versoes] of ALVOS) {
    let inst = await lerInstalacao(name);
    if (!inst) {
      for (const v of versoes) {
        await instalar(name, v, inst);
        inst = await lerInstalacao(name);
      }
    } else if (inst.removed_at || inst.version !== versoes.at(-1)) {
      await instalar(name, versoes.at(-1)!, inst);
      inst = await lerInstalacao(name);
    }
    if (!inst || inst.version !== versoes.at(-1) || inst.removed_at) throw new Error(`instalação ${name} não convergiu`);
    ids.push(inst.id);
  }

  // ---------- na Clínica Bem Viver: instaladas, mas desativadas ----------
  for (const id of ids) {
    const vinculo = exigir(await db.from("organization_extensions").select("enabled, configuration, revision")
      .eq("organization_id", org).eq("installation_id", id), "vínculo") as Array<{
      enabled: boolean; configuration: Record<string, unknown>; revision: number;
    }>;
    const v = vinculo[0];
    const igual = v && !v.enabled && v.configuration.density === PADRAO.density
      && v.configuration.show_description === PADRAO.show_description && !("theme" in v.configuration);
    if (!v || igual) continue;
    exigir(await db.rpc("fn_extensions_configure", {
      p_actor: ator, p_organization: org, p_installation: id, p_operation: idDe(`configurar:${org}:${id}:${v.revision}`),
      p_expected_revision: v.revision, p_enabled: false, p_configuration: PADRAO,
    }), "desativar na organização");
  }
}

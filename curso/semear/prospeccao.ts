/**
 * Semente do módulo "Prospecção" (CRM › Ver tudo em CRM › Prospecção).
 *
 * Sem dado a tela é só o formulário da chave da Apify e "Sua próxima conversa
 * começa aqui" — nada ensina a escolher empresas, preparar a abordagem ou
 * acompanhar uma campanha. Por isso a clínica ganha:
 *
 *  - a chave de busca já salva (`prospecting_settings`), cifrada pela MESMA RPC
 *    que o `configure` usa (`fn_encrypt_oauth`, lib/webhooks/secrets.ts). O valor
 *    é fictício: a tela só pergunta SE existe chave, e nenhuma lição clica em
 *    "Salvar chave" ou "Buscar empresas" (os dois chamam a Apify);
 *  - uma campanha PAUSADA (escritórios de contabilidade da Vila Mariana), iniciada
 *    no modo "Só quando for abordada" e pausada antes do primeiro envio: quatro
 *    empresas "Na fila", uma desmarcada e uma sem telefone. Como nenhuma foi
 *    abordada, nenhuma tem contato, negócio ou conversa — e a semente não cria
 *    linha nenhuma em contatos, negócios ou Inbox, que são de todos os módulos;
 *  - uma busca CONCLUÍDA e ainda em preparação (escritórios de advocacia do
 *    Paraíso), com cinco empresas, uma delas desmarcada.
 *
 * Toda empresa com site já tem o veredito da auditoria gravado (`data.site`): sem
 * ele a linha fica em "A verificar" esperando o worker, que está parado. E toda
 * empresa marcada já tem a prévia guardada (`data.previa`), ancorada na chave da
 * auditoria (lib/prospecting/previa.ts) e escrita pela Bia: a busca nasce com
 * "Gerar a prévia" ligada, e sem a prévia a linha ficaria em "Gerando prévia…".
 * As prévias só cumprimentam, porque a campanha usa "Atrasar para a 2ª mensagem"
 * — o modo em que a primeira mensagem não oferece nada (estrategia-site.ts).
 *
 * Empresas, telefones, sites e e-mails são fictícios (domínios em
 * exemplo.com.br). Idempotente: apaga só as próprias campanhas (as empresas vão
 * junto, em cascata) e recria; a personalização da prospecção
 * (`organizations.settings.prospeccao`) volta a vazio, porque a lição a preenche.
 */
import pg from "pg";

import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { exigirBancoLocal } from "../seguranca";

const campanhaId = (n: number) => `d1010000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pedidoId = (n: number) => `d1010200-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empresaId = (n: number) => `d1010100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAMPANHAS = [1, 2].map(campanhaId);

/** O motivo que a tela compara byte a byte (RAZAO_NAO_SELECIONADA, lib/prospecting/schema.ts). */
const NAO_SELECIONADA = "Não selecionada pelo operador.";
/** O motivo que a triagem grava (`triarCandidato`, lib/prospecting/store.ts). */
const SEM_TELEFONE = "Sem telefone brasileiro válido.";

type Classe = "site-ok" | "site-ruim" | "fora-do-ar" | "agregador";
type Veredito = {
  classe: Classe;
  problemas?: string[];
  tem?: string[];
  falta?: string[];
  http?: number | null;
};

const TODOS_OS_ITENS = [
  "whatsapp",
  "tel",
  "mailto",
  "social",
  "mapa",
  "fotos",
  "titulo",
  "description",
  "favicon",
];

/** O veredito no formato de `siteEnrichmentSchema`, como o worker grava. */
function site(v: Veredito, website: string, verificadoEm: string) {
  const semRede = v.classe === "agregador";
  const tem = v.tem ?? (v.classe === "site-ok" ? TODOS_OS_ITENS : []);
  const falta = v.falta ?? TODOS_OS_ITENS.filter((i) => !tem.includes(i));
  return {
    ver: 1,
    classe: v.classe,
    problemas: v.problemas ?? [],
    checklist: semRede || v.classe === "fora-do-ar" ? { tem: [], falta: [] } : { tem, falta },
    final_url: semRede || v.classe === "fora-do-ar" ? null : website,
    http_status:
      v.http === undefined ? (semRede || v.classe === "fora-do-ar" ? null : 200) : v.http,
    tempo_ms: semRede ? 0 : v.classe === "fora-do-ar" ? 8000 : 900,
    conteudo_resumo: null,
    pagespeed: null,
    verificado_em: verificadoEm,
    provisorio: false,
    tentativas: 0,
  };
}

type Empresa = {
  n: number;
  campanha: number;
  nome: string;
  categoria: string;
  endereco: string;
  telefone: string | null;
  website: string | null;
  nota: number;
  avaliacoes: number;
  emails?: string[];
  redes?: string[];
  veredito?: Veredito;
  status: "new" | "queued" | "skipped";
  selected: boolean;
  erro?: string;
  previa?: string;
};

const CONTABIL = "Escritório de contabilidade";
const ADVOCACIA = "Escritório de advocacia";

const EMPRESAS: Empresa[] = [
  // ---------- campanha 1: pausada antes do primeiro envio ----------
  {
    n: 1,
    campanha: 1,
    nome: "Contábil Domingos de Morais",
    categoria: CONTABIL,
    endereco: "R. Domingos de Morais, 1450 - Vila Mariana, São Paulo - SP",
    telefone: "+5511931410001",
    website: "https://www.contabildomingos.exemplo.com.br/",
    nota: 4.8,
    avaliacoes: 64,
    emails: ["contato@contabildomingos.exemplo.com.br"],
    redes: ["https://www.instagram.com/contabildomingos.exemplo"],
    veredito: { classe: "site-ok" },
    status: "queued",
    selected: true,
    previa:
      "Olá, boa tarde! Aqui é a Bia, da Clínica Bem Viver, na Vila Mariana. Estou falando com a Contábil Domingos de Morais?",
  },
  {
    n: 2,
    campanha: 1,
    nome: "Vila Contabilidade e Assessoria",
    categoria: CONTABIL,
    endereco: "R. Joaquim Távora, 512 - Vila Mariana, São Paulo - SP",
    telefone: "+5511931410002",
    website: "https://www.vilacontabilidade.exemplo.com.br/",
    nota: 4.6,
    avaliacoes: 23,
    veredito: {
      classe: "site-ruim",
      problemas: ["nao-mobile", "construtor-Wix"],
      tem: ["tel", "mapa", "titulo", "favicon"],
    },
    status: "queued",
    selected: true,
    previa:
      "Olá! Aqui é a Bia, da Clínica Bem Viver, aqui da Vila Mariana. Falo com a Vila Contabilidade e Assessoria?",
  },
  {
    n: 3,
    campanha: 1,
    nome: "Lopes & Martins Contadores",
    categoria: CONTABIL,
    endereco: "R. Coronel Lisboa, 88 - Vila Mariana, São Paulo - SP",
    telefone: "+5511931410003",
    website: null,
    nota: 4.9,
    avaliacoes: 112,
    status: "queued",
    selected: true,
    previa:
      "Boa tarde! Sou a Bia, da Clínica Bem Viver. Este é o WhatsApp da Lopes & Martins Contadores?",
  },
  {
    n: 4,
    campanha: 1,
    nome: "Escritório Contábil Ibirapuera",
    categoria: CONTABIL,
    endereco: "Av. Conselheiro Rodrigues Alves, 930 - Vila Mariana, São Paulo - SP",
    telefone: "+5511931410004",
    website: "https://www.instagram.com/contabilibirapuera.exemplo",
    nota: 4.3,
    avaliacoes: 9,
    veredito: { classe: "agregador" },
    status: "queued",
    selected: true,
    previa:
      "Olá! Aqui é a Bia, da Clínica Bem Viver, na Vila Mariana. Falo com o Escritório Contábil Ibirapuera?",
  },
  {
    n: 5,
    campanha: 1,
    nome: "Prisma Contabilidade",
    categoria: CONTABIL,
    endereco: "R. França Pinto, 301 - Vila Mariana, São Paulo - SP",
    telefone: "+5511931410005",
    website: "https://www.prismacontabil.exemplo.com.br/",
    nota: 4.0,
    avaliacoes: 5,
    veredito: { classe: "fora-do-ar", problemas: ["dns-morto"] },
    status: "skipped",
    selected: false,
    erro: NAO_SELECIONADA,
  },
  {
    n: 6,
    campanha: 1,
    nome: "Contabilidade Santa Cruz",
    categoria: CONTABIL,
    endereco: "R. Santa Cruz, 640 - Vila Mariana, São Paulo - SP",
    telefone: null,
    website: "https://www.contabilsantacruz.exemplo.com.br/",
    nota: 4.4,
    avaliacoes: 17,
    emails: ["atendimento@contabilsantacruz.exemplo.com.br"],
    veredito: { classe: "site-ok" },
    status: "skipped",
    selected: true,
    erro: SEM_TELEFONE,
  },
  // ---------- campanha 2: busca concluída, em preparação ----------
  {
    n: 11,
    campanha: 2,
    nome: "Ferraz & Oliveira Advogados",
    categoria: ADVOCACIA,
    endereco: "R. Abílio Soares, 233 - Paraíso, São Paulo - SP",
    telefone: "+5511932410011",
    website: "http://www.ferrazoliveira.exemplo.com.br/",
    nota: 4.7,
    avaliacoes: 38,
    emails: ["contato@ferrazoliveira.exemplo.com.br"],
    veredito: {
      classe: "site-ruim",
      problemas: ["sem-https", "nao-mobile"],
      tem: ["tel", "mapa", "titulo"],
    },
    status: "new",
    selected: true,
    previa:
      "Olá, bom dia! Aqui é a Bia, da Clínica Bem Viver, na Vila Mariana. Falo com o Ferraz & Oliveira Advogados?",
  },
  {
    n: 12,
    campanha: 2,
    nome: "Bianchi Advocacia Trabalhista",
    categoria: ADVOCACIA,
    endereco: "R. Tutóia, 1157 - Paraíso, São Paulo - SP",
    telefone: "+5511932410012",
    website: null,
    nota: 4.9,
    avaliacoes: 87,
    redes: ["https://www.instagram.com/bianchiadvocacia.exemplo"],
    status: "new",
    selected: true,
    previa:
      "Bom dia! Sou a Bia, da Clínica Bem Viver. Este é o contato da Bianchi Advocacia Trabalhista?",
  },
  {
    n: 13,
    campanha: 2,
    nome: "Mendes Paraíso Sociedade de Advogados",
    categoria: ADVOCACIA,
    endereco: "Av. Bernardino de Campos, 98 - Paraíso, São Paulo - SP",
    telefone: "+5511932410013",
    website: "https://www.instagram.com/mendesparaiso.exemplo",
    nota: 4.5,
    avaliacoes: 14,
    veredito: { classe: "agregador" },
    status: "new",
    selected: true,
    previa:
      "Olá! Aqui é a Bia, da Clínica Bem Viver. Falo com a Mendes Paraíso Sociedade de Advogados?",
  },
  {
    n: 14,
    campanha: 2,
    nome: "Castro Lima Advogados Associados",
    categoria: ADVOCACIA,
    endereco: "R. Desembargador Eliseu Guilherme, 200 - Paraíso, São Paulo - SP",
    telefone: "+5511932410014",
    website: "https://www.castrolima.exemplo.com.br/",
    nota: 4.2,
    avaliacoes: 6,
    emails: ["recepcao@castrolima.exemplo.com.br"],
    veredito: { classe: "site-ok" },
    status: "new",
    selected: true,
    previa:
      "Olá, bom dia! Aqui é a Bia, da Clínica Bem Viver, na Vila Mariana. Estou falando com o Castro Lima Advogados Associados?",
  },
  {
    n: 15,
    campanha: 2,
    nome: "Escritório Jurídico Abílio Soares",
    categoria: ADVOCACIA,
    endereco: "R. Abílio Soares, 1020 - Paraíso, São Paulo - SP",
    telefone: "+5511932410015",
    website: "https://www.juridicoabilio.exemplo.com.br/",
    nota: 3.9,
    avaliacoes: 3,
    veredito: { classe: "fora-do-ar", problemas: ["dns-morto"] },
    status: "new",
    selected: false,
  },
];

/** Limpeza chamada antes de QUALQUER aula: a prospecção da clínica não sobra em outra tela. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(
    await db.from("prospecting_campaigns").delete().eq("organization_id", org).in("id", CAMPANHAS),
    "limpar campanhas de prospecção",
  );
  semErro(
    await db.from("prospecting_settings").delete().eq("organization_id", org),
    "limpar chave de busca",
  );
}

export async function semear(c: Contexto) {
  const { db, org, sessao, agenteId, funil } = c;
  await limpar(c);

  // ---------- a chave de busca, cifrada como o `configure` cifra ----------
  const cifrada = exigir(
    (await db.rpc("fn_encrypt_oauth", { plaintext: "apify_api_CURSO0FICTICIA0SEM0VALOR0000" })) as {
      data: string | null;
      error: { message: string } | null;
    },
    "cifrar a chave de busca fictícia",
  );
  semErro(
    await db
      .from("prospecting_settings")
      .insert({ organization_id: org, credential_encrypted: cifrada }),
    "chave de busca",
  );

  // ---------- personalização vazia: a lição a preenche ----------
  // Atômico no Postgres local, como em planos-de-tarefa.ts: ler-mudar-gravar `settings`
  // pelo client apagaria a chave que outra semente gravasse no meio.
  const url = process.env.SUPABASE_DB_URL;
  if (url) {
    const cli = new pg.Client({ connectionString: exigirBancoLocal(url) });
    await cli.connect();
    try {
      const r = await cli.query(
        "update public.organizations set settings = coalesce(settings, '{}'::jsonb) - 'prospeccao' where id = $1",
        [org],
      );
      if (r.rowCount !== 1)
        throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
    } finally {
      await cli.end();
    }
  } else {
    const linha = exigir(
      await db.from("organizations").select("settings").eq("id", org).single(),
      "settings",
    ) as {
      settings: Record<string, unknown> | null;
    };
    const { prospeccao: _vazia, ...resto } = linha.settings ?? {};
    void _vazia;
    semErro(
      await db.from("organizations").update({ settings: resto }).eq("id", org),
      "personalização da prospecção",
    );
  }

  // ---------- campanhas ----------
  const busca = (nicho: string, local: string) => ({
    name: `${nicho} · ${local}`,
    niche: nicho,
    location: local,
    limit: 20,
    budget_usd: 1,
    enrich: true,
    avaliar_site: true,
    gerar_previa: true,
  });
  const contabil = busca(demo("escritórios de contabilidade"), "Vila Mariana, São Paulo, SP");
  const advocacia = busca(demo("escritórios de advocacia"), "Paraíso, São Paulo, SP");
  const DIA = 24 * 60;
  semErro(
    await db.from("prospecting_campaigns").insert([
      {
        id: campanhaId(1),
        organization_id: org,
        request_id: pedidoId(1),
        name: contabil.name,
        search: contabil,
        config: {
          agent_id: agenteId,
          channel_session_id: sessao,
          pipeline_id: funil.id,
          stage_id: funil.etapas[0],
          qualified_stage_id: funil.etapas[1],
          instruction: demo(
            "Apresente o programa Empresa Saudável da Clínica Bem Viver: ginástica laboral e avaliação postural para a equipe, feitas no próprio escritório. O objetivo da primeira conversa é saber se a empresa aceita uma visita sem compromisso.",
          ),
          qualification: demo(
            "A pessoa decide ou participa da decisão sobre benefícios da equipe e aceita marcar uma visita ou receber uma proposta.",
          ),
          ofertas: ["site"],
          daily_limit: 10,
          interval_minutes: 30,
          legal_basis_ref: demo(
            "Avaliação de legítimo interesse nº 03/2026 — prospecção de empresas",
          ),
          funnel_entry: "on_send",
          exit_offer: "second_message",
        },
        status: "paused",
        search_status: "succeeded",
        run_id: "curso-busca-ficticia-1",
        cost_usd: 0.14,
        result_count: 6,
        skipped_count: 3,
        error: null,
        next_send_at: ha(-60),
        created_at: ha(3 * DIA),
        updated_at: ha(2 * DIA),
      },
      {
        id: campanhaId(2),
        organization_id: org,
        request_id: pedidoId(2),
        name: advocacia.name,
        search: advocacia,
        config: null,
        status: "draft",
        search_status: "succeeded",
        run_id: "curso-busca-ficticia-2",
        cost_usd: 0.11,
        result_count: 5,
        skipped_count: 2,
        error: null,
        next_send_at: ha(90),
        created_at: ha(90),
        updated_at: ha(80),
      },
    ]),
    "campanhas de prospecção",
  );

  // ---------- empresas encontradas ----------
  const linhas = EMPRESAS.map((e, i) => {
    const verificadoEm = ha(70 + i);
    const veredito =
      e.veredito && e.website ? site(e.veredito, e.website, verificadoEm) : undefined;
    // A âncora da prévia é a MESMA chave que a tela confere (chaveDaAuditoria).
    const ancora = veredito ? `${veredito.classe}@${veredito.verificado_em}` : "sem-site@derivado";
    return {
      id: empresaId(e.n),
      organization_id: org,
      campaign_id: campanhaId(e.campanha),
      place_id: `curso-prospeccao-${e.n}`,
      phone: e.telefone,
      status: e.status,
      selected: e.selected,
      error: e.erro ?? null,
      data: {
        key: `curso-prospeccao-${e.n}`,
        name: e.nome,
        phone: e.telefone,
        website: e.website,
        category: demo(e.categoria),
        address: e.endereco,
        maps_url: null,
        rating: e.nota,
        reviews: e.avaliacoes,
        emails: e.emails ?? [],
        socials: e.redes ?? [],
        ...(veredito ? { site: veredito } : {}),
        ...(e.previa
          ? {
              previa: {
                texto: demo(e.previa),
                baseada_em: ancora,
                gerada_em: ha(60),
                agente_id: agenteId,
              },
            }
          : {}),
      },
      // a ordem da lista ("Recentes") é a ordem desta tabela
      created_at: ha(e.campanha === 1 ? 3 * DIA + i : 85 + i),
      updated_at: ha(60),
    };
  });
  semErro(await db.from("prospecting_candidates").insert(linhas), "empresas da prospecção");
}

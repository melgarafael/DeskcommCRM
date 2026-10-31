/**
 * Semente do módulo "Empresas" (CRM › Ver tudo em CRM › Empresas).
 *
 * A tela só existe com o recurso opcional da instalação "Empresas e pessoas
 * (venda para empresas)" ligado (`/admin/sistema`, chave `MODULO_CRM_B2B` em
 * `platform_config`), e a base devolve a instalação ao estado de fábrica antes
 * de cada lição — então ligamos aqui, pela mesma linha que `gravarModulo`
 * (lib/instalacao/modulos.ts) grava.
 *
 * Cinco empresas que contratam programas de saúde da Clínica Bem Viver para os
 * funcionários, uma em cada estado que a coluna "Situação" mostra: três já
 * completadas pela BrasilAPI ("ATIVA"), uma cadastrada sem CNPJ ("pending") e
 * uma cuja consulta falhou ("failed"). Os dados públicos (situação, porte,
 * CNAE) são gravados como a BrasilAPI os grava — nenhuma consulta sai daqui.
 * Os CNPJs são fictícios, com dígito verificador válido (a edição pela tela
 * recusa CNPJ inválido).
 *
 * Pessoas ligadas a duas delas (o cartão "Pessoas / decisores") e dois
 * telefones da Construtora (o cartão "Telefones"), como a importação de
 * planilha deixaria. A "Pão Dourado" fica sem pessoa nenhuma: é a que a lição
 * de exclusão consegue apagar.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos `d103…` + as empresas que
 * as lições criam pela tela, pelo nome) e recria.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { normalizePersonName } from "../../lib/crm-b2b/normalize";

const empresaId = (n: number) => `d1030000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pessoaId = (n: number) => `d1030100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vinculoId = (n: number) => `d1030200-0000-4000-8000-${String(n).padStart(12, "0")}`;
const telefoneId = (n: number) => `d1030300-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Nomes que as lições criam pela tela: limpos aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = ["Academia Corpo em Movimento"];

const HORA = 60;
const DIA = 24 * HORA;

type Empresa = {
  n: number;
  legal_name: string | null;
  trade_name: string;
  cnpj: string | null;
  registration_status: string | null;
  legal_nature: string | null;
  company_size: string | null;
  opened_at: string | null;
  main_cnae_code: string | null;
  main_cnae_description: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  email: string | null;
  phone: string | null;
  enrichment_status: "pending" | "completed" | "failed";
  enrichment_error: string | null;
  /** minutos atrás — a lista ordena pela última alteração */
  atualizada: number;
};

const EMPRESAS: Empresa[] = [
  {
    n: 1,
    legal_name: "Construtora Horizonte Paulista Ltda.",
    trade_name: "Construtora Horizonte Paulista",
    cnpj: "47.185.926/0001-62",
    registration_status: "ATIVA",
    legal_nature: "Sociedade Empresária Limitada",
    company_size: "DEMAIS",
    opened_at: "2009-03-16",
    main_cnae_code: "4120400",
    main_cnae_description: "Construção de edifícios",
    street: "Rua Vergueiro",
    number: "1855",
    complement: "Conjunto 42",
    district: "Vila Mariana",
    city: "São Paulo",
    state: "SP",
    zip_code: "04101-000",
    email: "rh.horizonte@exemplo.com.br",
    phone: "+55 11 98765-1201",
    enrichment_status: "completed",
    enrichment_error: null,
    atualizada: 2 * HORA,
  },
  {
    n: 2,
    legal_name: null,
    trade_name: "Colégio Novo Saber",
    cnpj: null,
    registration_status: null,
    legal_nature: null,
    company_size: null,
    opened_at: null,
    main_cnae_code: null,
    main_cnae_description: null,
    street: null,
    number: null,
    complement: null,
    district: "Saúde",
    city: "São Paulo",
    state: "SP",
    zip_code: null,
    email: "secretaria.novosaber@exemplo.com.br",
    phone: "+55 11 98765-1202",
    enrichment_status: "pending",
    enrichment_error: null,
    atualizada: 1 * DIA,
  },
  {
    n: 3,
    legal_name: "Rota Sul Transportes e Logística Ltda.",
    trade_name: "Transportadora Rota Sul",
    cnpj: "38.274.615/0001-89",
    registration_status: null,
    legal_nature: null,
    company_size: null,
    opened_at: null,
    main_cnae_code: null,
    main_cnae_description: null,
    street: null,
    number: null,
    complement: null,
    district: null,
    city: "Guarulhos",
    state: "SP",
    zip_code: null,
    email: null,
    phone: null,
    enrichment_status: "failed",
    // o texto que lib/crm-b2b/enrich.ts grava quando a consulta passa do tempo
    enrichment_error: "timeout: Timeout ao consultar a BrasilAPI.",
    atualizada: 2 * DIA,
  },
  {
    n: 4,
    legal_name: "Ribeiro & Matos Serviços Contábeis Ltda.",
    trade_name: "Escritório Contábil Ribeiro & Matos",
    cnpj: "29.503.847/0001-70",
    registration_status: "ATIVA",
    legal_nature: "Sociedade Empresária Limitada",
    company_size: "EMPRESA DE PEQUENO PORTE",
    opened_at: "2014-08-04",
    main_cnae_code: "6920601",
    main_cnae_description: "Atividades de contabilidade",
    street: "Rua dos Pinheiros",
    number: "870",
    complement: "Sala 12",
    district: "Pinheiros",
    city: "São Paulo",
    state: "SP",
    zip_code: "05422-001",
    email: "contato.ribeiromatos@exemplo.com.br",
    phone: "+55 11 98765-1204",
    enrichment_status: "completed",
    enrichment_error: null,
    atualizada: 8 * DIA,
  },
  {
    n: 5,
    legal_name: "Pão Dourado Panificadora Ltda.",
    trade_name: "Padaria Pão Dourado",
    cnpj: "61.482.739/0001-71",
    registration_status: "ATIVA",
    legal_nature: "Sociedade Empresária Limitada",
    company_size: "MICRO EMPRESA",
    opened_at: "2018-02-19",
    main_cnae_code: "1091102",
    main_cnae_description:
      "Fabricação de produtos de padaria e confeitaria com predominância de produção própria",
    street: "Avenida Ibirapuera",
    number: "2310",
    complement: null,
    district: "Moema",
    city: "São Paulo",
    state: "SP",
    zip_code: "04028-001",
    email: "padaria.paodourado@exemplo.com.br",
    phone: "+55 11 98765-1205",
    enrichment_status: "completed",
    enrichment_error: null,
    atualizada: 15 * DIA,
  },
];

const PESSOAS = [
  { n: 1, full_name: "Marcos Vieira", email: "marcos.vieira@exemplo.com.br" },
  { n: 2, full_name: "Patrícia Nunes", email: "patricia.nunes@exemplo.com.br" },
  { n: 3, full_name: "Luciana Ribeiro", email: "luciana.ribeiro@exemplo.com.br" },
];

const VINCULOS = [
  { n: 1, empresa: 1, pessoa: 1, job_title: "Gerente de Recursos Humanos", department: "Recursos Humanos", is_decision_maker: true, is_primary: true },
  { n: 2, empresa: 1, pessoa: 2, job_title: "Técnica de Segurança do Trabalho", department: "Segurança do Trabalho", is_decision_maker: false, is_primary: false },
  { n: 3, empresa: 4, pessoa: 3, job_title: "Sócia-diretora", department: null, is_decision_maker: true, is_primary: true },
];

/** Os telefones das pessoas da Construtora — o cartão "Telefones" da ficha. */
const TELEFONES = [
  { n: 1, pessoa: 1, name: "Marcos Vieira", phone_number: "+5511987651211" },
  { n: 2, pessoa: 2, name: "Patrícia Nunes", phone_number: "+5511987651212" },
];

const textoOuNulo = (t: string | null) => (t === null ? null : demo(t));

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_CRM_B2B", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Empresas e pessoas",
  );

  // ---------- limpar (telefones antes das pessoas; vínculos caem em cascata com a empresa) ----------
  semErro(
    await db.from("contacts").delete().eq("organization_id", org).in("id", TELEFONES.map((t) => telefoneId(t.n))),
    "limpar telefones do módulo",
  );
  semErro(
    await db.from("company_people").delete().eq("organization_id", org).in("id", VINCULOS.map((v) => vinculoId(v.n))),
    "limpar vínculos do módulo",
  );
  semErro(
    await db.from("people").delete().eq("organization_id", org).in("id", PESSOAS.map((p) => pessoaId(p.n))),
    "limpar pessoas do módulo",
  );
  semErro(
    await db.from("companies").delete().eq("organization_id", org).in("id", EMPRESAS.map((e) => empresaId(e.n))),
    "limpar empresas do módulo",
  );
  const criadas = CRIADAS_NAS_LICOES.map((n) => demo(n));
  semErro(
    await db.from("companies").delete().eq("organization_id", org).in("trade_name", criadas),
    "limpar empresas criadas nas lições",
  );

  // ---------- empresas ----------
  semErro(
    await db.from("companies").insert(
      EMPRESAS.map(({ n, atualizada, cnpj, ...e }) => ({
        id: empresaId(n),
        organization_id: org,
        legal_name: textoOuNulo(e.legal_name),
        trade_name: demo(e.trade_name),
        cnpj,
        normalized_cnpj: cnpj ? cnpj.replace(/\D/g, "") : null,
        registration_status: textoOuNulo(e.registration_status),
        legal_nature: textoOuNulo(e.legal_nature),
        company_size: textoOuNulo(e.company_size),
        share_capital: null,
        opened_at: e.opened_at,
        main_cnae_code: e.main_cnae_code,
        main_cnae_description: textoOuNulo(e.main_cnae_description),
        secondary_cnaes: [],
        street: textoOuNulo(e.street),
        number: e.number,
        complement: textoOuNulo(e.complement),
        district: textoOuNulo(e.district),
        city: textoOuNulo(e.city),
        state: e.state,
        zip_code: e.zip_code,
        email: e.email,
        phone: e.phone,
        enrichment_status: e.enrichment_status,
        enriched_at: e.enrichment_status === "pending" ? null : ha(atualizada),
        enrichment_error: textoOuNulo(e.enrichment_error),
        brasilapi_raw: null,
        created_by: pessoa.helena,
        created_at: ha(atualizada + 30 * DIA),
        updated_at: ha(atualizada),
      })),
    ),
    "empresas do módulo",
  );

  // ---------- pessoas e vínculos ----------
  semErro(
    await db.from("people").insert(
      PESSOAS.map((p) => ({
        id: pessoaId(p.n),
        organization_id: org,
        full_name: demo(p.full_name),
        normalized_name: normalizePersonName(demo(p.full_name)),
        email: p.email,
        notes: null,
        created_by: pessoa.helena,
        created_at: ha(40 * DIA),
        updated_at: ha(40 * DIA),
      })),
    ),
    "pessoas do módulo",
  );
  semErro(
    await db.from("company_people").insert(
      VINCULOS.map((v) => ({
        id: vinculoId(v.n),
        organization_id: org,
        company_id: empresaId(v.empresa),
        person_id: pessoaId(v.pessoa),
        job_title: demo(v.job_title),
        department: textoOuNulo(v.department),
        is_decision_maker: v.is_decision_maker,
        is_primary: v.is_primary,
        notes: null,
      })),
    ),
    "vínculos do módulo",
  );

  // ---------- telefones (contatos ligados às pessoas, como a importação deixa) ----------
  semErro(
    await db.from("contacts").insert(
      TELEFONES.map((t) => ({
        id: telefoneId(t.n),
        organization_id: org,
        name: demo(t.name),
        phone_number: t.phone_number,
        email: null,
        tags: [],
        source: "manual",
        birthdate: null,
        is_personal: false,
        person_id: pessoaId(t.pessoa),
        created_at: ha(40 * DIA),
        last_activity_at: null,
      })),
    ),
    "telefones do módulo",
  );
}

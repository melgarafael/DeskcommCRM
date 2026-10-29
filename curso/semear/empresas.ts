/**
 * Semente dos módulos "Empresas", "Pessoas" e "Importações" (CRM › Ver tudo em
 * CRM). As três telas leem as MESMAS tabelas (`companies`, `people`,
 * `company_people`, `contacts.person_id`, `import_batches`/`import_rows`), então
 * há uma semente só: `pessoas.ts` e `importacoes.ts` reexportam este `semear`, e
 * só este arquivo exporta `limpar` (a base chama todo `limpar` exportado; três
 * cópias apagariam a mesma coisa três vezes).
 *
 * A história: a Clínica Bem Viver vende programas de saúde para empresas da
 * região. Os cadastros entraram por DUAS planilhas, e o lote é a origem de cada
 * empresa, pessoa e telefone — o mesmo estado que `processCompaniesPeopleImport`
 * (lib/crm-b2b/import-process.ts) deixaria:
 *
 *  - "parceiros-padaria.xlsx" (12 dias atrás): a padaria e duas pessoas, tudo certo;
 *  - "contatos-feira-saude-empresarial.csv" (2 dias atrás): 8 linhas — 5 certas,
 *    1 conflito (o telefone já era do Marcos) e 2 falhas (CNPJ e telefone inválidos).
 *
 * Empresa com CNPJ válido foi consultada na BrasilAPI: três delas com sucesso,
 * gravadas como a consulta grava (nomes em maiúsculas, como na Receita); a da
 * Rota Sul com o "não encontrado" que a BrasilAPI devolve; a academia veio sem
 * CNPJ e fica em `pending` (não há o que consultar). Nenhuma lição clica em
 * "Consultar CNPJ" nem em "Enriquecer CNPJ": as duas chamam a BrasilAPI. A
 * empresa criada na lição não leva CNPJ, então o "Criar" também não consulta.
 *
 * Há ainda uma pessoa cadastrada à mão, sem empresa nem telefone: é o caso que a
 * tela "Nova pessoa" produz, porque o formulário só pede nome e e-mail.
 *
 * O módulo `crm_b2b` é desligado por padrão: ligamos aqui pela mesma linha que
 * `/admin/sistema` grava (CHAVE_DO_MODULO, lib/instalacao/modulos.ts). Desligar
 * fica com a base: `platform_config` é tabela da instalação, devolvida ao estado
 * de fábrica antes de cada lição.
 *
 * Telefones ficam em `contacts` (a base apaga TODOS os contatos da organização a
 * cada rodada, então estes só existem durante a aula deste módulo). CNPJs têm
 * dígito verificador válido e são fictícios; domínios em exemplo.com.br.
 */
import { normalizePersonName } from "../../lib/crm-b2b/normalize";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, ha, semErro } from "../semear-demonstracao";

/** `f1a0` + tipo (1 dígito) + número (3 dígitos): os 8 primeiros caracteres, que a tela do lote mostra, não se repetem. */
const id = (tipo: number, n: number) =>
  `f1a0${tipo}${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empresaId = (n: number) => id(1, n);
const pessoaId = (n: number) => id(2, n);
const vinculoId = (n: number) => id(3, n);
const telefoneId = (n: number) => id(4, n);
const loteId = (n: number) => id(5, n);
const linhaId = (n: number) => id(6, n);

/** O que as lições criam pela tela: apagado aqui para cada lição partir do mesmo estado. */
const EMPRESA_CRIADA_NA_LICAO = "Farmácia Vida Plena";
const PESSOA_CRIADA_NA_LICAO = "Patrícia Gomes";

const DIA = 24 * 60;
const FEIRA = 2 * DIA; // lote da feira
const PADARIA = 12 * DIA; // lote da padaria

type Empresa = {
  n: number;
  /** Como veio na planilha. */
  planilha: string;
  cnpj: string | null;
  /** Gravado pela consulta da BrasilAPI (`mapBrasilApiToCompanyFields`). */
  receita?: {
    legal_name: string;
    trade_name: string;
    company_size: string;
    main_cnae_code: string;
    main_cnae_description: string;
    street: string;
    number: string;
    district: string;
    zip_code: string;
    opened_at: string;
  };
  falhaNaConsulta?: string;
  atualizada: number;
};

const EMPRESAS: Empresa[] = [
  {
    n: 1, planilha: "Padaria Pão Dourado", cnpj: "38.471.265/0001-40", atualizada: PADARIA - 1,
    receita: {
      legal_name: "PAO DOURADO PANIFICADORA LTDA", trade_name: "PADARIA PAO DOURADO", company_size: "MICRO EMPRESA",
      main_cnae_code: "1091102", main_cnae_description: "Fabricação de produtos de padaria e confeitaria com predominância de produção própria",
      street: "DOMINGOS DE MORAIS", number: "1450", district: "VILA MARIANA", zip_code: "04010100", opened_at: "2011-03-14",
    },
  },
  {
    n: 2, planilha: "Construtora Horizonte Azul", cnpj: "47.195.623/0001-20", atualizada: FEIRA - 3,
    receita: {
      legal_name: "CONSTRUTORA HORIZONTE AZUL LTDA", trade_name: "CONSTRUTORA HORIZONTE AZUL", company_size: "EMPRESA DE PEQUENO PORTE",
      main_cnae_code: "4120400", main_cnae_description: "Construção de edifícios",
      street: "JABAQUARA", number: "2100", district: "MIRANDOPOLIS", zip_code: "04046300", opened_at: "2006-08-01",
    },
  },
  {
    n: 3, planilha: "Colégio Primeiros Passos", cnpj: "61.394.728/0001-30", atualizada: FEIRA - 2,
    receita: {
      legal_name: "EDUCANDARIO PRIMEIROS PASSOS LTDA", trade_name: "COLEGIO PRIMEIROS PASSOS", company_size: "DEMAIS",
      main_cnae_code: "8513900", main_cnae_description: "Ensino fundamental",
      street: "LORD COCHRANE", number: "380", district: "IPIRANGA", zip_code: "04213000", opened_at: "1998-02-02",
    },
  },
  {
    n: 4, planilha: "Transportes Rota Sul", cnpj: "73.820.564/0001-44", atualizada: FEIRA - 1,
    falhaNaConsulta: "not_found: CNPJ não encontrado na BrasilAPI.",
  },
  { n: 5, planilha: "Academia Movimento Livre", cnpj: null, atualizada: FEIRA },
];

type Pessoa = { n: number; nome: string; email?: string; empresa?: number; cargo?: string; atualizada: number };

const PESSOAS: Pessoa[] = [
  { n: 1, nome: "Renata Albuquerque", email: "renata@paodourado.exemplo.com.br", empresa: 1, cargo: "Sócia-administradora", atualizada: PADARIA },
  { n: 2, nome: "Fábio Lins", empresa: 1, cargo: "Gerente da loja", atualizada: PADARIA },
  { n: 3, nome: "Marcos Teixeira", email: "marcos.teixeira@horizonteazul.exemplo.com.br", empresa: 2, cargo: "Gerente de RH", atualizada: FEIRA },
  { n: 4, nome: "Juliana Prado", empresa: 2, cargo: "Técnica de segurança do trabalho", atualizada: FEIRA },
  { n: 5, nome: "Sílvia Moreira", email: "silvia.moreira@primeirospassos.exemplo.com.br", empresa: 3, cargo: "Diretora administrativa", atualizada: FEIRA },
  { n: 6, nome: "Diego Fontana", empresa: 5, cargo: "Sócio", atualizada: FEIRA },
  { n: 7, nome: "Paulo Henrique Sales", empresa: 4, cargo: "Coordenador de frota", atualizada: FEIRA },
  // cadastrada à mão em "Nova pessoa": sem empresa e sem telefone
  { n: 8, nome: "Beatriz Couto", email: "beatriz.couto@exemplo.com.br", atualizada: 5 * 60 },
];

/** Telefones (contatos) ligados às pessoas. O Marcos tem dois: celular e o fixo do RH. */
const TELEFONES = [
  { n: 1, pessoa: 1, numero: "+5511976541001", email: "renata@paodourado.exemplo.com.br", lote: 2 },
  { n: 2, pessoa: 2, numero: "+5511976541002", email: null, lote: 2 },
  { n: 3, pessoa: 3, numero: "+5511976541003", email: "marcos.teixeira@horizonteazul.exemplo.com.br", lote: 1 },
  { n: 4, pessoa: 3, numero: "+551133224410", email: null, lote: 1 },
  { n: 5, pessoa: 4, numero: "+5511976541004", email: null, lote: 1 },
  { n: 6, pessoa: 5, numero: "+5511976541005", email: "silvia.moreira@primeirospassos.exemplo.com.br", lote: 1 },
  { n: 7, pessoa: 6, numero: "+5511976541006", email: null, lote: 1 },
];

/** O que a tela reconhece sozinha (`suggestColumnMapping`): cabeçalhos com estes nomes. */
const MAPEAMENTO = { company_name: "empresa", cnpj: "cnpj", person_name: "nome", job_title: "cargo", phone: "telefone", email: "email" };

type Linha = {
  n: number;
  lote: number;
  planilha: { empresa: string; cnpj: string; nome: string; cargo: string; telefone: string; email: string };
  status: "success" | "conflict" | "failed";
  erro?: string;
  empresa?: number;
  pessoa?: number;
  telefone?: number;
};

const LINHAS: Linha[] = [
  // ---------- lote 2: parceiros-padaria.xlsx ----------
  { n: 1, lote: 2, status: "success", empresa: 1, pessoa: 1, telefone: 1,
    planilha: { empresa: "Padaria Pão Dourado", cnpj: "38.471.265/0001-40", nome: "Renata Albuquerque", cargo: "Sócia-administradora", telefone: "(11) 97654-1001", email: "renata@paodourado.exemplo.com.br" } },
  { n: 2, lote: 2, status: "success", empresa: 1, pessoa: 2, telefone: 2,
    planilha: { empresa: "Padaria Pão Dourado", cnpj: "38.471.265/0001-40", nome: "Fábio Lins", cargo: "Gerente da loja", telefone: "(11) 97654-1002", email: "" } },
  // ---------- lote 1: contatos-feira-saude-empresarial.csv ----------
  { n: 3, lote: 1, status: "success", empresa: 2, pessoa: 3, telefone: 3,
    planilha: { empresa: "Construtora Horizonte Azul", cnpj: "47.195.623/0001-20", nome: "Marcos Teixeira", cargo: "Gerente de RH", telefone: "(11) 97654-1003", email: "marcos.teixeira@horizonteazul.exemplo.com.br" } },
  { n: 4, lote: 1, status: "success", empresa: 2, pessoa: 3, telefone: 4,
    planilha: { empresa: "Construtora Horizonte Azul", cnpj: "47.195.623/0001-20", nome: "Marcos Teixeira", cargo: "Gerente de RH", telefone: "(11) 3322-4410", email: "" } },
  { n: 5, lote: 1, status: "success", empresa: 2, pessoa: 4, telefone: 5,
    planilha: { empresa: "Construtora Horizonte Azul", cnpj: "47.195.623/0001-20", nome: "Juliana Prado", cargo: "Técnica de segurança do trabalho", telefone: "(11) 97654-1004", email: "" } },
  { n: 6, lote: 1, status: "success", empresa: 3, pessoa: 5, telefone: 6,
    planilha: { empresa: "Colégio Primeiros Passos", cnpj: "61.394.728/0001-30", nome: "Sílvia Moreira", cargo: "Diretora administrativa", telefone: "(11) 97654-1005", email: "silvia.moreira@primeirospassos.exemplo.com.br" } },
  { n: 7, lote: 1, status: "success", empresa: 5, pessoa: 6, telefone: 7,
    planilha: { empresa: "Academia Movimento Livre", cnpj: "", nome: "Diego Fontana", cargo: "Sócio", telefone: "(11) 97654-1006", email: "" } },
  // o telefone digitado é o celular do Marcos: a pessoa entra, o telefone não muda de dono
  { n: 8, lote: 1, status: "conflict", erro: "Telefone já vinculado a outra pessoa.", empresa: 4, pessoa: 7, telefone: 3,
    planilha: { empresa: "Transportes Rota Sul", cnpj: "73.820.564/0001-44", nome: "Paulo Henrique Sales", cargo: "Coordenador de frota", telefone: "(11) 97654-1003", email: "" } },
  // dígito verificador errado: a linha para antes de criar qualquer coisa
  { n: 9, lote: 1, status: "failed", erro: "CNPJ inválido.",
    planilha: { empresa: "Mercado Bom Preço", cnpj: "52.638.417/0001-00", nome: "Rogério Antunes", cargo: "Comprador", telefone: "(11) 97654-1008", email: "" } },
  { n: 10, lote: 1, status: "failed", erro: "Telefone inválido.",
    planilha: { empresa: "Lavanderia Bolha Azul", cnpj: "", nome: "Tânia Reis", cargo: "Gerente", telefone: "9765-41", email: "" } },
];

const LOTES = [
  { n: 1, arquivo: "contatos-feira-saude-empresarial.csv", criado: FEIRA + 4 },
  { n: 2, arquivo: "parceiros-padaria.xlsx", criado: PADARIA + 4 },
];

const digitos = (s: string) => s.replace(/\D/g, "");

export async function limpar(c: Contexto) {
  const { db, org } = c;
  // os lotes levam as linhas em cascata; os vínculos empresa↔pessoa vão junto com a empresa ou a pessoa
  semErro(await db.from("import_batches").delete().eq("organization_id", org).in("id", LOTES.map((l) => loteId(l.n))), "limpar lotes de importação");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", TELEFONES.map((t) => telefoneId(t.n))), "limpar telefones das pessoas");
  semErro(await db.from("people").delete().eq("organization_id", org).in("id", PESSOAS.map((p) => pessoaId(p.n))), "limpar pessoas");
  semErro(await db.from("people").delete().eq("organization_id", org).eq("full_name", PESSOA_CRIADA_NA_LICAO), "limpar pessoa criada na lição");
  semErro(await db.from("companies").delete().eq("organization_id", org).in("id", EMPRESAS.map((e) => empresaId(e.n))), "limpar empresas");
  semErro(await db.from("companies").delete().eq("organization_id", org).eq("trade_name", EMPRESA_CRIADA_NA_LICAO), "limpar empresa criada na lição");
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_CRM_B2B", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Empresas e pessoas",
  );
  await limpar(c);

  semErro(
    await db.from("companies").insert(
      EMPRESAS.map((e) => {
        const cnpj = e.cnpj ? digitos(e.cnpj) : null;
        const consultada = e.receita !== undefined || e.falhaNaConsulta !== undefined;
        return {
          id: empresaId(e.n),
          organization_id: org,
          legal_name: e.receita?.legal_name ?? e.planilha,
          trade_name: e.receita?.trade_name ?? e.planilha,
          cnpj: e.cnpj,
          normalized_cnpj: cnpj,
          registration_status: e.receita ? "ATIVA" : null,
          legal_nature: e.receita ? "206-2 - Sociedade Empresária Limitada" : null,
          company_size: e.receita?.company_size ?? null,
          opened_at: e.receita?.opened_at ?? null,
          main_cnae_code: e.receita?.main_cnae_code ?? null,
          main_cnae_description: e.receita?.main_cnae_description ?? null,
          street: e.receita?.street ?? null,
          number: e.receita?.number ?? null,
          district: e.receita?.district ?? null,
          city: e.receita ? "SAO PAULO" : null,
          state: e.receita ? "SP" : null,
          zip_code: e.receita?.zip_code ?? null,
          enrichment_status: e.receita ? "completed" : e.falhaNaConsulta ? "failed" : "pending",
          enrichment_error: e.falhaNaConsulta ?? null,
          enriched_at: consultada ? ha(e.atualizada) : null,
          created_by: pessoa.helena,
          created_at: ha(e.atualizada + 2),
          updated_at: ha(e.atualizada),
        };
      }),
    ),
    "empresas",
  );

  semErro(
    await db.from("people").insert(
      PESSOAS.map((p) => ({
        id: pessoaId(p.n),
        organization_id: org,
        full_name: p.nome,
        normalized_name: normalizePersonName(p.nome),
        email: p.email ?? null,
        created_by: pessoa.helena,
        created_at: ha(p.atualizada),
        updated_at: ha(p.atualizada),
      })),
    ),
    "pessoas",
  );

  semErro(
    await db.from("company_people").insert(
      PESSOAS.flatMap((p) =>
        p.empresa === undefined
          ? []
          : [{
              id: vinculoId(p.n),
              organization_id: org,
              company_id: empresaId(p.empresa),
              person_id: pessoaId(p.n),
              job_title: p.cargo ? demo(p.cargo) : null,
              // como a importação grava (`processOneRow`)
              is_decision_maker: true,
            }],
      ),
    ),
    "pessoas ligadas às empresas",
  );

  semErro(
    await db.from("contacts").insert(
      TELEFONES.map((t) => {
        const nome = PESSOAS.find((p) => p.n === t.pessoa)?.nome;
        if (!nome) throw new Error(`telefone ${t.n} aponta para uma pessoa que não existe`);
        return {
          id: telefoneId(t.n),
          organization_id: org,
          name: nome,
          display_name: nome,
          phone_number: t.numero,
          email: t.email,
          person_id: pessoaId(t.pessoa),
          source: "import_csv",
          source_metadata: { import_batch_id: loteId(t.lote) },
          created_by_user_id: pessoa.helena,
        };
      }),
    ),
    "telefones das pessoas",
  );

  semErro(
    await db.from("import_batches").insert(
      LOTES.map((l) => {
        const linhas = LINHAS.filter((x) => x.lote === l.n);
        const conta = (s: Linha["status"]) => linhas.filter((x) => x.status === s).length;
        return {
          id: loteId(l.n),
          organization_id: org,
          kind: "companies_people",
          filename: l.arquivo,
          status: "completed",
          total_rows: linhas.length,
          processed_rows: linhas.length,
          successful_rows: conta("success"),
          conflict_rows: conta("conflict"),
          failed_rows: conta("failed"),
          column_mapping: MAPEAMENTO,
          created_by: pessoa.helena,
          created_at: ha(l.criado),
          completed_at: ha(l.criado - 1),
        };
      }),
    ),
    "lotes de importação",
  );

  semErro(
    await db.from("import_rows").insert(
      LOTES.flatMap((l) =>
        LINHAS.filter((x) => x.lote === l.n).map((x, i) => {
          const tel = TELEFONES.find((t) => t.n === x.telefone);
          return {
            id: linhaId(x.n),
            organization_id: org,
            batch_id: loteId(l.n),
            row_number: i + 2, // cabeçalho na linha 1, como a importação conta
            raw_data: x.planilha,
            normalized_data: {
              company_name: x.planilha.empresa,
              legal_name: "",
              trade_name: "",
              cnpj: x.planilha.cnpj,
              person_name: x.planilha.nome,
              job_title: x.planilha.cargo,
              phone: x.planilha.telefone,
              email: x.planilha.email,
              phone_e164: x.status === "failed" ? null : (tel?.numero ?? null),
              normalized_cnpj: x.erro === "CNPJ inválido." || !x.planilha.cnpj ? null : digitos(x.planilha.cnpj),
            },
            status: x.status,
            error: x.erro ?? null,
            company_id: x.empresa ? empresaId(x.empresa) : null,
            person_id: x.pessoa ? pessoaId(x.pessoa) : null,
            contact_id: x.telefone ? telefoneId(x.telefone) : null,
            created_at: ha(l.criado - 1),
          };
        }),
      ),
    ),
    "linhas dos lotes",
  );
}

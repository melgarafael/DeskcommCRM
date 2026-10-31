/**
 * Semente do módulo "Pessoas" (CRM › Ver tudo em CRM › Pessoas).
 *
 * A tela só existe com o recurso opcional da instalação "Empresas e pessoas
 * (venda para empresas)" ligado (`/admin/sistema`, chave `MODULO_CRM_B2B` em
 * `platform_config`), e a base devolve a instalação ao estado de fábrica antes
 * de cada lição — então ligamos aqui, pela mesma linha que `gravarModulo`
 * (lib/instalacao/modulos.ts) grava.
 *
 * Quatro pessoas das empresas que contratam programas de saúde da Clínica Bem
 * Viver, cada uma num estado que a ficha mostra:
 * - Renata: uma empresa e DOIS telefones (o "com vários telefones" do cartão);
 * - Eduardo: sócio de DUAS empresas do mesmo dono, com um telefone;
 * - Gustavo: uma empresa e nenhum telefone;
 * - Simone: sem e-mail, sem empresa e sem telefone (o traço na lista e os dois
 *   quadros vazios da ficha), como fica quem é cadastrado à mão.
 * Os vínculos e os telefones são gravados como a importação de planilha os
 * grava (`lib/crm-b2b/import-process.ts`): é a única tela que os cria.
 *
 * As empresas têm `updated_at` antigo para ficarem no fim da lista de Empresas,
 * e `limpar` (chamada pela base antes de QUALQUER aula) tira tudo daqui, para
 * nada sobrar nas fotos de outro módulo.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos `d104…` + as pessoas que
 * as lições criam pela tela, pelo nome) e recria.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo, traducaoDaDemonstracao } from "../espanhol-demonstracao";
import { normalizePersonName } from "../../lib/crm-b2b/normalize";

const pessoaId = (n: number) => `d1040000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empresaId = (n: number) => `d1040100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vinculoId = (n: number) => `d1040200-0000-4000-8000-${String(n).padStart(12, "0")}`;
const telefoneId = (n: number) => `d1040300-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Nomes que as lições criam pela tela: limpos aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = ["Cláudia Moreira"];

const HORA = 60;
const DIA = 24 * HORA;

const EMPRESAS = [
  { n: 1, trade_name: "Supermercados Alvorada", legal_name: "Alvorada Comércio de Alimentos Ltda.", district: "Ipiranga" },
  { n: 2, trade_name: "Escola de Idiomas Fala Mundo", legal_name: "Fala Mundo Ensino de Idiomas Ltda.", district: "Vila Mariana" },
  { n: 3, trade_name: "Fala Mundo Kids", legal_name: "Fala Mundo Kids Recreação e Ensino Ltda.", district: "Vila Mariana" },
];

const PESSOAS = [
  { n: 1, full_name: "Renata Figueiredo", email: "renata.figueiredo@alvorada.exemplo.com.br", atualizada: 3 * HORA },
  { n: 2, full_name: "Eduardo Matsumoto", email: "eduardo@falamundo.exemplo.com.br", atualizada: 1 * DIA },
  { n: 3, full_name: "Gustavo Pereira", email: "gustavo.pereira@alvorada.exemplo.com.br", atualizada: 5 * DIA },
  { n: 4, full_name: "Simone Albuquerque", email: null, atualizada: 12 * DIA },
];

const VINCULOS = [
  { n: 1, empresa: 1, pessoa: 1, job_title: "Gerente de Recursos Humanos" },
  { n: 2, empresa: 2, pessoa: 2, job_title: "Sócio-diretor" },
  { n: 3, empresa: 3, pessoa: 2, job_title: "Diretor administrativo" },
  { n: 4, empresa: 1, pessoa: 3, job_title: "Coordenador de Segurança do Trabalho" },
];

/** Os telefones, como a importação os deixa: um contato por número, ligado à pessoa. */
const TELEFONES = [
  { n: 1, pessoa: 1, phone_number: "+5511987651401" },
  { n: 2, pessoa: 1, phone_number: "+5511987651402" },
  { n: 3, pessoa: 2, phone_number: "+5511987651403" },
];

/** Limpeza chamada antes de QUALQUER aula: estas pessoas e empresas não sobram em outra tela. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  // telefones antes das pessoas; os vínculos caem em cascata, mas saem pelo id por clareza
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
  semErro(
    await db
      .from("people")
      .delete()
      .eq("organization_id", org)
      // sem `demo`: a base chama `limpar` antes de toda aula, e um nome sem tradução não pode derrubá-la
      .in("full_name", CRIADAS_NAS_LICOES.flatMap((n) => [n, traducaoDaDemonstracao(n) ?? n])),
    "limpar pessoas criadas nas lições",
  );
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

  // ---------- empresas (só o que a ficha da pessoa mostra: o nome) ----------
  semErro(
    await db.from("companies").insert(
      EMPRESAS.map((e) => ({
        id: empresaId(e.n),
        organization_id: org,
        legal_name: demo(e.legal_name),
        trade_name: demo(e.trade_name),
        cnpj: null,
        normalized_cnpj: null,
        district: demo(e.district),
        city: demo("São Paulo"),
        state: "SP",
        enrichment_status: "pending",
        created_by: pessoa.helena,
        created_at: ha(120 * DIA),
        updated_at: ha(90 * DIA),
      })),
    ),
    "empresas do módulo",
  );

  // ---------- pessoas ----------
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
        created_at: ha(p.atualizada + 30 * DIA),
        updated_at: ha(p.atualizada),
      })),
    ),
    "pessoas do módulo",
  );

  // ---------- vínculos (a importação marca quem vem na planilha como decisor) ----------
  semErro(
    await db.from("company_people").insert(
      VINCULOS.map((v) => ({
        id: vinculoId(v.n),
        organization_id: org,
        company_id: empresaId(v.empresa),
        person_id: pessoaId(v.pessoa),
        job_title: demo(v.job_title),
        department: null,
        is_decision_maker: true,
        is_primary: false,
        notes: null,
      })),
    ),
    "vínculos do módulo",
  );

  // ---------- telefones (contatos ligados às pessoas, como a importação deixa) ----------
  semErro(
    await db.from("contacts").insert(
      TELEFONES.map((t) => {
        const nome = demo(PESSOAS.find((p) => p.n === t.pessoa)!.full_name);
        return {
          id: telefoneId(t.n),
          organization_id: org,
          name: nome,
          display_name: nome,
          phone_number: t.phone_number,
          email: null,
          tags: [],
          source: "import_csv",
          birthdate: null,
          is_personal: false,
          person_id: pessoaId(t.pessoa),
          created_at: ha(40 * DIA),
          last_activity_at: null,
        };
      }),
    ),
    "telefones do módulo",
  );
}

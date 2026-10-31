/**
 * Semente do módulo "Importações" (CRM › Ver tudo em CRM › Importações).
 *
 * A tela só existe com o recurso opcional da instalação "Empresas e pessoas
 * (venda para empresas)" ligado (`/admin/sistema`, chave `MODULO_CRM_B2B` em
 * `platform_config`), e a base devolve a instalação ao estado de fábrica antes
 * de cada lição — então ligamos aqui, pela mesma linha que `gravarModulo`
 * (lib/instalacao/modulos.ts) grava.
 *
 * Vazia, a tela é só o campo do arquivo e "Nenhuma importação ainda." — nada
 * ensina a ler um lote. O capturador não sobe arquivo (não há ação de upload
 * no contrato da lição), e a importação de verdade consultaria a BrasilAPI para
 * cada CNPJ novo. Por isso a semente grava TRÊS lotes já importados, exatamente
 * como `processCompaniesPeopleImport` (lib/crm-b2b/import-process.ts) os deixa:
 * o lote, uma linha de `import_rows` por linha da planilha (com o número da
 * linha, o status e o erro que o processador escreve) e o que cada linha criou
 * — empresa, pessoa ligada como decisora com o cargo, e o telefone como contato
 * (`source = 'import_csv'`). O resultado de cada linha foi conferido passando
 * as mesmas planilhas pelo processador real com um banco de mentira em memória.
 *
 *  - "convenio-empresas-setembro.csv": uma linha certa e uma linha só de
 *    separadores (";;;;"), que o processador recusa como linha vazia;
 *  - "decisores-feira-de-saude.xlsx": duas linhas certas, a do síndico Sérgio;
 *  - "empresas-parceiras-outubro.csv" (o mais novo): três certas (duas na
 *    mesma empresa, pelo CNPJ; uma sem telefone), um CONFLITO (o telefone da
 *    linha já é do Sérgio, do lote anterior) e duas FALHAS (CNPJ com dígito
 *    errado e telefone curto). Linha que falha antes de gravar não cria nada.
 *
 * As mensagens de erro e os status ficam como o produto os grava (em português
 * e em inglês, respectivamente, em qualquer idioma da conta): não passam por
 * `demo`, para a foto em espanhol mostrar o que a tela mostra de verdade.
 *
 * Os ids variam os dígitos 5–8 do primeiro bloco (d1081…, d1082…): a tela do
 * lote mostra os 8 primeiros caracteres do id da empresa, da pessoa e do
 * contato, e ids iguais nesse trecho fariam empresas diferentes parecerem a
 * mesma. Telefones +55 11 98765-18xx/-1821 são fictícios.
 *
 * `limpar` (chamada pela base antes de QUALQUER aula) tira tudo daqui, para os
 * contatos, pessoas e empresas importados não sobrarem nas fotos de outro
 * módulo. Idempotente: apaga só as próprias linhas e recria.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { normalizeCnpj, normalizePersonName } from "../../lib/crm-b2b/normalize";
import { normalizePhoneBR } from "../../lib/channels/phone-variants";

const loteId = (n: number) => `d1080000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Tabela no 5º dígito, sequência nos 6º–8º: o começo do id muda de linha para linha. */
const idDe = (tabela: 1 | 2 | 3 | 4 | 5) => (n: number) =>
  `d108${tabela}${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empresaId = idDe(1);
const pessoaId = idDe(2);
const vinculoId = idDe(3);
const contatoId = idDe(4);
const linhaId = idDe(5);

const HORA = 60;
const DIA = 24 * HORA;
/**
 * O processador grava uma linha depois da outra: cada linha da planilha ganha
 * ~1 s a mais que a anterior. Sem isso, pessoas do mesmo lote empatam no
 * "Atualizado" e a ordem da lista de Pessoas muda de uma foto para outra.
 */
const SEGUNDO = 1 / 60;
const naLinha = (quando: number, indice: number) => ha(quando - (indice + 1) * SEGUNDO);

/** Os campos que o importador entende (MappingField, lib/crm-b2b/spreadsheet.ts). */
const CAMPOS = ["company_name", "legal_name", "trade_name", "cnpj", "person_name", "job_title", "phone", "email"] as const;
type Campo = (typeof CAMPOS)[number];

/** O que `suggestColumnMapping` devolve para cada cabeçalho usado aqui. */
const CAMPO_DO_CABECALHO: Record<string, Campo> = {
  Empresa: "company_name",
  CNPJ: "cnpj",
  Nome: "person_name",
  Cargo: "job_title",
  Telefone: "phone",
  "E-mail": "email",
};

type Desfecho =
  | { status: "success"; empresa: number; pessoa: number; contato: number | null }
  | { status: "conflict"; error: string; empresa: number; pessoa: number; contato: number }
  | { status: "failed"; error: string };

type Linha = { n: number; celulas: string[]; desfecho: Desfecho };

type Lote = {
  n: number;
  arquivo: string;
  /** minutos atrás */
  quando: number;
  cabecalho: string[];
  linhas: Linha[];
};

/** Mensagens que o processador grava (lib/crm-b2b/import-process.ts), byte a byte. */
const VAZIA = "Linha vazia — sem empresa, pessoa ou telefone.";
const CNPJ_INVALIDO = "CNPJ inválido.";
const TELEFONE_INVALIDO = "Telefone inválido.";
const TELEFONE_DE_OUTRA_PESSOA = "Telefone já vinculado a outra pessoa.";

const LOTES: Lote[] = [
  {
    n: 3,
    arquivo: "convenio-empresas-setembro.csv",
    quando: 26 * DIA,
    cabecalho: ["Empresa", "CNPJ", "Nome", "Cargo", "Telefone"],
    linhas: [
      {
        n: 1,
        celulas: ["Gráfica Expressa", "73.620.519/0001-46", "Roberta Campos", "Gerente administrativa", "(11) 98765-1821"],
        desfecho: { status: "success", empresa: 1, pessoa: 1, contato: 1 },
      },
      { n: 2, celulas: ["", "", "", "", ""], desfecho: { status: "failed", error: VAZIA } },
    ],
  },
  {
    n: 2,
    arquivo: "decisores-feira-de-saude.xlsx",
    quando: 9 * DIA,
    cabecalho: ["Empresa", "Nome", "Cargo", "Telefone", "E-mail"],
    linhas: [
      {
        n: 3,
        celulas: ["Condomínio Parque das Flores", "Sérgio Tavares", "Síndico", "(11) 98765-1811", "sergio.tavares@exemplo.com.br"],
        desfecho: { status: "success", empresa: 2, pessoa: 2, contato: 2 },
      },
      {
        n: 4,
        celulas: ["Condomínio Parque das Flores", "Lúcia Barros", "Administradora", "(11) 98765-1812", "lucia.barros@exemplo.com.br"],
        desfecho: { status: "success", empresa: 2, pessoa: 3, contato: 3 },
      },
    ],
  },
  {
    n: 1,
    arquivo: "empresas-parceiras-outubro.csv",
    quando: 2 * HORA,
    cabecalho: ["Empresa", "CNPJ", "Nome", "Cargo", "Telefone", "E-mail"],
    linhas: [
      {
        n: 5,
        celulas: ["Metalúrgica Santa Rita", "52.816.437/0001-00", "Fernanda Lopes", "Gerente de Recursos Humanos", "(11) 98765-1801", "fernanda.lopes@exemplo.com.br"],
        desfecho: { status: "success", empresa: 3, pessoa: 4, contato: 4 },
      },
      {
        n: 6,
        celulas: ["Metalúrgica Santa Rita", "52.816.437/0001-00", "Rogério Antunes", "Técnico de Segurança do Trabalho", "(11) 98765-1802", ""],
        desfecho: { status: "success", empresa: 3, pessoa: 5, contato: 5 },
      },
      {
        n: 7,
        celulas: ["Hotel Jardim Paulista", "", "Cristina Ramos", "Coordenadora de Recursos Humanos", "", "cristina.ramos@exemplo.com.br"],
        desfecho: { status: "success", empresa: 4, pessoa: 6, contato: null },
      },
      {
        n: 8,
        celulas: ["Hotel Jardim Paulista", "", "Paulo Henrique Dias", "Diretor administrativo", "(11) 98765-1811", "paulo.dias@exemplo.com.br"],
        // o número já é do contato do Sérgio (lote de 9 dias atrás)
        desfecho: { status: "conflict", error: TELEFONE_DE_OUTRA_PESSOA, empresa: 4, pessoa: 7, contato: 2 },
      },
      {
        n: 9,
        celulas: ["Padaria Trigo de Ouro", "61.904.228/0001-15", "Márcia Teixeira", "Sócia", "(11) 98765-1806", ""],
        desfecho: { status: "failed", error: CNPJ_INVALIDO },
      },
      {
        n: 10,
        celulas: ["Escola Pequeno Príncipe", "", "Juliana Prado", "Diretora", "9876-12", "juliana.prado@exemplo.com.br"],
        desfecho: { status: "failed", error: TELEFONE_INVALIDO },
      },
    ],
  },
];

/** Empresas criadas pelas linhas. As de CNPJ já passaram pelo enriquecimento da BrasilAPI. */
const EMPRESAS = [
  // `linha`: índice da primeira linha do lote que cadastrou a empresa
  { n: 1, lote: 3, linha: 0, nome: "Gráfica Expressa", razao: "Gráfica Expressa Impressos Ltda.", cnpj: "73.620.519/0001-46" },
  { n: 2, lote: 2, linha: 0, nome: "Condomínio Parque das Flores", razao: null, cnpj: null },
  { n: 3, lote: 1, linha: 0, nome: "Metalúrgica Santa Rita", razao: "Metalúrgica Santa Rita Ltda.", cnpj: "52.816.437/0001-00" },
  { n: 4, lote: 1, linha: 2, nome: "Hotel Jardim Paulista", razao: null, cnpj: null },
];

/** Colunas das células de cada lote, para achar nome, cargo, telefone e e-mail da linha. */
function campos(lote: Lote, l: Linha): Record<Campo, string> {
  const out = Object.fromEntries(CAMPOS.map((c) => [c, ""])) as Record<Campo, string>;
  lote.cabecalho.forEach((h, i) => {
    out[CAMPO_DO_CABECALHO[h]!] = (l.celulas[i] ?? "").trim();
  });
  return out;
}

/** Texto da semente na língua da foto; vazio continua vazio. */
const traduzir = (t: string) => (t ? demo(t) : t);

/** Uma linha como a planilha chegou, já na língua da foto (nomes de pessoa e e-mails não mudam). */
function celulasNaLingua(lote: Lote, l: Linha): Record<Campo, string> {
  const c = campos(lote, l);
  return {
    ...c,
    company_name: traduzir(c.company_name),
    person_name: traduzir(c.person_name),
    job_title: traduzir(c.job_title),
  };
}

/** Limpeza chamada antes de QUALQUER aula: os dados importados não sobram em outra tela. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  const linhas = LOTES.flatMap((l) => l.linhas);
  // os lotes levam as linhas em cascata; contatos antes das pessoas, vínculos antes das empresas
  semErro(
    await db.from("import_batches").delete().eq("organization_id", org).in("id", LOTES.map((l) => loteId(l.n))),
    "limpar lotes do módulo",
  );
  semErro(
    await db.from("import_rows").delete().eq("organization_id", org).in("id", linhas.map((l) => linhaId(l.n))),
    "limpar linhas dos lotes do módulo",
  );
  semErro(
    await db.from("contacts").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5].map(contatoId)),
    "limpar contatos importados do módulo",
  );
  semErro(
    await db.from("company_people").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5, 6, 7].map(vinculoId)),
    "limpar vínculos do módulo",
  );
  semErro(
    await db.from("people").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5, 6, 7].map(pessoaId)),
    "limpar pessoas do módulo",
  );
  semErro(
    await db.from("companies").delete().eq("organization_id", org).in("id", EMPRESAS.map((e) => empresaId(e.n))),
    "limpar empresas do módulo",
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

  const quandoDoLote = (n: number) => LOTES.find((l) => l.n === n)!.quando;

  // ---------- empresas ----------
  semErro(
    await db.from("companies").insert(
      EMPRESAS.map((e) => {
        const quando = quandoDoLote(e.lote);
        const digitos = e.cnpj ? normalizeCnpj(e.cnpj) : null;
        if (e.cnpj && !digitos) throw new Error(`CNPJ da semente inválido: ${e.cnpj}`);
        return {
          id: empresaId(e.n),
          organization_id: org,
          legal_name: demo(e.razao ?? e.nome),
          trade_name: demo(e.nome),
          // com CNPJ, o enriquecimento grava o número formatado e os dados públicos
          cnpj: e.cnpj,
          normalized_cnpj: digitos,
          // a situação vem da Receita, em português, em qualquer idioma da conta
          registration_status: digitos ? "ATIVA" : null,
          city: digitos ? demo("São Paulo") : null,
          state: digitos ? "SP" : null,
          // sem CNPJ, o processador deixa `pending` e nada mais o muda
          enrichment_status: digitos ? "completed" : "pending",
          enriched_at: digitos ? ha(quando - 1) : null,
          created_by: pessoa.helena,
          created_at: naLinha(quando, e.linha),
          // o enriquecimento termina depois do lote e atualiza a empresa
          updated_at: digitos ? ha(quando - 1) : naLinha(quando, e.linha),
        };
      }),
    ),
    "empresas importadas do módulo",
  );

  // ---------- pessoas, vínculos e contatos, na ordem das linhas ----------
  const pessoas: Record<string, unknown>[] = [];
  const vinculos: Record<string, unknown>[] = [];
  const contatos: Record<string, unknown>[] = [];
  for (const lote of LOTES) {
    for (const [i, l] of lote.linhas.entries()) {
      const d = l.desfecho;
      if (d.status === "failed") continue;
      const v = celulasNaLingua(lote, l);
      pessoas.push({
        id: pessoaId(d.pessoa),
        organization_id: org,
        full_name: v.person_name,
        normalized_name: normalizePersonName(v.person_name),
        email: v.email || null,
        created_by: pessoa.helena,
        created_at: naLinha(lote.quando, i),
        updated_at: naLinha(lote.quando, i),
      });
      vinculos.push({
        id: vinculoId(d.pessoa),
        organization_id: org,
        company_id: empresaId(d.empresa),
        person_id: pessoaId(d.pessoa),
        job_title: v.job_title || null,
        is_decision_maker: true,
      });
      // o conflito reaproveita o contato de outro lote: não cria contato novo
      if (d.status === "success" && d.contato !== null) {
        const telefone = normalizePhoneBR(v.phone);
        if (!telefone) throw new Error(`telefone da semente inválido: ${v.phone}`);
        contatos.push({
          id: contatoId(d.contato),
          organization_id: org,
          name: v.person_name,
          display_name: v.person_name,
          phone_number: telefone,
          email: v.email || null,
          person_id: pessoaId(d.pessoa),
          source: "import_csv",
          source_metadata: { import_batch_id: loteId(lote.n) },
          created_by_user_id: pessoa.helena,
          created_at: naLinha(lote.quando, i),
        });
      }
    }
  }
  semErro(await db.from("people").insert(pessoas), "pessoas importadas do módulo");
  semErro(await db.from("company_people").insert(vinculos), "vínculos importados do módulo");
  semErro(await db.from("contacts").insert(contatos), "contatos importados do módulo");

  // ---------- lotes e linhas ----------
  for (const lote of LOTES) {
    const conta = (s: Desfecho["status"]) => lote.linhas.filter((l) => l.desfecho.status === s).length;
    const mapeamento = Object.fromEntries(lote.cabecalho.map((h) => [CAMPO_DO_CABECALHO[h]!, h]));
    semErro(
      await db.from("import_batches").insert({
        id: loteId(lote.n),
        organization_id: org,
        kind: "companies_people",
        filename: demo(lote.arquivo),
        status: "completed",
        total_rows: lote.linhas.length,
        processed_rows: lote.linhas.length,
        successful_rows: conta("success"),
        failed_rows: conta("failed"),
        conflict_rows: conta("conflict"),
        column_mapping: mapeamento,
        created_by: pessoa.helena,
        created_at: ha(lote.quando),
        completed_at: naLinha(lote.quando, lote.linhas.length),
      }),
      `lote ${lote.arquivo}`,
    );
    semErro(
      await db.from("import_rows").insert(
        lote.linhas.map((l, i) => {
          const v = celulasNaLingua(lote, l);
          const d = l.desfecho;
          const bruto = Object.fromEntries(
            lote.cabecalho.map((h) => [h, v[CAMPO_DO_CABECALHO[h]!]]),
          );
          // o processador só calcula telefone e CNPJ quando a linha passa da conferência do CNPJ
          const telefone = d.status === "failed" && d.error === CNPJ_INVALIDO ? null : normalizePhoneBR(v.phone);
          return {
            id: linhaId(l.n),
            organization_id: org,
            batch_id: loteId(lote.n),
            // a linha 1 da planilha é a dos nomes das colunas
            row_number: i + 2,
            raw_data: bruto,
            normalized_data: { ...v, phone_e164: telefone, normalized_cnpj: v.cnpj ? normalizeCnpj(v.cnpj) : null },
            status: d.status,
            error: d.status === "success" ? null : d.error,
            company_id: d.status === "failed" ? null : empresaId(d.empresa),
            person_id: d.status === "failed" ? null : pessoaId(d.pessoa),
            contact_id: d.status === "failed" ? null : d.contato === null ? null : contatoId(d.contato),
            created_at: naLinha(lote.quando, i),
          };
        }),
      ),
      `linhas do lote ${lote.arquivo}`,
    );
  }
}

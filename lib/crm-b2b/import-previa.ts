/**
 * A PRÉVIA da importação de empresas e pessoas (A23, issue #4888).
 *
 * Antes de gravar, cada linha da planilha é CLASSIFICADA contra a base e contra
 * as outras linhas do próprio arquivo. A importação grava só as `nova`; o resto
 * fica de fora, com o motivo, para a pessoa baixar e resolver com o responsável.
 * Não existe "importar tudo": a prévia é a proteção.
 *
 * Duas camadas, de propósito:
 *  - `classificarLinhas` é PURA (linhas + o que já existe → veredito por linha),
 *    e é onde mora a regra. Testa-se sem banco.
 *  - `previaDaImportacao` lê o que já existe (contatos por celular e e-mail,
 *    empresas por CNPJ) em consultas em lote e chama a pura.
 *
 * ## A régua de "já existe"
 *
 * - **Contato:** celular OU e-mail iguais. O celular é o normalizado de sempre
 *   (com ou sem +55 e o 9; também o número extra de uma ficha). O e-mail em
 *   minúsculas. O NOME nunca entra: duas pessoas se chamam João.
 * - **E-mail de prefixo genérico** (`contato@`, `vendas@`…) NÃO conta: é caixa
 *   compartilhada, e juntaria pessoas diferentes. Nesses casos vale só o celular.
 * - **Empresa:** o mesmo CNPJ. A empresa existente É reaproveitada: a linha entra
 *   como `anexada` (a pessoa e o contato nascem ligados a ela, sem empresa
 *   duplicada). Só vale para linha COM telefone; a linha só de empresa tem a
 *   regra própria descrita abaixo. Empresa sem CNPJ nunca é conferida por nome (erro de
 *   digitação juntaria empresas diferentes).
 *
 * ## Dentro da planilha
 *
 * - Linha IDÊNTICA a uma anterior: `repetida`, descartada com aviso.
 * - Mesmo celular ou e-mail com dados DIFERENTES, ou o celular de uma linha e o
 *   e-mail de OUTRA: `conflito`. A primeira linha do arquivo fica com a chave.
 * - Linha de pessoa/contato sem telefone não entra (`sem_telefone`): o contato é o que
 *   o produto atende, e uma pessoa sem número seria cadastro órfão.
 * - Linha SÓ de empresa (sem pessoa e sem telefone) entra sem telefone, como sempre
 *   entrou: `nova` (ou `ja_existe` se o CNPJ já está na base; `repetida` se idêntica).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { MENSAGEM_DE_CNPJ_INVALIDO, normalizeCnpj } from "@/lib/crm-b2b/normalize";
import { applyMapping, type MappingField, type SheetMatrix } from "@/lib/crm-b2b/spreadsheet";
import { contatosDonosDosExtras } from "@/lib/channels/contato-por-telefone";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";

type SB = SupabaseClient;

export type StatusDaLinha =
  | "nova"
  | "anexada"
  | "ja_existe"
  | "conflito"
  | "repetida"
  | "sem_telefone"
  | "invalida";

export interface ExistenteNaBase {
  tipo: "contato" | "empresa";
  id: string;
  nome: string | null;
  /** Dono da carteira; sem dono, quem cadastrou. `null` quando nenhum dos dois consta. */
  donoId: string | null;
}

export interface LinhaClassificada {
  /** Número da linha na PLANILHA (o mesmo de `import_rows.row_number`). */
  rowNumber: number;
  status: StatusDaLinha;
  /** A frase para quem lê o CSV; `null` na linha nova. */
  motivo: string | null;
  existente?: ExistenteNaBase;
}

export interface LinhaParaClassificar {
  rowNumber: number;
  mapped: Record<MappingField, string>;
}

/** O que a base já tem, indexado pela chave de comparação. */
export interface ExistentesNaBase {
  contatosPorCelular: Map<string, ExistenteNaBase>;
  contatosPorEmail: Map<string, ExistenteNaBase>;
  empresasPorCnpj: Map<string, ExistenteNaBase>;
}

/** Prefixos de caixa compartilhada: o e-mail não identifica uma pessoa. */
const PREFIXOS_GENERICOS = new Set([
  "contato",
  "contatos",
  "vendas",
  "comercial",
  "financeiro",
  "atendimento",
  "sac",
  "suporte",
  "info",
  "adm",
  "nfe",
  "recepcao",
  "recepção",
]);

/** O e-mail que identifica uma pessoa: minúsculo, com `@`, e que não é caixa compartilhada. */
export function emailQueIdentifica(bruto: string): string | null {
  const email = bruto.trim().toLowerCase();
  const arroba = email.indexOf("@");
  if (arroba <= 0 || arroba === email.length - 1) return null;
  if (PREFIXOS_GENERICOS.has(email.slice(0, arroba))) return null;
  return email;
}

/** A assinatura da linha, para dizer "idêntica" sem depender de espaço ou caixa. */
function assinaturaDaLinha(m: Record<MappingField, string>, celular: string | null, cnpj: string | null): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return JSON.stringify([
    norm(m.company_name),
    norm(m.legal_name),
    norm(m.trade_name),
    cnpj ?? "",
    norm(m.person_name),
    norm(m.job_title),
    celular ? canonicalPhoneBR(celular) : "",
    norm(m.email),
  ]);
}

export function classificarLinhas(
  linhas: readonly LinhaParaClassificar[],
  existentes: ExistentesNaBase,
): LinhaClassificada[] {
  const donaDoCelular = new Map<string, number>(); // chave → índice da 1ª linha
  const donaDoEmail = new Map<string, number>();
  const assinaturas: string[] = [];
  const assinaturasDeEmpresa = new Map<string, number>(); // linha só de empresa → nº da 1ª linha
  const saida: LinhaClassificada[] = [];

  linhas.forEach((linha, idx) => {
    const { rowNumber, mapped } = linha;
    const celular = mapped.phone ? normalizePhoneBR(mapped.phone) : null;
    const cnpj = mapped.cnpj ? normalizeCnpj(mapped.cnpj) : null;
    const descartar = (status: StatusDaLinha, motivo: string, existente?: ExistenteNaBase) => {
      assinaturas[idx] = "";
      saida.push({ rowNumber, status, motivo, ...(existente ? { existente } : {}) });
    };

    // ── Linhas que nem chegam à comparação ───────────────────────────────────
    if (mapped.cnpj.trim() && !cnpj) return descartar("invalida", MENSAGEM_DE_CNPJ_INVALIDO);
    if (mapped.phone.trim() && !celular) return descartar("invalida", "Telefone inválido.");
    const algumaCoisa = Object.values(mapped).some((v) => v.trim() !== "");
    if (!algumaCoisa) return descartar("invalida", "Linha vazia — sem empresa, pessoa ou telefone.");
    if (!celular) {
      // Só a linha de CONTATO/PESSOA exige telefone (decisão do mantenedor, doc 380, opção B).
      // A linha só de EMPRESA (sem pessoa e sem telefone) entra como sempre entrou: listas B2B de
      // empresas costumam chegar sem número.
      const soEmpresa =
        !mapped.person_name.trim() &&
        (cnpj || mapped.company_name.trim() || mapped.legal_name.trim() || mapped.trade_name.trim());
      if (!soEmpresa) return descartar("sem_telefone", "Linha sem telefone: não entra na importação.");

      const assinaturaDaEmpresa = assinaturaDaLinha(mapped, null, cnpj);
      const anterior = assinaturasDeEmpresa.get(assinaturaDaEmpresa);
      if (anterior !== undefined) {
        return descartar("repetida", `Repetida: idêntica à linha ${anterior}.`);
      }
      assinaturasDeEmpresa.set(assinaturaDaEmpresa, rowNumber);
      const empresaDaBase = cnpj ? existentes.empresasPorCnpj.get(cnpj) : undefined;
      if (empresaDaBase) {
        return descartar(
          "ja_existe",
          `Empresa já cadastrada com este CNPJ${empresaDaBase.nome ? ` (${empresaDaBase.nome})` : ""}: a linha não traz pessoa nem telefone, então não há nada a acrescentar.`,
          empresaDaBase,
        );
      }
      assinaturas[idx] = "";
      saida.push({ rowNumber, status: "nova", motivo: null });
      return;
    }

    const chaveCelular = canonicalPhoneBR(celular);
    const chaveEmail = emailQueIdentifica(mapped.email);
    const assinatura = assinaturaDaLinha(mapped, celular, cnpj);

    // ── Dentro da planilha ───────────────────────────────────────────────────
    const doCelular = donaDoCelular.get(chaveCelular);
    const doEmail = chaveEmail ? donaDoEmail.get(chaveEmail) : undefined;
    if (doCelular !== undefined && doEmail !== undefined && doCelular !== doEmail) {
      return descartar(
        "conflito",
        `O celular é da linha ${linhas[doCelular]!.rowNumber} e o e-mail é da linha ${linhas[doEmail]!.rowNumber}: dois registros diferentes na planilha.`,
      );
    }
    const anterior = doCelular ?? doEmail;
    if (anterior !== undefined) {
      const nLinha = linhas[anterior]!.rowNumber;
      if (assinaturas[anterior] === assinatura) {
        return descartar("repetida", `Repetida: idêntica à linha ${nLinha}.`);
      }
      return descartar(
        "conflito",
        `Mesmo celular ou e-mail da linha ${nLinha}, com dados diferentes.`,
      );
    }

    // ── Contra a base ────────────────────────────────────────────────────────
    const contato =
      existentes.contatosPorCelular.get(chaveCelular) ??
      (chaveEmail ? existentes.contatosPorEmail.get(chaveEmail) : undefined);
    if (contato) {
      donaDoCelular.set(chaveCelular, idx);
      if (chaveEmail) donaDoEmail.set(chaveEmail, idx);
      assinaturas[idx] = assinatura;
      saida.push({
        rowNumber,
        status: "ja_existe",
        motivo: "Já existe um contato com este celular ou e-mail.",
        existente: contato,
      });
      return;
    }
    // A empresa com este CNPJ já existe: a linha entra ANEXADA a ela. O processador já
    // reaproveita a empresa pelo CNPJ; aqui só avisamos, na prévia, que foi isso que houve.
    const empresa = cnpj ? existentes.empresasPorCnpj.get(cnpj) : undefined;
    if (empresa) {
      donaDoCelular.set(chaveCelular, idx);
      if (chaveEmail) donaDoEmail.set(chaveEmail, idx);
      assinaturas[idx] = assinatura;
      saida.push({
        rowNumber,
        status: "anexada",
        motivo: `Empresa já cadastrada com este CNPJ: a pessoa e o contato entram ligados a ela${empresa.nome ? ` (${empresa.nome})` : ""}.`,
        existente: empresa,
      });
      return;
    }

    donaDoCelular.set(chaveCelular, idx);
    if (chaveEmail) donaDoEmail.set(chaveEmail, idx);
    assinaturas[idx] = assinatura;
    saida.push({ rowNumber, status: "nova", motivo: null });
  });

  return saida;
}

export interface TotaisDaPrevia {
  total: number;
  novas: number;
  /** Linha nova de empresa que já existe (mesmo CNPJ): entra, ligada a ela. */
  anexadas: number;
  ja_existem: number;
  conflitos: number;
  repetidas: number;
  sem_telefone: number;
  invalidas: number;
}

export function totaisDaPrevia(linhas: readonly LinhaClassificada[]): TotaisDaPrevia {
  const t: TotaisDaPrevia = {
    total: linhas.length,
    novas: 0,
    anexadas: 0,
    ja_existem: 0,
    conflitos: 0,
    repetidas: 0,
    sem_telefone: 0,
    invalidas: 0,
  };
  for (const l of linhas) {
    if (l.status === "nova") t.novas += 1;
    else if (l.status === "anexada") t.anexadas += 1;
    else if (l.status === "ja_existe") t.ja_existem += 1;
    else if (l.status === "conflito") t.conflitos += 1;
    else if (l.status === "repetida") t.repetidas += 1;
    else if (l.status === "sem_telefone") t.sem_telefone += 1;
    else t.invalidas += 1;
  }
  return t;
}

const LOTE = 200;

function emLotes<T>(itens: readonly T[]): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += LOTE) lotes.push(itens.slice(i, i + LOTE));
  return lotes;
}

interface ContatoLido {
  id: string;
  phone_number: string | null;
  email: string | null;
  name: string | null;
  display_name: string | null;
  carteira_user_id: string | null;
  created_by_user_id: string | null;
}

const COLUNAS_DO_CONTATO = "id, phone_number, email, name, display_name, carteira_user_id, created_by_user_id";

function comoExistente(c: ContatoLido): ExistenteNaBase {
  return {
    tipo: "contato",
    id: c.id,
    nome: nomeDoContato(c),
    donoId: c.carteira_user_id ?? c.created_by_user_id ?? null,
  };
}

/**
 * Lê da base o que as linhas podem estar repetindo. Consultas em lote (nunca uma
 * por linha) e SEMPRE com `organization_id`. Erro de leitura LANÇA: seguir sem
 * saber o que existe é criar a duplicata que a prévia veio impedir.
 */
export async function carregarExistentes(
  supabase: SB,
  organizationId: string,
  linhas: readonly LinhaParaClassificar[],
): Promise<ExistentesNaBase> {
  const existentes: ExistentesNaBase = {
    contatosPorCelular: new Map(),
    contatosPorEmail: new Map(),
    empresasPorCnpj: new Map(),
  };

  const celulares = new Set<string>();
  const emails = new Set<string>();
  const cnpjs = new Set<string>();
  for (const { mapped } of linhas) {
    const cel = mapped.phone ? normalizePhoneBR(mapped.phone) : null;
    if (cel) celulares.add(cel);
    const email = emailQueIdentifica(mapped.email);
    if (email) {
      // O `in` do banco é sensível à caixa: pede a forma da planilha e a minúscula.
      emails.add(email);
      emails.add(mapped.email.trim());
    }
    const cnpj = mapped.cnpj ? normalizeCnpj(mapped.cnpj) : null;
    if (cnpj) cnpjs.add(cnpj);
  }

  // Celular principal — todas as variações do número brasileiro.
  const variacoes = [...new Set([...celulares].flatMap((c) => phoneLookupVariants(c)))];
  for (const lote of emLotes(variacoes)) {
    const { data, error } = await supabase
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("organization_id", organizationId)
      .is("is_merged_into", null)
      .in("phone_number", lote);
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as ContatoLido[]) {
      if (c.phone_number) existentes.contatosPorCelular.set(canonicalPhoneBR(c.phone_number), comoExistente(c));
    }
  }

  // Celular que a ficha guarda como EXTRA.
  const donas = await contatosDonosDosExtras(supabase, organizationId, [...celulares]);
  const idsDonas = [...new Set(donas.values())];
  for (const lote of emLotes(idsDonas)) {
    const { data, error } = await supabase
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("organization_id", organizationId)
      .is("is_merged_into", null)
      .in("id", lote);
    if (error) throw new Error(error.message);
    const porId = new Map(((data ?? []) as ContatoLido[]).map((c) => [c.id, c]));
    for (const [canonico, id] of donas) {
      const c = porId.get(id);
      if (c && !existentes.contatosPorCelular.has(canonico)) {
        existentes.contatosPorCelular.set(canonico, comoExistente(c));
      }
    }
  }

  // E-mail que identifica uma pessoa.
  for (const lote of emLotes([...emails])) {
    const { data, error } = await supabase
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("organization_id", organizationId)
      .is("is_merged_into", null)
      .in("email", lote);
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as ContatoLido[]) {
      const chave = c.email ? emailQueIdentifica(c.email) : null;
      if (chave) existentes.contatosPorEmail.set(chave, comoExistente(c));
    }
  }

  // Empresa pelo CNPJ.
  for (const lote of emLotes([...cnpjs])) {
    const { data, error } = await supabase
      .from("companies")
      .select("id, trade_name, legal_name, normalized_cnpj, created_by")
      .eq("organization_id", organizationId)
      .in("normalized_cnpj", lote);
    if (error) throw new Error(error.message);
    for (const e of (data ?? []) as Array<{
      id: string;
      trade_name: string | null;
      legal_name: string | null;
      normalized_cnpj: string | null;
      created_by: string | null;
    }>) {
      if (e.normalized_cnpj) {
        existentes.empresasPorCnpj.set(e.normalized_cnpj, {
          tipo: "empresa",
          id: e.id,
          nome: e.trade_name ?? e.legal_name ?? null,
          donoId: e.created_by,
        });
      }
    }
  }

  return existentes;
}

/** O número da linha na planilha: o mesmo que `processCompaniesPeopleImport` grava. */
export function numeroDaLinha(sheet: SheetMatrix, i: number): number {
  return sheet.rowNumbers?.[i] ?? i + 2;
}

export function linhasDaPlanilha(
  sheet: SheetMatrix,
  mapping: Partial<Record<MappingField, string>>,
): LinhaParaClassificar[] {
  return sheet.rows.map((cells, i) => ({
    rowNumber: numeroDaLinha(sheet, i),
    mapped: applyMapping(sheet.headers, cells, mapping),
  }));
}

/** A prévia inteira: lê a base, classifica e devolve o veredito por linha. */
export async function previaDaImportacao(
  supabase: SB,
  opts: {
    organizationId: string;
    sheet: SheetMatrix;
    mapping: Partial<Record<MappingField, string>>;
  },
): Promise<LinhaClassificada[]> {
  const linhas = linhasDaPlanilha(opts.sheet, opts.mapping);
  const existentes = await carregarExistentes(supabase, opts.organizationId, linhas);
  return classificarLinhas(linhas, existentes);
}

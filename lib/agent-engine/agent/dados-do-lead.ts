/**
 * Extração DETERMINÍSTICA de dados do lead a partir da última mensagem do cliente.
 *
 * Por que existe: depender só do prompt para capturar CPF/CNH/data de nascimento é
 * frágil (o modelo ora repergunta, ora deixa de perguntar). Aqui a captura é feita por
 * regra fixa, no fechamento do turno, e gravada em `contacts.custom_fields` — que é
 * limpo pela anonimização (`trg_contacts_anonimizado_limpa_custom_fields`), o que
 * mantém a conformidade LGPD.
 *
 * Escopo deliberadamente conservador: só grava o que casa com um padrão inequívoco.
 * CPF exige 11 dígitos e não pode ser repetição (ex.: 11111111111). Data só é tratada
 * como nascimento quando há palavra de contexto ("nasci", "nascimento"). CNH só com
 * verbo de posse/ausência explícito.
 */
import type pg from 'pg';

export interface DadosExtraidos {
  cpf?: string;
  data_nascimento?: string;
  cnh?: boolean;
}

const RE_CPF = /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/;
const RE_DATA = /\b(\d{2})[/\-.](\d{2})[/\-.](\d{4})\b/;
const RE_CNH_SIM = /\b(tenho|possuo|tenho sim|sim,?\s*tenho)\s+(cnh|habilita[cç][aã]o|carteira)\b/i;
const RE_CNH_NAO = /\b(n[aã]o tenho|sem|n[aã]o possuo)\s+(cnh|habilita[cç][aã]o|carteira)\b/i;

/** Extrai os dados determinísticos da fala do cliente. Nunca lança. */
export function extrairDadosDoTexto(texto: string | null | undefined): DadosExtraidos {
  const out: DadosExtraidos = {};
  const t = texto ?? '';
  if (t.trim() === '') return out;

  const cpf = RE_CPF.exec(t);
  if (cpf) {
    const digitos = cpf[1]!.replace(/\D/g, '');
    if (digitos.length === 11 && !/^(\d)\1{10}$/.test(digitos)) out.cpf = digitos;
  }

  // Data de nascimento só com contexto — evita capturar datas soltas (entrega, visita).
  if (/\b(nascimento|nasci|nascid\w*|data de nasc\w*)\b/i.test(t)) {
    const m = RE_DATA.exec(t);
    if (m) {
      const dia = Number(m[1]);
      const mes = Number(m[2]);
      if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
        out.data_nascimento = `${m[1]}/${m[2]}/${m[3]}`;
      }
    }
  }

  if (RE_CNH_NAO.test(t)) out.cnh = false;
  else if (RE_CNH_SIM.test(t)) out.cnh = true;

  return out;
}

/**
 * Grava os dados extraídos no contato do lead (merge em `custom_fields`).
 * Best-effort: qualquer falha é engolida pelo chamador (não pode derrubar o turno).
 */
export async function gravarDadosDeterministicos(
  pool: pg.Pool,
  args: { tenantId: string; contatoId: string; texto: string | null },
): Promise<void> {
  if (!args.texto) return;
  const dados = extrairDadosDoTexto(args.texto);
  if (Object.keys(dados).length === 0) return;

  await pool.query(
    `update contacts
        set custom_fields = coalesce(custom_fields, '{}'::jsonb) || $3::jsonb
      where organization_id = $1 and id = $2`,
    [args.tenantId, args.contatoId, JSON.stringify(dados)],
  );
}

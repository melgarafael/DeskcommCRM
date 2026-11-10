/**
 * A DATA DE UMA MENSAGEM no formato de quem lê — e no fuso da organização.
 *
 * ─── O defeito que este arquivo fecha (#4339) ──────────────────────────────
 *
 * O campo de data de um negócio é gravado em ISO (`2026-11-16`) e chegava assim
 * à mensagem da automação. Para quem escreveu a regra o valor está "certo"; para
 * o cliente brasileiro que recebe o WhatsApp é um número que ele lê como
 * `16/11` ou `11/16`, dependendo do hábito — ou simplesmente não lê.
 *
 * ─── Por que a ORDEM dos campos vem do `Intl`, e não de uma tabela ─────────
 *
 * Uma tabela `pt-BR → dd/mm/aaaa` resolveria o Brasil e erraria o resto: o
 * produto serve espanhol e a organização pode ter sido instalada com uma
 * etiqueta herdada (`en-US`) que o seletor de interface não oferece mais. A
 * ordem (`dia/mês/ano` × `mês/dia/ano`) é uma pergunta que o runtime já sabe
 * responder por idioma — medindo com uma data de controle e lendo a ORDEM das
 * partes, o formato nasce do idioma em vez de uma lista que envelhece.
 *
 * ─── Por que a hora NÃO escorrega ──────────────────────────────────────────
 *
 * `2026-11-17T02:30:00Z` é 23:30 de 16/11 em São Paulo. Formatar em UTC daria
 * `17/11` — um dia a mais na reserva do cliente, que é o erro mais caro que uma
 * mensagem de agenda pode cometer. Valor COM fuso declarado é resolvido no fuso
 * da organização (`partesNoFuso`, a mesma camada da agenda); valor SÓ com data
 * (`2026-11-16`) é um dia de calendário e não passa por conversão nenhuma —
 * converter um dia sem hora é justamente como se ganha e se perde um dia.
 *
 * ─── O que ele nunca faz ───────────────────────────────────────────────────
 *
 * Inventar. Valor que não é data ISO válida (`amanhã`, `16/11/2026`,
 * `2026-02-31`) volta EXATAMENTE como veio: "Invalid Date" numa mensagem é pior
 * que a data crua, e um `31/02` corrigido em silêncio seria dado errado com
 * aparência de certo. Formato explícito que não se entende também devolve o
 * valor intacto.
 */
import { partesNoFuso } from "@/lib/agenda/fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { IDIOMA_PADRAO } from "./idiomas";
import { MODIFICADOR_DE_DATA } from "@/lib/texto/modificador-da-variavel";

/** O que o render sabe da organização que está falando com o cliente. */
export interface OpcoesDaData {
  /** `organizations.locale` — o idioma de quem LÊ a mensagem. */
  idioma: string;
  /** `organizations.timezone` (IANA) — o fuso em que o dia vira. */
  fuso: string;
}

type Campo = "dia" | "mes" | "ano";

interface OrdemDaData {
  ordem: Campo[];
  separador: string;
}

/**
 * A ordem dos campos por idioma, medida uma vez.
 *
 * `formatToParts` de uma data de controle (3 de fevereiro de 2001, sem
 * ambiguidade nenhuma entre dia e mês) devolve as partes na ordem em que aquele
 * idioma as escreve — junto com o separador literal que ele usa.
 */
const ORDENS = new Map<string, OrdemDaData>();
const AMOSTRA = new Date(Date.UTC(2001, 1, 3));

function tagDoIdioma(bruto: string | null | undefined): string {
  const candidato = (bruto ?? "").trim();
  if (candidato === "") return IDIOMA_PADRAO;
  try {
    // Fuso/idioma inválido lança `RangeError`; a mensagem não pode cair por
    // causa de uma coluna de texto livre.
    new Intl.DateTimeFormat(candidato);
    return candidato;
  } catch {
    return IDIOMA_PADRAO;
  }
}

function ordemDoIdioma(tag: string): OrdemDaData {
  const guardada = ORDENS.get(tag);
  if (guardada) return guardada;

  const partes = new Intl.DateTimeFormat(tag, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(AMOSTRA);

  const ordem: Campo[] = [];
  for (const parte of partes) {
    if (parte.type === "day") ordem.push("dia");
    else if (parte.type === "month") ordem.push("mes");
    else if (parte.type === "year") ordem.push("ano");
  }
  const separador = partes.find((parte) => parte.type === "literal")?.value.trim() || "/";
  // Idioma que não devolveu os três campos (calendário exótico) cai no formato
  // do produto: é melhor uma data legível em português que uma data pela metade.
  const medida: OrdemDaData =
    ordem.length === 3 ? { ordem, separador } : { ordem: ["dia", "mes", "ano"], separador: "/" };
  ORDENS.set(tag, medida);
  return medida;
}

const TOKEN_DO_CAMPO: Record<string, Campo> = {
  dd: "dia",
  mm: "mes",
  aaaa: "ano",
  yyyy: "ano",
};

/** `dd/mm/aaaa`, `aaaa-mm-dd`, `dd.mm.aaaa` — os três campos, um separador só. */
const FORMATO_EXPLICITO = /^(dd|mm|aaaa|yyyy)([/.-])(dd|mm|aaaa|yyyy)\2(dd|mm|aaaa|yyyy)$/i;

function ordemDoFormatoExplicito(bruto: string): OrdemDaData | null {
  const casado = FORMATO_EXPLICITO.exec(bruto.trim());
  if (!casado) return null;
  const ordem = [casado[1]!, casado[3]!, casado[4]!].map((token) => TOKEN_DO_CAMPO[token.toLowerCase()]!);
  // `mm/mm/aaaa` tem três campos e não é data: exige os três DIFERENTES.
  if (new Set(ordem).size !== 3) return null;
  return { ordem, separador: casado[2]! };
}

const DOIS_DIGITOS = (n: number): string => String(n).padStart(2, "0");

function montar(ano: number, mes: number, dia: number, formato: OrdemDaData): string {
  const valores: Record<Campo, string> = {
    dia: DOIS_DIGITOS(dia),
    mes: DOIS_DIGITOS(mes),
    ano: String(ano).padStart(4, "0"),
  };
  return formato.ordem.map((campo) => valores[campo]).join(formato.separador);
}

const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const COM_HORA =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function dataValida(ano: number, mes: number, dia: number): boolean {
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasNoMes(ano, mes);
}

/**
 * As três partes de uma data ISO — ou `null` quando o valor não é data.
 *
 * Sem hora declarada, a data é o próprio dia (nada de conversão); com fuso
 * declarado, o instante é resolvido no fuso da organização.
 */
function partesDaDataIso(valor: string, fuso: string): { ano: number; mes: number; dia: number } | null {
  const texto = valor.trim();

  const soData = SO_DATA.exec(texto);
  if (soData) {
    const [ano, mes, dia] = [Number(soData[1]), Number(soData[2]), Number(soData[3])];
    return dataValida(ano, mes, dia) ? { ano, mes, dia } : null;
  }

  const comHora = COM_HORA.exec(texto);
  if (!comHora) return null;
  const [ano, mes, dia] = [Number(comHora[1]), Number(comHora[2]), Number(comHora[3])];
  if (!dataValida(ano, mes, dia)) return null;

  const deslocamento = comHora[7];
  // Hora de parede sem fuso: quem gravou não disse de que relógio falava, e
  // adivinhar (UTC ou o da organização) mudaria o dia de metade dos registros.
  if (!deslocamento) return { ano, mes, dia };

  const instante = new Date(texto.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (Number.isNaN(instante.getTime())) return { ano, mes, dia };
  const noFuso = partesNoFuso(instante, fusoUtilizavel(fuso));
  return { ano: noFuso.ano, mes: noFuso.mes, dia: noFuso.dia };
}

/**
 * O valor com o modificador de data aplicado — ou o valor INTACTO.
 *
 * `modificador` é o que veio depois da barra: `data` ou `data:dd/mm/aaaa`.
 * Devolve o próprio `valor` sempre que não houver o que formatar, que é o que
 * garante o "sai como está hoje" das regras de borda.
 */
export function formatarValorComModificadorDeData(
  valor: string,
  modificador: string,
  opcoes: OpcoesDaData,
): string {
  if (!modificador.toLowerCase().startsWith(MODIFICADOR_DE_DATA)) return valor;

  const doisPontos = modificador.indexOf(":");
  const formato =
    doisPontos < 0
      ? ordemDoIdioma(tagDoIdioma(opcoes.idioma))
      : ordemDoFormatoExplicito(modificador.slice(doisPontos + 1));
  if (!formato) return valor;

  const partes = partesDaDataIso(valor, opcoes.fuso);
  if (!partes) return valor;

  return montar(partes.ano, partes.mes, partes.dia, formato);
}


import { normalizePhoneBR } from "@/lib/webhooks/inbound";
/**
 * Parser de CSV para importação de contatos — RFC 4180, zero dependências.
 *
 * Por que não `papaparse`/`xlsx`: o repo não tinha NENhuma lib de planilha e a
 * importação é de CSV mesmo (XLSX exigiria SheetJS inteiro por um recurso que
 * todo Excel exporta como CSV). Parser próprio, pequeno e testado, evita
 * dependência transitiva nova numa instalação self-host.
 *
 * Escopo deliberado: só CSV. XLSX é recusado na borda (rota) com mensagem que
 * ensina a exportar como CSV — recusa abata melhor que meia-parse.
 */

/** Máximo defensivo: arquivo maior que isso é recusado antes do parse. */
/**
 * Os BYTES do upload viram texto — e o arquivo que não é texto é RECUSADO.
 *
 * `File.text()` decodifica sempre como UTF-8. O Excel em português exporta
 * cp1252 por padrão, e o desfecho dependia de onde estava o acento (issue #483):
 *
 *   acento nos DADOS      -> IMPORTAVA, com `nome = "A��o C�nica �"`
 *   acento no CABEÇALHO   -> 422 "Encontrei: C�digo, Produto, Pre�o, Marca."
 *
 * O segundo falha fechado e até é didático. O primeiro falha ABERTO: entra lixo
 * no catálogo sem um erro sequer, e é esse nome que o agente lê para o cliente.
 *
 * O desempate não é detecção de charset, é uma prova: `TextDecoder("utf-8")` só
 * produz U+FFFD quando o byte-stream NÃO é UTF-8 válido. Ausência de U+FFFD é
 * prova de que UTF-8 é a leitura certa; presença é prova de que não é.
 *
 * O `windows-1252` "consegue" ler qualquer byte, então cair nele sem olhar o
 * resultado transformaria um .xlsx renomeado em 300 produtos de nome ilegível.
 * Por isso a segunda leitura é CONFERIDA: byte de controle (fora de TAB, CR e
 * LF) não aparece em CSV de verdade, e aí o arquivo é recusado com a mesma
 * instrução que a tela já dá.
 *
 * O que isto NÃO alcança, e está escrito para ninguém supor: o mojibake da
 * ORIGEM — "AÃ§Ã£o", UTF-8 já gravado como latin-1 pelo sistema que gerou a
 * planilha — é UTF-8 VÁLIDO, não tem U+FFFD nenhum, e passa limpo. É outro
 * defeito, com outra evidência.
 */
export function decodificarCsv(bytes: ArrayBuffer | Uint8Array): { texto: string } | { erro: string } {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("\uFFFD")) return { texto: semBom(utf8) };

  const latin = new TextDecoder("windows-1252").decode(buf);
  // eslint-disable-next-line no-control-regex -- é exatamente o que se procura
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(latin)) {
    return {
      erro:
        "Este arquivo não parece ser um CSV de texto. No Excel use “Salvar como” → “CSV UTF-8 (delimitado por vírgulas)”.",
    };
  }
  return { texto: semBom(latin) };
}

/** O BOM vira caractere invisível no primeiro cabeçalho e cria coluna fantasma. */
function semBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

export const CSV_MAX_BYTES = 5 * 1024 * 1024;

/** Teto de linhas de dados por importação (protege o round-trip do handler). */
export const CSV_MAX_DATA_ROWS = 500;

const DELIMITERS = [",", ";", "\t"] as const;

/**
 * Parseia CSV RFC 4180: campos entre aspas com vírgula/quebra dentro, aspas
 * escapadas como "", separadores CRLF, CR ou LF. BOM UTF-8 é removido.
 * Delimitador detectado na primeira linha (fora de aspas) entre vírgula,
 * ponto-e-vírgula e tabulação — Excel pt-BR exporta com ";".
 */
export function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Última linha sem quebra final ainda precisa entrar.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  let best: string = DELIMITERS[0];
  let bestCount = -1;
  for (const d of DELIMITERS) {
    // Conta apenas fora de aspas — vírgula dentro de "Silva, Maria" não é delimitador.
    let count = 0;
    let inQuotes = false;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Cabeçalho → campo canônico
// ---------------------------------------------------------------------------

/**
 * Aceita apelidos pt-BR/en porque a planilha é feita por humano: quem importa
 * tem "Telefone" no Excel, não "phone_number". Acento/caixa/separador são
 * normalizados ("Data de Nascimento" → data_de_nascimento).
 */
const HEADER_ALIASES: Record<string, readonly string[]> = {
  name: ["name", "nome", "cliente"],
  display_name: ["display_name", "apelido", "nome_de_exibicao"],
  email: ["email", "e_mail"],
  phone_number: ["phone_number", "telefone", "whatsapp", "celular", "fone"],
  cpf: ["cpf"],
  birthdate: ["birthdate", "nascimento", "data_de_nascimento", "aniversario"],
  tags: ["tags", "etiquetas", "grupos"],
};

function normalizaHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Mapeia a linha de cabeçalho para os índices dos campos canônicos.
 * Retorna null com o motivo quando o cabeçalho não traz NENHUM identificador
 * (telefone/e-mail) — sem isso nada importável existe, e falhar aberto é
 * melhor que criar 300 contatos vazios.
 */
export function mapHeader(header: string[]): { indices: Record<string, number>; motivo: string | null } {
  const indices: Record<string, number> = {};
  header.forEach((rawCell, idx) => {
    const cell = normalizaHeader(rawCell);
    for (const [campo, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(cell) && indices[campo] === undefined) {
        indices[campo] = idx;
        break;
      }
    }
  });
  const temIdentificador = indices.phone_number !== undefined || indices.email !== undefined;
  return {
    indices,
    motivo: temIdentificador ? null : "cabeçalho sem coluna de telefone nem e-mail",
  };
}

// ---------------------------------------------------------------------------
// Normalização de valor por campo
// ---------------------------------------------------------------------------

export interface LinhaNormalizada {
  name?: string;
  display_name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  birthdate?: string;
  tags?: string[];
}

/**
 * Telephone → E.164 **assumindo Brasil quando não há DDI**.
 *
 * A regra NÃO mora aqui: é `normalizePhoneBR` (`lib/webhooks/inbound.ts`), a
 * mesma que a ingestão de webhook usa desde sempre. Reusar em vez de reescrever
 * é o ponto — a versão anterior deste arquivo tinha uma TERCEIRA regra, e ela
 * produzia número quebrado: `"(11) 99999-8888"` virava `+11999998888`, em que o
 * `11` (que é DDD) ocupava o lugar do DDI. Um `+11` é os Estados Unidos, e o
 * resto do número não existe lá — mensagem para pessoa errada, ou para ninguém.
 *
 * O que a regra da casa faz: 10 ou 11 dígitos sem `+` são DDD + número e ganham
 * `+55`; 12 ou 13 dígitos precisam começar com `55`; quem já vem com `+` é
 * respeitado como está (internacional continua possível, é só escrever o DDI).
 *
 * Decisão do dono do produto, 2026-08-24: o público é brasileiro, então assumir
 * `+55` é a leitura certa de uma planilha sem DDI — e é o que a ingestão já fazia.
 */
export function normalizaTelefone(raw: string): string | null {
  return normalizePhoneBR(raw);
}

/**
 * Data → ISO `YYYY-MM-DD`. Aceita ISO nativo e BR `DD/MM/YYYY` (o do Excel).
 *
 * A data é VALIDADA de verdade, não só casada por formato: `31/02/1990` tem a
 * forma certa e o dia não existe. Sem a conferência ele virava `1990-02-31` e
 * chegava ao Postgres, que recusa a linha inteira com erro cru — a planilha
 * falhava com uma mensagem de banco em vez de "dia inválido nesta linha", que é
 * o que a tela promete ao dizer "desfecho por linha".
 */
function ehDataReal(ano: number, mes: number, dia: number): boolean {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

export function normalizaData(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return ehDataReal(+iso[1]!, +iso[2]!, +iso[3]!) ? t : null;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (br) {
    return ehDataReal(+br[3]!, +br[2]!, +br[1]!) ? `${br[3]}-${br[2]}-${br[1]}` : null;
  }
  return null;
}

/**
 * Converte UMA linha de dados (já mapeada pelo mapHeader) nos campos de contato.
 * Campos ausentes ficam undefined; valores inválidos geram erro nominal — a linha
 * é pulada, as demais seguem. `linha` é 1-based já contando o cabeçalho, para
 * bater com o que o usuário vê no editor.
 */
export function mapLinha(
  cells: string[],
  indices: Record<string, number>,
): { contato: LinhaNormalizada; motivo: string | null } {
  const get = (campo: string): string => {
    const idx = indices[campo];
    return idx === undefined ? "" : (cells[idx] ?? "").trim();
  };

  const contato: LinhaNormalizada = {};

  const name = get("name");
  if (name !== "") contato.name = name.slice(0, 200);
  const displayName = get("display_name");
  if (displayName !== "") contato.display_name = displayName.slice(0, 200);

  const email = get("email");
  if (email !== "") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { contato: {}, motivo: `e-mail inválido: "${email}"` };
    }
    contato.email = email;
  }

  const phoneRaw = get("phone_number");
  if (phoneRaw !== "") {
    const phone = normalizaTelefone(phoneRaw);
    if (phone === null) {
      return {
        contato: {},
        motivo: `telefone inválido: "${phoneRaw}" (use DDI+DDD+número, ex.: +5511999998888)`,
      };
    }
    contato.phone_number = phone;
  }

  if (contato.phone_number === undefined && contato.email === undefined) {
    return { contato: {}, motivo: "linha sem telefone nem e-mail" };
  }

  const cpf = get("cpf").replace(/\D/g, "");
  if (cpf !== "") contato.cpf = cpf;

  const birthdateRaw = get("birthdate");
  if (birthdateRaw !== "") {
    const birthdate = normalizaData(birthdateRaw);
    if (birthdate === null) {
      return {
        contato: {},
        motivo: `data de nascimento inválida: "${birthdateRaw}" (use AAAA-MM-DD ou DD/MM/AAAA)`,
      };
    }
    contato.birthdate = birthdate;
  }

  const tagsRaw = get("tags");
  if (tagsRaw !== "") {
    const tags = tagsRaw
      .split(/[;|]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (tags.length > 0) contato.tags = tags;
  }

  return { contato, motivo: null };
}

/**
 * O nome que o DESTINATÁRIO vê quando um documento entra por `media_url`
 * (#4524).
 *
 * O caminho de `media_url` mandava `media` sem `filename`. Sem nome, quem
 * escolhe um é o canal: ele grava o literal `file`, e no celular um PDF
 * chamado `file` parece arquivo suspeito — quem recebe hesita em abrir. O
 * `metadata.media_filename` que a API já aceitava e já gravava na linha nunca
 * chegava ao envio; era o único elo faltando.
 *
 * Precedência, nesta ordem, e é a ordem que o operador lê na issue:
 *
 * 1. `media_filename` — campo NOVO e OPCIONAL do `sendMessageSchema`;
 * 2. `metadata.media_filename` — o vocabulário que a ingestão já usa (#2613) e
 *    que o cartão do Inbox já lê: um segundo nome para a mesma coisa faria o
 *    envio e a tela discordarem;
 * 3. último segmento da `media_url`, QUANDO ele tem extensão (item 2 do pedido);
 * 4. nome de reserva legível, derivado do MIME — nunca `file`, nunca erro.
 *
 * Nada aqui renomeia o objeto no bucket: o armazenamento continua com a chave
 * que o upload gravou. O que muda é só o rótulo que viaja no payload do canal.
 *
 * O nome vem de fora (cliente da API, e o 3º caso vem de uma URL de terceiro),
 * então passa por guarda por VALOR: separador de caminho e `..` não atravessam,
 * caractere proibido por sistema de arquivos sai, a extensão sobrevive ao corte
 * de tamanho e vazio/só-barras/gigante caem na reserva em vez de virar erro.
 */
import {
  CHAVE_DO_NOME_NA_METADATA,
  INVISIVEIS_DO_NOME,
  NOME_DE_ARQUIVO_MAX,
} from "./nome-de-arquivo";

/**
 * O nome que o canal inventa quando nenhum é enviado. Deixá-lo passar seria
 * devolver o defeito da #4524 pela porta dos fundos — inclusive quando o
 * cliente o manda de propósito, repetindo o que leu no celular.
 */
const NOME_DO_CANAL = "file";

/** Extensão que o MIME sugere, para o nome de reserva. */
const EXTENSAO_POR_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "text/plain": "txt",
  "text/csv": "csv",
};

function tipoDoMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * O nome de reserva: legível e com a extensão que o MIME permite inferir. É o
 * que aparece quando não há nome nenhum aproveitável — nunca `file`, e nunca
 * uma exceção: nome é rótulo, e rótulo ausente não pode derrubar o envio.
 */
export function nomeDeReserva(mime?: string | null): string {
  const tipo = tipoDoMime(mime);
  const extensao = EXTENSAO_POR_MIME[tipo];
  const base = tipo.startsWith("image/")
    ? "imagem"
    : tipo.startsWith("video/")
      ? "video"
      : tipo.startsWith("audio/")
        ? "audio"
        : "documento";
  return extensao ? `${base}.${extensao}` : base;
}

/**
 * O último segmento de um caminho ou URL, sem query/fragmento e decodificado.
 *
 * É o que neutraliza travessia ANTES de qualquer outra limpeza: de
 * `../../etc/passwd.pdf` sobra `passwd.pdf`, porque o que viaja para o canal é
 * um nome, não um caminho.
 *
 * A decodificação vem ANTES do corte de propósito: `%2F` é barra, e cortar o
 * segmento antes de decodificar devolveria `../..%2Fetc%2Fpasswd.pdf` como se
 * fosse um único nome — a travessia passaria vestida de `%`.
 */
export function ultimoSegmentoDoCaminho(bruta: string): string | null {
  const semConsulta = bruta.split(/[?#]/, 1)[0] ?? "";
  // Esquema e host ficam de fora: `https://armazenamento.exemplo/` não tem
  // último segmento — sem isto o HOST viraria o nome do documento.
  const inicioDoCaminho = semConsulta.indexOf("/", semConsulta.indexOf("://") + 3);
  const caminho =
    semConsulta.includes("://") && inicioDoCaminho >= 0
      ? semConsulta.slice(inicioDoCaminho)
      : semConsulta;
  let decodificada = caminho;
  try {
    decodificada = decodeURIComponent(caminho);
  } catch {
    // `%` solto não é escape válido: o nome fica como veio em vez de virar 500.
    decodificada = caminho;
  }
  const partes = decodificada.split(/[\\/]+/).filter((parte) => parte.length > 0);
  return partes[partes.length - 1] ?? null;
}

/** Extensão "de verdade": ponto com 1–10 caracteres alfanuméricos no fim. */
export function temExtensao(nome: string): boolean {
  const ponto = nome.lastIndexOf(".");
  if (ponto <= 0) return false;
  return /^[A-Za-z0-9]{1,10}$/.test(nome.slice(ponto + 1));
}

/**
 * Corte no teto de tamanho SEM perder a extensão: um nome gigante vira um nome
 * curto com o mesmo `.pdf`, não um `.pd` truncado no meio.
 */
function cortarPreservandoExtensao(nome: string): string {
  const caracteres = Array.from(nome);
  if (caracteres.length <= NOME_DE_ARQUIVO_MAX) return nome;
  const corteSimples = () => caracteres.slice(0, NOME_DE_ARQUIVO_MAX).join("").trim();
  if (!temExtensao(nome)) return corteSimples();
  const ponto = nome.lastIndexOf(".");
  const extensao = nome.slice(ponto);
  const base = Array.from(nome.slice(0, ponto))
    .slice(0, NOME_DE_ARQUIVO_MAX - Array.from(extensao).length)
    .join("")
    .trim();
  return base ? `${base}${extensao}` : corteSimples();
}

/**
 * Nome seguro para o destinatário, ou `null` quando não sobra nome nenhum.
 *
 * `null` não é erro: é o sinal de "passe ao próximo candidato" — quem decide o
 * que fazer com a ausência é `nomeDoDocumentoParaEnvio`, que tem a reserva.
 *
 * A ordem importa e é esta: decodifica (`%2F` é barra e tem de virar barra
 * ANTES do corte, senão a travessia passa vestida de `%`) → tira o caractere
 * que sistema de arquivos recusa → corta o último segmento → só então mexe em
 * pontos e tamanho.
 */
export function nomeDeArquivoSeguro(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const semInvisiveis = bruto.replace(INVISIVEIS_DO_NOME, "").trim();
  if (!semInvisiveis) return null;

  let decodificado = semInvisiveis;
  try {
    decodificado = decodeURIComponent(semInvisiveis);
  } catch {
    // `%` solto não é escape válido: o nome fica como veio em vez de virar 500.
    decodificado = semInvisiveis;
  }

  const semProibidos = decodificado
    // Caractere que sistema de arquivos recusa (Windows/Android) ou que quebra
    // o cabeçalho do canal.
    .replace(/[<>:"|?*]/g, "")
    .trim();

  // Travessia e diretório: o nome é o ÚLTIMO segmento, sempre.
  const partes = semProibidos.split(/[\\/]+/).filter((parte) => parte.length > 0);
  const ultimo = partes[partes.length - 1];
  if (!ultimo) return null;

  const semTravessia = ultimo
    // Sobra de travessia que veio sem barra (`..nome`, `nome..pdf`).
    .replace(/\.{2,}/g, ".")
    // Ponto nas pontas: `..`/`.` não são nome, e nome oculto não é o que a
    // pessoa reconhece no celular.
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  if (!semTravessia) return null;

  const cortado = cortarPreservandoExtensao(semTravessia);
  return cortado ? cortado : null;
}

export interface NomeDoDocumentoParaEnvio {
  /** Campo novo do `sendMessageSchema` (`media_filename`). */
  nomeExplicito?: unknown;
  /** `metadata` da requisição — é dela que sai `media_filename` (#2613). */
  metadata?: unknown;
  /** A `media_url` do envio, quando houver. */
  url?: string | null;
  /** `media_mime`, para o nome de reserva ganhar extensão. */
  mime?: string | null;
}

/**
 * O nome que vai no payload do canal. Sempre devolve uma string legível: é
 * rótulo, e o envio do documento não pode depender de o cliente ter nomeado
 * bem o arquivo.
 */
export function nomeDoDocumentoParaEnvio(entrada: NomeDoDocumentoParaEnvio): string {
  const daMetadata =
    entrada.metadata && typeof entrada.metadata === "object" && !Array.isArray(entrada.metadata)
      ? (entrada.metadata as Record<string, unknown>)[CHAVE_DO_NOME_NA_METADATA]
      : undefined;

  for (const candidato of [entrada.nomeExplicito, daMetadata]) {
    const nome = nomeDeArquivoSeguro(candidato);
    if (nome && nome.toLowerCase() !== NOME_DO_CANAL) return nome;
  }

  // Último segmento da URL só serve quando tem extensão: `<hash>` sem ponto não
  // diz nada a quem recebe, e a reserva diz ("documento.pdf").
  const daUrl = entrada.url
    ? nomeDeArquivoSeguro(ultimoSegmentoDoCaminho(entrada.url) ?? "")
    : null;
  if (daUrl && temExtensao(daUrl) && daUrl.toLowerCase() !== NOME_DO_CANAL) return daUrl;

  return nomeDeReserva(entrada.mime);
}

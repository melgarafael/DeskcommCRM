/**
 * AS MÍDIAS DA RESPOSTA RÁPIDA — as regras que a rota de upload, a tela de
 * criação/edição e o compositor compartilham (issue #2526), e o ÁUDIO como mais
 * um TIPO ACEITO na mesma coluna (issue #2833).
 *
 * O banco guarda a DESCRIÇÃO (`storage_path` + mime + tamanho) em
 * `message_templates.midias` (migration 0643); os BYTES ficam no bucket
 * privado `whatsapp-media`, no prefixo `<org>/templates/<template>/`, gerado
 * pela rota — nunca aceito do cliente, como já faz `lib/catalogo/fotos.ts` para
 * as fotos do produto.
 *
 * ── O áudio é tipo de `midias`, não uma coluna nova (#2833) ─────────────────
 *
 * O primeiro desenho deste PR guardava o áudio do recurso em QUATRO colunas
 * próprias (`tipo`/`media_path`/`media_mime`/`media_size_bytes`), num bucket
 * novo (`recursos-media`) e numa rota de upload paralela (`/media`). Era um
 * segundo vocabulário de mídia ao lado do primeiro — e o preço apareceu na
 * cerca: um SITE NOVO de fronteira de Storage que ninguém tinha registrado
 * (`tests/unit/identificadores-que-cruzam-fronteira.test.ts`). O mantenedor
 * apontou o caminho: o áudio entra pelo MESMO caminho de `midias`, que já gera
 * e confere o caminho do arquivo.
 *
 * Quem diz que uma entrada é áudio é o CAMINHO (`mimeDaMidia`), nunca o
 * `media_mime` da linha: a coluna é gravável pelo PostgREST, e quem LÊ confere,
 * não só quem escreve.
 *
 * O caminho é da MESMA forma da foto do produto (uuid + extensão conhecida)
 * porque é a mesma garantia que interessa: a coluna é gravável pelo PostgREST e
 * a leitura do arquivo é por service role, sem RLS — sem a conferência, um
 * caminho de outra organização gravado na linha viraria mídia alheia na tela
 * ou, na remoção, arquivo alheio APAGADO pela rota.
 */
import { farejarTipo as farejarLogo, type TipoDeLogo } from "@/lib/branding/logo-arquivo";

/** Bucket privado compartilhado com o envio de mídia do atendimento. */
export const BUCKET_DAS_MIDIAS = "whatsapp-media";

/** O mesmo teto do CHECK da migration 0643 e do input do formulário. */
export const MAXIMO_DE_MIDIAS = 5;

/**
 * 5 MB: o teto da rota de upload e o de imagem do WhatsApp oficial. O bucket
 * `whatsapp-media` aceita até 50 MB; quem segura os 5 é a rota.
 */
export const TAMANHO_MAXIMO_DA_MIDIA = 5 * 1024 * 1024;

/**
 * 16 MB: o teto de ÁUDIO do WhatsApp oficial (a mesma fonte que fixa 5 MB para
 * imagem). O de imagem NÃO serve aqui, e não é por folga: uma nota de voz de
 * 2 minutos em Opus já passa de 5 MB dependendo do bitrate, e o áudio que este
 * produto envia é justamente o gravado/exportado pelo operador. O número é o do
 * TERCEIRO (quem recebe), não um gosto nosso — acima dele o envio falha no
 * provider, depois do arquivo já estar no bucket.
 */
export const TAMANHO_MAXIMO_DO_AUDIO = 16 * 1024 * 1024;

/** Os áudios aceitos — o que o WhatsApp oficial entrega e reproduz. */
export type TipoDeAudio = "audio/ogg" | "audio/mpeg" | "audio/aac" | "audio/amr" | "audio/wav";

/** Todo tipo aceito em `midias`: as imagens da #2526 e o áudio da #2833. */
export type TipoDeMidia = TipoDeLogo | TipoDeAudio;

/** O que a linha guarda — e o que o compositor precisa para baixar e enviar. */
export interface MidiaDeTemplate {
  storage_path: string;
  media_mime: string;
  media_size_bytes: number;
}

/** A extensão que cada tipo farejado grava no caminho. */
const EXTENSAO_DE: Record<TipoDeMidia, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
};

/** A volta: a extensão do caminho decide o mime de quem lê. */
const MIME_DA_EXTENSAO: Record<string, TipoDeMidia> = {
  png: "image/png",
  jpg: "image/jpeg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  amr: "audio/amr",
  wav: "audio/wav",
};

/** As extensões que a rota pode ter gravado — fechadas, como o farejador. */
const FORMA_DO_ARQUIVO = new RegExp(
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${Object.values(
    EXTENSAO_DE,
  ).join("|")})$`,
);

/**
 * Quantos bytes bastam para decidir. As assinaturas de áudio cabem em 12 (o
 * `RIFF`+`WAVE` do WAV precisa pular 4 bytes); 64 dá folga e mantém a leitura
 * barata.
 */
const BYTES_PARA_FAREJAR = 64;

/** `4F 67 67 53` — "OggS", o cabeçalho de todo Ogg (Vorbis e Opus). */
const OGG = [0x4f, 0x67, 0x67, 0x53] as const;
/** `23 21 41 4D 52` — "#!AMR", o AMR que o WhatsApp oficial usa para voz. */
const AMR = [0x23, 0x21, 0x41, 0x4d, 0x52] as const;
/** `52 49 46 46` — "RIFF"; só vira WAV com "WAVE" no byte 8. */
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WAVE = [0x57, 0x41, 0x56, 0x45] as const;
/** "ID3" — o cabeçalho de tag do MP3, o caso mais comum em arquivo exportado. */
const ID3 = [0x49, 0x44, 0x33] as const;

function comecaCom(bytes: Uint8Array, assinatura: readonly number[]): boolean {
  if (bytes.length < assinatura.length) return false;
  return assinatura.every((b, i) => bytes[i] === b);
}

/**
 * O tipo de ÁUDIO real do arquivo, pela assinatura. `null` = não é áudio
 * aceito.
 *
 * ── O que NÃO entra, e por quê ──────────────────────────────────────────────
 *
 * M4A/MP4 (`ftyp`) e WebM/Matroska (EBML) ficam de fora — não por preguiça, por
 * honestidade: as duas assinaturas são as MESMAS de vídeo. Um farejador que não
 * distingue áudio de vídeo não pode ser o farejador de uma rota que promete
 * aceitar áudio; ele aceitaria o MP4 do vídeo e gravá-lo-ia como áudio. Se um
 * dia o produto precisar desses contêineres, o lugar de decidir é a leitura da
 * caixa de marca (`ftyp`/DocType), não os 4 bytes de abertura.
 *
 * A ordem importa: MP3 (11 bits de sync + layer != 0) ANTES do ADTS do AAC
 * (sync de 12 bits + layer 0). Os dois se sobrepõem em `FF Fx` e é o campo
 * layer que os separa — por isso o teste do farejador cobre os dois.
 */
function farejarAudio(bytes: Uint8Array): TipoDeAudio | null {
  const janela = bytes.subarray(0, BYTES_PARA_FAREJAR);
  if (comecaCom(janela, OGG)) return "audio/ogg";
  if (comecaCom(janela, AMR)) return "audio/amr";
  if (comecaCom(janela, RIFF) && comecaCom(janela.subarray(8), WAVE)) return "audio/wav";
  if (comecaCom(janela, ID3)) return "audio/mpeg";
  if (janela.length >= 3) {
    const b0 = janela[0]!;
    const b1 = janela[1]!;
    const b2 = janela[2]!;
    // MPEG audio (ACM/IEEE): 11 bits de sync + layer != 0 + bitrate != 1111.
    if (b0 === 0xff && (b1 & 0xe0) === 0xe0 && ((b1 >> 1) & 0x03) !== 0 && (b2 & 0xf0) !== 0xf0) {
      return "audio/mpeg";
    }
    // AAC em ADTS: sync de 12 bits com layer 00 e bitrate != 1111.
    if (b0 === 0xff && (b1 & 0xf6) === 0xf0 && (b2 & 0xf0) !== 0xf0) return "audio/aac";
  }
  return null;
}

/**
 * O tipo REAL da mídia que a rota vai gravar — imagem (`farejarTipo` do logo)
 * ou áudio. `null` = não é nenhum dos aceitos.
 *
 * Não tenta adivinhar o que é quando não reconhece: a lista de aceitos é
 * fechada, então "não reconheci" e "reconheci algo que não aceito" levam ao
 * mesmo lugar e distingui-los só daria ao atacante um oráculo de formato.
 * NUNCA lê `file.type` nem a extensão do nome que o cliente mandou.
 */
export function farejarTipoDeMidia(bytes: Uint8Array): TipoDeMidia | null {
  return farejarLogo(bytes) ?? farejarAudio(bytes);
}

/** A extensão que a rota grava no caminho para cada tipo farejado. */
export function extensaoDaMidia(tipo: TipoDeMidia): string {
  return EXTENSAO_DE[tipo];
}

/** O teto de bytes que vale para o tipo já farejado. */
export function tetoDaMidia(tipo: TipoDeMidia): number {
  return tipo.startsWith("audio/") ? TAMANHO_MAXIMO_DO_AUDIO : TAMANHO_MAXIMO_DA_MIDIA;
}

/** O prefixo que a rota de upload gera para um template. */
export function prefixoDoTemplate(orgId: string, templateId: string): string {
  return `${orgId}/templates/${templateId}/`;
}

/**
 * O caminho é DESTE template e tem a forma exata que a rota gera?
 *
 * Vale para quem grava (PATCH) e para quem apaga (DELETE): sem isto, um
 * `storage_path` de outra org enviado no corpo apagaria arquivo alheio.
 */
export function midiaPertenceAoTemplate(
  caminho: string,
  orgId: string,
  templateId: string,
): boolean {
  const prefixo = prefixoDoTemplate(orgId, templateId);
  return caminho.startsWith(prefixo) && FORMA_DO_ARQUIVO.test(caminho.slice(prefixo.length));
}

/** O mime sai do CAMINHO, que a rota escolheu pelos bytes — não do declarado. */
export function mimeDaMidia(caminho: string): TipoDeMidia {
  const extensao = caminho.split(".").pop()?.toLowerCase() ?? "";
  return MIME_DA_EXTENSAO[extensao] ?? "image/jpeg";
}

/** É uma entrada de ÁUDIO do recurso (#2833)? Lido do caminho, nunca da linha. */
export function ehMidiaDeAudio(midia: { storage_path: string }): boolean {
  return mimeDaMidia(midia.storage_path).startsWith("audio/");
}

/**
 * A entrada de áudio de uma lista de mídias — a PRIMEIRA, na ordem gravada.
 *
 * Um recurso de áudio é um template cujo `midias` carrega o arquivo; a barra de
 * recursos pergunta aqui para escolher o ícone (🎧) do botão — o caminho de
 * escolha é o MESMO `applyTemplate` do `/`, que não precisa desta resposta.
 * `undefined` = recurso de texto (ou template antigo, sem mídia nenhuma).
 */
export function midiaDeAudioDe(
  midias: readonly { storage_path: string }[] | null | undefined,
): MidiaDeTemplate | undefined {
  return (midias ?? []).find(ehMidiaDeAudio) as MidiaDeTemplate | undefined;
}

/**
 * A lista nova que a tela mandou no PATCH: só mantém e remove, nunca acrescenta.
 *
 * Mídia nova entra pelo upload, que é quem confere os bytes. Aceitar um
 * caminho inédito aqui seria aceitar um arquivo que ninguém conferiu — ou de
 * outro template. Espelha `conferirNovaOrdem` das fotos do produto.
 *
 * `mantidas` são as entradas da LINHA (na ordem pedida), não as do corpo: o
 * mime e o tamanho foram gravados pelo upload, e o PATCH não os reescreve.
 */
export function conferirMidias(
  atual: readonly MidiaDeTemplate[],
  nova: readonly MidiaDeTemplate[],
): { ok: true; mantidas: MidiaDeTemplate[]; removidas: string[] } | { ok: false } {
  if (nova.length > MAXIMO_DE_MIDIAS) return { ok: false };
  const caminhos = nova.map((m) => m.storage_path);
  if (new Set(caminhos).size !== caminhos.length) return { ok: false };
  if (caminhos.some((c) => !atual.some((a) => a.storage_path === c))) return { ok: false };
  return {
    ok: true,
    mantidas: caminhos.flatMap((c) => atual.filter((a) => a.storage_path === c)),
    removidas: atual.filter((a) => !caminhos.includes(a.storage_path)).map((a) => a.storage_path),
  };
}

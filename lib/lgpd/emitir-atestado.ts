/**
 * A EMISSÃO do atestado: renderiza, assina e guarda — devolvendo os metadados.
 *
 * ─── Por que a orquestração mora aqui, e não no worker ──────────────────────
 *
 * O worker já tem o trabalho dele (a cascata) e o teste dele. Esta função é uma
 * fronteira de I/O com UMA responsabilidade — desenhar o papel, colocar no
 * Storage e dizer o que ficou lá —, então o worker chama uma vez e o teste
 * exercita o caminho sem subir um pedido inteiro.
 *
 * ─── O que NÃO é decisão deste arquivo ──────────────────────────────────────
 *
 * Conteúdo, mascaramento e código vêm de `atestado-de-anonimizacao.ts`; o
 * desenho, de `atestado-renderer.tsx`. Aqui não há texto jurídico.
 *
 * ─── O QUE ESTE ARQUIVO GRAVA (CR do PR #3321, item 1) ──────────────────────
 *
 * O PDF do Storage não carrega nome, documento nem contato do titular — nem
 * mascarados. O requerente entra pelo PROTOCOLO do pedido, e o que sobra no
 * arquivo é o controlador (razão social e CNPJ, dado público), o ato de execução
 * (quem, de onde, quando) e o código de autenticidade. O objeto é uma cópia
 * nova: reimprimir aqui a identidade que a cascata acabou de apagar criaria dado
 * reidentificável sem prazo e fora do alcance da exclusão. A chave do objeto
 * continua sendo só uuid do banco — nada de texto digitado.
 *
 * O `sha256` devolvido é do PDF ASSINADO (o que foi gravado), não do buffer
 * intermediário: quem confere o arquivo no Storage tem de achar o mesmo hash.
 */
import { codigoCurto, codigoDeAutenticidade, type AlgoritmoDoCodigo, type DadosDoAtestado } from "@/lib/lgpd/atestado-de-anonimizacao";
import { renderAtestadoPdf } from "@/lib/lgpd/atestado-renderer";
import { signPdfPades } from "@/lib/lgpd/pades-signer";

/** O mesmo bucket do relatório do art. 18, II — um lugar só para o que é do titular. */
export const BUCKET_DO_ATESTADO = "lgpd-exports";

/**
 * A chave é a MESMA do `pades-signer` (`LGPD_SIGNING_KEY`), lida do ambiente do
 * processo — não de configuração por organização: o código de autenticidade
 * prova a INSTALAÇÃO, e uma chave por tenant provaria menos.
 */
function chaveDeAssinatura(): string | null {
  return process.env.LGPD_SIGNING_KEY ?? null;
}

export interface AtestadoEmitido {
  /** Caminho no bucket — é por ele que a rota de download assina a URL. */
  path: string;
  /** Código completo (64 hex), para reconferência. */
  codigo: string;
  /** O recorte citável impresso no papel e lido ao telefone. */
  codigo_curto: string;
  algoritmo: AlgoritmoDoCodigo;
  /** SHA-256 do PDF GRAVADO (assinado). */
  sha256: string;
  /** PAdES de verdade? `false` = assinatura degradada, como no resto do produto. */
  pades: boolean;
  emitido_em: string;
  bytes: number;
}

/** O mínimo do cliente admin que a emissão usa (o teste passa um dublê). */
type ClienteComStorage = {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        corpo: Buffer,
        opcoes?: { contentType?: string; upsert?: boolean },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Emite o atestado de um pedido já executado.
 *
 * LANÇA quando o Storage recusa — o chamador decide o que fazer com a falha
 * (no worker: registrar e seguir, porque o pedido do titular não pode cair
 * porque o papel não saiu).
 */
export async function emitirAtestadoDeAnonimizacao(
  admin: ClienteComStorage,
  dados: DadosDoAtestado,
): Promise<AtestadoEmitido> {
  const { codigo, algoritmo } = codigoDeAutenticidade(dados, chaveDeAssinatura());
  const pdf = await renderAtestadoPdf({ dados, codigo: codigoCurto(codigo), algoritmo });
  const assinado = await signPdfPades(pdf);

  // A org vem PRIMEIRO no caminho, como no relatório do art. 18, II
  // (`{org}/{pedido}/report.pdf`): é o prefixo que a exclusão da organização
  // (`fn_arquivos_da_organizacao`, `name like org || '/%'`) e a policy de leitura
  // do bucket (`split_part(name, '/', 1)::uuid`) usam para achar o arquivo.
  const path = `${dados.organization_id}/${dados.request_id}/atestado.pdf`;
  const { error } = await admin.storage.from(BUCKET_DO_ATESTADO).upload(path, assinado.signed, {
    contentType: "application/pdf",
    // Regravar o mesmo caminho é o que torna a retomada do pedido idempotente
    // em vez de acumular `atestado(1).pdf` no bucket.
    upsert: true,
  });
  if (error) throw new Error(`atestado_upload_failed: ${error.message}`);

  return {
    path,
    codigo,
    codigo_curto: codigoCurto(codigo),
    algoritmo,
    sha256: assinado.sha256,
    pades: assinado.signed_pades,
    emitido_em: new Date().toISOString(),
    bytes: assinado.signed.length,
  };
}

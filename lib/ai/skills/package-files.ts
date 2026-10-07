/**
 * Herança dos arquivos do pacote quando o TEXTO da skill é salvo (#2047).
 *
 * O PUT `/api/v1/ai/skills/[name]` cria uma versão NOVA (imutabilidade —
 * CLAUDE.md regra dura), mas os objetos de `references/` e `assets/` moram no
 * Storage sob o id da VERSÃO (`${org}/${name}/${versionId}/${path}` —
 * skill-references.ts). Antes desta peça a saída era um 409: salvar qualquer
 * frase de uma skill de .zip exigia reconstruir o pacote inteiro, porque a
 * versão nova nasceria sem os arquivos e o agente perderia as references em
 * silêncio.
 *
 * A ordem é a mesma da importação (lib/ai/skills/install.ts) e não é acidental:
 *   1. o INSERT da versão nova (precisa do id para montar o prefixo);
 *   2. ESTA cópia — baixa do prefixo velho, sobe no novo;
 *   3. só então o ponteiro move (setSkillPointer).
 * Enquanto o passo 2 falha, nenhum ponteiro aponta para a versão nova: o
 * runtime continua vendo a versão antiga, íntegra. A versão recém-criada fica
 * órfã no banco (inofensiva, mesma doutrina do import) e os objetos já copiados
 * são removidos — nada de prefixo pela metade.
 *
 * Falha de LEITURA também aborta: uma versão que promete no manifesto um
 * arquivo que não existe é exatamente o silêncio que este save existe para
 * evitar. O erro carrega o caminho para o log; a resposta vira mensagem de
 * ensino na rota.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const SKILL_ASSETS_BUCKET = 'skill-assets';

interface EntradaDeManifesto {
  path: string;
}

/**
 * Paths de arquivo do manifesto. Só entradas com `path` string entram — o
 * filtro é o mesmo de `referenceEntries` (skill-references.ts), porque o
 * manifesto é jsonb vindo do .zip e quem o lê não pode assumir forma.
 */
export function caminhosDoManifesto(manifest: readonly unknown[]): string[] {
  return manifest
    .filter(
      (m): m is EntradaDeManifesto =>
        m !== null && typeof m === 'object' && typeof (m as EntradaDeManifesto).path === 'string',
    )
    .map((m) => m.path);
}

export async function copiarArquivosDoPacote(
  deps: { admin: SupabaseClient },
  input: {
    organizationId: string;
    name: string;
    deVersionId: string;
    paraVersionId: string;
    manifest: readonly unknown[];
  },
): Promise<void> {
  const caminhos = caminhosDoManifesto(input.manifest);
  if (caminhos.length === 0) return;

  const bucket = deps.admin.storage.from(SKILL_ASSETS_BUCKET);
  const copiados: string[] = [];

  for (const caminho of caminhos) {
    const origem = `${input.organizationId}/${input.name}/${input.deVersionId}/${caminho}`;
    const destino = `${input.organizationId}/${input.name}/${input.paraVersionId}/${caminho}`;

    const { data, error } = await bucket.download(origem);
    if (error !== null || data === null) {
      await removerJaCopiados(bucket, copiados);
      throw new Error(`não foi possível ler o arquivo '${caminho}' da versão anterior do pacote (${origem})`);
    }
    // arrayBuffer, e não text(): asset é binário (png/pdf) e texto destruiria
    // o arquivo na ida e na volta.
    const { error: uploadErr } = await bucket.upload(destino, Buffer.from(await data.arrayBuffer()), {
      upsert: false,
    });
    if (uploadErr !== null) {
      await removerJaCopiados(bucket, copiados);
      throw new Error(
        `não foi possível copiar o arquivo '${caminho}' para a versão nova do pacote (${destino}): ${uploadErr.message}`,
      );
    }
    copiados.push(destino);
  }
}

/**
 * Limpeza de melhor esforço: se ela falhar, o lixo fica no prefixo de uma
 * versão que NENHUM ponteiro aponta — nunca no caminho de quem joga.
 */
async function removerJaCopiados(
  bucket: ReturnType<SupabaseClient['storage']['from']>,
  copiados: readonly string[],
): Promise<void> {
  if (copiados.length === 0) return;
  await bucket.remove([...copiados]).catch(() => undefined);
}

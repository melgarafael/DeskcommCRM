/**
 * O MATERIAL DA EMPRESA VAI JUNTO — e só quando pode (#4129).
 *
 * O agente fala por UMA ferramenta, `send_message`. Ela já levava a foto do
 * produto (`produto_codigo`, #1130); agora leva também `material_id`, simétrico:
 * o material cadastrado da empresa (catálogo em PDF, tabela de preços) entra no
 * MESMO caminho de mídia do handler de mensagens — nada de um segundo caminho
 * de envio.
 *
 * Este módulo é o PREPARO, com o contrato de `prepararFotosDoProduto`:
 *
 *   - acha o material ATIVO e da lista DESTE agente (mesma organização);
 *   - confere o tipo pela régua única (`classificarMidiaComLegenda`) e o canal;
 *   - aplica os freios de reenvio (pedido do cliente, 7 dias, 3 em 24 h);
 *   - copia para `whatsapp-media/<org>/<conversa>/material-<arquivo>`, nome
 *     determinístico (replay não duplica arquivo);
 *   - devolve o anexo pronto ou um erro de ENSINO para o modelo.
 *
 * ═══ Por que o `describe()` é o único lugar onde o modelo aprende ═══
 *
 * O modelo não vê a tabela. Ele vê a descrição da ferramenta e o texto que ela
 * recebe. `descreverMateriais` monta ESSE texto, e só com o que a lista filtrada
 * deixou passar: material inativo, de outro agente ou incompatível com o canal
 * nunca aparece — e portanto nunca é escolhido. A lista não é cosmética: sem
 * ela o modelo teria de adivinhar um UUID, que é o mesmo que não ter a
 * capacidade.
 */
import type { Queryable } from '../queue/queue';
import {
  destinoDoMaterialNoConversa,
  materialCompativelComCanal,
  materialPertenceAOrganizacao,
  motivoIncompativelComCanal,
  tamanhoLegivel,
  TAMANHO_MAXIMO_DO_MATERIAL,
  tipoDeMaterial,
  type TipoDeMaterial,
} from '@/lib/materiais/materiais';
import type { CopiarMaterial } from '@/lib/materiais/copiar-no-storage';
import { instanteDoBanco } from '@/lib/tempo/agora';

/** Quantos materiais a descrição da ferramenta lista. Acima disso, o prompt paga. */
export const MAXIMO_DE_MATERIAIS_NA_DESCRICAO = 20;

/** Teto do texto de `quando_enviar` na descrição: frase, não parágrafo. */
const MAXIMO_DO_QUANDO_ENVIAR = 140;

/** Material que pode ser OFERECIDO ao modelo nesta conversa. */
export interface MaterialOferecivel {
  id: string;
  nome: string;
  /** A frase da empresa: quando este material deve ser enviado. */
  quandoEnviar: string;
  mime: string;
  type: TipoDeMaterial;
}

/** O anexo como o caminho de envio o consome (`SendMessageInput.media`). */
export interface AnexoDeMaterial {
  /** caminho em `whatsapp-media`, já na pasta da conversa */
  storagePath: string;
  mime: string;
  type: TipoDeMaterial;
}

export type MaterialPreparado =
  | {
      ok: true;
      anexo: AnexoDeMaterial;
      material: { id: string; nome: string };
      /** Legenda que a empresa deixou pronta — o modelo pode usá-la como `body`. */
      legenda: string;
    }
  | { ok: false; code: string; message: string };

interface LinhaDoMaterial {
  id: string;
  nome: string;
  legenda: string | null;
  mime: string;
  storage_path: string;
  tamanho: string | number;
  ativo: boolean;
}

/**
 * Os materiais que ESTE agente pode enviar NESTA conversa.
 *
 * Só ativos, só os da lista do agente, só os compatíveis com o canal — a mesma
 * tripla de filtros que `prepararMaterialDaEmpresa` aplica na hora do envio.
 * Aqui ela existe para o modelo não VER o que não pode escolher; lá, para o
 * envio não passar se a lista mudou no meio do turno.
 */
export async function listarMateriaisDoAgente(
  db: Queryable,
  input: { tenantId: string; agentId: string; canal?: string | null },
): Promise<MaterialOferecivel[]> {
  const { rows } = await db.query<{
    id: string;
    nome: string;
    quando_enviar: string | null;
    mime: string;
    storage_path: string;
    ativo: boolean;
  }>(
    `select m.id, m.nome, m.quando_enviar, m.mime, m.storage_path, m.ativo
       from crm_materiais m
       join crm_materiais_do_agente x
         on x.material_id = m.id and x.organization_id = m.organization_id
      where m.organization_id = $1 and x.agent_id = $2 and m.ativo
      order by m.nome`,
    [input.tenantId, input.agentId],
  );

  const ofereciveis: MaterialOferecivel[] = [];
  for (const linha of rows) {
    // O `where` já filtra; repetir aqui é de propósito — a lista é o que o
    // modelo LÊ, e uma linha inativa que escapasse da query viraria oferta.
    if (!linha.ativo) continue;
    // Caminho que não é desta organização nunca é oferecido: a cópia é service
    // role e não teria RLS para barrar o arquivo alheio.
    if (!materialPertenceAOrganizacao(linha.storage_path, input.tenantId)) continue;
    const tipo = tipoDeMaterial(linha.storage_path, linha.mime);
    if (!tipo.ok) continue;
    if (!materialCompativelComCanal(tipo.type, tipo.mime, input.canal)) continue;
    ofereciveis.push({
      id: linha.id,
      nome: linha.nome,
      quandoEnviar: (linha.quando_enviar ?? '').trim(),
      mime: tipo.mime,
      type: tipo.type,
    });
  }
  return ofereciveis.slice(0, MAXIMO_DE_MATERIAIS_NA_DESCRICAO);
}

/** Uma linha só, sem quebra nem excesso: o texto entra na descrição da tool. */
function emLinha(texto: string, limite: number): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

/**
 * O bloco que a descrição de `send_message` ganha no turno.
 *
 * É o ÚNICO lugar em que o modelo descobre o id, o "quando enviar" e o fato de
 * o material sair como DOCUMENTO com o `body` de legenda. Lista vazia também é
 * informação: diz para NÃO usar `material_id`, em vez de deixar o modelo
 * inventar um id.
 */
export function descreverMateriais(materiais: readonly MaterialOferecivel[]): string {
  if (materiais.length === 0) {
    return (
      '\n\nMateriais da empresa disponíveis para envio nesta conversa: NENHUM. ' +
      'Não use `material_id` — não há material cadastrado para este agente neste canal.'
    );
  }
  const linhas = materiais.map((m) => {
    const nome = emLinha(m.nome, 80);
    const quando = emLinha(m.quandoEnviar, MAXIMO_DO_QUANDO_ENVIAR);
    return quando === '' ? `- ${m.id} — ${nome}` : `- ${m.id} — ${nome} — quando enviar: ${quando}`;
  });
  return (
    '\n\nMateriais da empresa que você PODE enviar nesta conversa ' +
    '(use o id em `material_id`; o material vai como DOCUMENTO e o texto de `body` vira a legenda dele):\n' +
    linhas.join('\n')
  );
}

/**
 * O canal desta conversa (`conversations.channel`), ou `null` quando não há
 * conversa (o Testar de agente roda sem contato).
 *
 * `null` vale como WhatsApp na régua do canal: é o canal de quem não declarou
 * outro, e é o único que existe quando não há conversa nenhuma.
 */
export async function canalDaConversa(
  db: Queryable,
  input: { tenantId: string; conversationId: string },
): Promise<string | null> {
  if (input.conversationId === '') return null;
  const { rows } = await db.query<{ channel: string | null }>(
    'select channel from conversations where id = $1 and organization_id = $2',
    [input.conversationId, input.tenantId],
  );
  return rows[0]?.channel ?? null;
}

/** Quantas vezes o mesmo material já saiu nesta conversa, e quando foi a última. */
export async function historicoDoMaterial(
  db: Queryable,
  input: { tenantId: string; conversationId: string; materialId: string },
): Promise<{ nasUltimas24h: number; ultimo: Date | null }> {
  const { rows } = await db.query<{ nas_ultimas_24h: string | number; ultimo: Date | string | null }>(
    `select count(*) filter (
              where coalesce(sent_at, created_at) >= now() - interval '24 hours'
            ) as nas_ultimas_24h,
            max(coalesce(sent_at, created_at)) as ultimo
       from messages
      where organization_id = $1
        and conversation_id = $2
        and direction = 'outbound'
        and coalesce(metadata->>'material_id', '') = $3
        and coalesce(sent_at, created_at) >= now() - interval '7 days'`,
    [input.tenantId, input.conversationId, input.materialId],
  );
  const linha = rows[0];
  // Duas formas na entrada (`Date` do driver `pg`, string do PostgREST), uma na
  // saída: quem normaliza a fronteira é `instanteDoBanco`, a borda canônica —
  // não uma segunda ramificação local por `instanceof Date`.
  const ultimoIso = instanteDoBanco(linha?.ultimo ?? null);
  return {
    nasUltimas24h: Number(linha?.nas_ultimas_24h ?? 0),
    ultimo: ultimoIso === null ? null : new Date(ultimoIso),
  };
}

/**
 * Acha o material, aplica os freios e deixa o arquivo pronto na pasta da conversa.
 *
 * Todo desfecho que não seja `ok` é erro de ENSINO: o modelo corrige (ou
 * responde sem o material) e tenta de novo. Nada é enviado por este módulo.
 */
export async function prepararMaterialDaEmpresa(
  db: Queryable,
  copiar: CopiarMaterial,
  input: {
    tenantId: string;
    /**
     * O agente que envia — e a lista dele é o freio. `null` só para a chamada
     * por TOKEN/MCP (`crm_send_material`), que é da ORGANIZAÇÃO: não há agente
     * no caminho, e a lista dele não teria a quem se aplicar.
     */
    agentId: string | null;
    conversationId: string;
    materialId: string;
    canal?: string | null;
    /** `true` só quando o cliente pediu o material nesta conversa. */
    clientePediu?: boolean;
  },
): Promise<MaterialPreparado> {
  const { rows } = await db.query<LinhaDoMaterial>(
    `select m.id, m.nome, m.legenda, m.mime, m.storage_path, m.tamanho, m.ativo
       from crm_materiais m
      where m.id = $1 and m.organization_id = $2 and m.ativo
        and (
          $3::uuid is null
          or exists (
            select 1 from crm_materiais_do_agente x
             where x.material_id = m.id
               and x.organization_id = m.organization_id
               and x.agent_id = $3
          )
        )`,
    [input.materialId, input.tenantId, input.agentId],
  );
  const material = rows[0];
  if (!material) {
    return {
      ok: false,
      code: 'material_nao_encontrado',
      message:
        `não há material ATIVO com o id ${JSON.stringify(input.materialId)} na lista deste agente. ` +
        'Use um dos ids que a descrição desta ferramenta lista — material de outro agente, inativo ' +
        'ou inexistente não é enviado. Se não houver lista, responda sem material.',
    };
  }

  // Defesa em profundidade: a linha é gravável pelo PostgREST e a cópia é por
  // service role. Caminho de outra organização nunca é copiado nem assinado.
  if (!materialPertenceAOrganizacao(material.storage_path, input.tenantId)) {
    return {
      ok: false,
      code: 'material_fora_da_organizacao',
      message:
        'o arquivo deste material não está na pasta desta empresa — ele não é enviado. ' +
        'Avise a equipe; nenhum texto deve prometer o material.',
    };
  }

  const tipo = tipoDeMaterial(material.storage_path, material.mime);
  if (!tipo.ok) {
    return { ok: false, code: 'material_tipo_recusado', message: tipo.motivo };
  }
  if (!materialCompativelComCanal(tipo.type, tipo.mime, input.canal)) {
    return {
      ok: false,
      code: 'material_incompativel_com_canal',
      message: motivoIncompativelComCanal(String(input.canal)),
    };
  }

  const tamanho = Number(material.tamanho);
  if (!Number.isFinite(tamanho) || tamanho <= 0) {
    return {
      ok: false,
      code: 'material_tamanho_invalido',
      message:
        'o arquivo deste material está vazio ou sem tamanho registrado — ele não é enviado. ' +
        'Avise a equipe; responda sem prometer o material.',
    };
  }
  if (tamanho > TAMANHO_MAXIMO_DO_MATERIAL) {
    return {
      ok: false,
      code: 'material_grande_demais',
      message:
        `o arquivo deste material tem ${tamanhoLegivel(tamanho)}, acima do limite de ` +
        `${tamanhoLegivel(TAMANHO_MAXIMO_DO_MATERIAL)} — ele não é enviado. ` +
        'Avise a equipe; responda sem prometer o material.',
    };
  }

  // ── Freios de reenvio ────────────────────────────────────────────────────
  //
  // 3 envios do MESMO material por conversa em 24 h é o teto contra laço (o
  // modelo insistindo na mesma ferramenta). Pedido do cliente reenvia; por
  // iniciativa da IA, o mesmo material não sai duas vezes em 7 dias. O replay do
  // job cai no mesmo registro (a linha da mensagem já gravou `material_id` no
  // metadata) e no nome determinístico do arquivo.
  const historico = await historicoDoMaterial(db, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    materialId: material.id,
  });
  if (historico.nasUltimas24h >= 3) {
    return {
      ok: false,
      code: 'material_limite_do_dia',
      message:
        `o material ${JSON.stringify(material.nome)} já foi enviado ${historico.nasUltimas24h} vezes ` +
        'nesta conversa nas últimas 24 horas — o limite é 3. NÃO envie de novo; ' +
        'se o cliente pedir outra vez, responda em texto e diga que o arquivo já está acima na conversa.',
    };
  }
  if (historico.ultimo !== null && input.clientePediu !== true) {
    return {
      ok: false,
      code: 'material_ja_enviado',
      message:
        `o material ${JSON.stringify(material.nome)} já foi enviado nesta conversa nos últimos 7 dias ` +
        'e o cliente NÃO pediu de novo — ele NÃO foi reenviado. Não prometa outro envio; ' +
        'se o cliente pedir explicitamente, chame de novo com `cliente_pediu: true`.',
    };
  }

  // ── A cópia ──────────────────────────────────────────────────────────────
  //
  // Nome determinístico: reenviar o mesmo material, ou replay de um job que caiu
  // depois da cópia, reaproveita o arquivo. Se a cópia falhar, o envio NÃO
  // degrada para texto: mandar "segue o catálogo" sem o catálogo é pior que não
  // mandar.
  const destino = destinoDoMaterialNoConversa(
    input.tenantId,
    input.conversationId,
    material.storage_path,
  );
  if (!(await copiar(material.storage_path, destino))) {
    return {
      ok: false,
      code: 'material_nao_copiado',
      message:
        'não consegui preparar o arquivo deste material agora — ele NÃO foi enviado. ' +
        'Responda sem prometer o envio do arquivo e diga que a equipe envia em seguida.',
    };
  }

  return {
    ok: true,
    anexo: { storagePath: destino, mime: tipo.mime, type: tipo.type },
    material: { id: material.id, nome: material.nome },
    legenda: (material.legenda ?? '').trim(),
  };
}

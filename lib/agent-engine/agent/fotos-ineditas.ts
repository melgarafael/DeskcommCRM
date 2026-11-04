/** Opt-in de fotos progressivas; a identidade do envio continua sendo (job, seq).
 * Planos pequenos moram no payload do job existente, não em uma memória global.
 * Mensagens e recibos são a fonte de entrega; plano não é prova de envio.
 */
import { createHash } from "node:crypto";
import type { JobClaim } from "../queue/claim";
import type { Queryable } from "../queue/queue";
import { fotoPertenceAoProduto, mimeDaFoto } from "@/lib/catalogo/fotos";
import { LIMITE_DA_LEGENDA, type CopiarFoto, type FotoParaEnvio } from "./fotos-do-produto";

export class FotosIneditasError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface PedidoDeFotosIneditas {
  tenantId: string;
  conversationId: string;
  codigo: string;
  jobId: string;
  seq: number;
  jobClaim?: JobClaim;
  quantidade?: number;
  restantes: number;
  body: string;
  textoAposFotos?: boolean;
}
interface Plano {
  produtoId: string;
  codigo: string;
  conversationId: string;
  origens: string[];
  textoAposFotos?: boolean;
  bodyHash?: string;
}
// Estes códigos são gravados antes de chamar o adapter; failed do canal é ambíguo.
const FALHAS_ANTES_DO_CANAL = [
  "storage_sign_failed",
  "missing_phone_number",
  "channel_archived",
  "channel_disabled",
  "pre_go_live",
  "pre_go_live_indisponivel",
];
export function falhaDeFotoPermiteNovaTentativa(codigo: string | null): boolean {
  return codigo !== null && FALHAS_ANTES_DO_CANAL.includes(codigo);
}
const destinoDaFoto = (
  origem: string,
  p: Pick<PedidoDeFotosIneditas, "tenantId" | "conversationId">,
) => `${p.tenantId}/${p.conversationId}/catalogo-${origem.split("/").pop()}`;

/** Uma legenda curta mantém cada posição do plano igual à seq do ledger. */
export function validarLegendaDeFotos(body: string): void {
  if (body.length > LIMITE_DA_LEGENDA)
    throw new FotosIneditasError(
      "legenda_foto_longa",
      "Use uma legenda curta para as fotos (até 1024 caracteres). Se precisar, envie os detalhes em outra mensagem. Nenhuma foto foi enviada.",
    );
}

/** Gate de rollout por organização, fechado por padrão e sem herança global. */
export async function fotosProgressivasHabilitadas(
  db: Queryable,
  tenantId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ habilitado: boolean }>(
    `select coalesce(settings #> '{catalogo,fotos_progressivas}' = 'true'::jsonb, false) as habilitado
       from organizations where id=$1`,
    [tenantId],
  );
  return rows[0]?.habilitado === true;
}

export async function prepararFotosIneditas(
  db: Queryable,
  copiar: CopiarFoto,
  p: PedidoDeFotosIneditas,
): Promise<{ fotos: FotoParaEnvio[]; tinha: number }> {
  if (!(await fotosProgressivasHabilitadas(db, p.tenantId))) {
    throw new FotosIneditasError(
      "fotos_progressivas_desativadas",
      "Fotos progressivas não estão habilitadas nesta organização. Não use o modo ineditas; preserve a apresentação configurada e ofereça o link real se precisar.",
    );
  }
  validarLegendaDeFotos(p.body);
  if (
    !Number.isInteger(p.seq) ||
    p.seq < 1 ||
    !Number.isInteger(p.quantidade ?? 1) ||
    (p.quantidade ?? 1) < 1 ||
    (p.quantidade ?? 1) > 3
  ) {
    throw new FotosIneditasError(
      "pedido_fotos_invalido",
      "Peça de 1 a 3 fotos inéditas com um produto consultado.",
    );
  }
  const limite = Math.min(p.quantidade ?? 1, Math.max(0, Math.floor(p.restantes)));
  if (!limite)
    throw new FotosIneditasError(
      "max_sends_per_turn",
      "O teto de mensagens deste turno já foi usado. Não envie fotos agora.",
    );
  const { rows: produtos } = await db.query<{ id: string; fotos: string[] | null }>(
    "select id, fotos from catalog_products where organization_id=$1 and codigo=$2 and ativo",
    [p.tenantId, p.codigo.trim()],
  );
  const produto = produtos[0];
  if (!produto)
    throw new FotosIneditasError(
      "produto_nao_encontrado",
      "Use o codigo de um produto ativo devolvido por crm_search_products. Nenhuma foto foi enviada.",
    );
  const { rows: jobs } = await db.query<{ plano: Plano | null }>(
    `select payload->'fotos_ineditas'->$3::text as plano from job_queue where organization_id=$1 and id=$2`,
    [p.tenantId, p.jobId, String(p.seq)],
  );
  if (!jobs[0]) throw new Error("fotos_ineditas_job_missing");
  let plano = jobs[0].plano;
  if (!plano) {
    // Inclui humanos e envios legados. Resultado sending/requested é ambíguo,
    // logo não libera a foto. Somente falha definitiva libera uma nova tentativa.
    const { rows: usadas } = await db.query<{ media_storage_path: string }>(
      `select m.media_storage_path from messages m
       left join send_ledger l on l.organization_id=$1 and l.organization_id=m.organization_id
         and (l.crm_message_id=m.id or l.id::text=m.metadata->>'idempotency_key')
       where m.organization_id=$1 and m.conversation_id=$2 and m.direction='outbound'
         and m.media_storage_path = any($5::text[])
         and (m.status <> 'failed'
           or coalesce(m.error_code,'') <> all($7::text[])
           or l.status in ('requested','accepted','queued'))
         and (l.job_id is distinct from $3::uuid or l.seq < $4)
       union
       select $1::text || '/' || $2::text || '/catalogo-' || regexp_replace(o.origem, '^.*/', '')
       from job_queue j
       cross join lateral jsonb_each(coalesce(j.payload->'fotos_ineditas', '{}'::jsonb)) plan(k,v)
       cross join lateral jsonb_array_elements_text(plan.v->'origens') with ordinality o(origem, pos)
       left join send_ledger l on l.organization_id=$1 and l.organization_id=j.organization_id
         and l.job_id=j.id and l.seq=plan.k::int+o.pos::int-1
       where j.organization_id=$1
         and j.contact_id=(select contact_id from job_queue where organization_id=$1 and id=$3)
         and plan.v->>'conversationId'=$2::text and plan.v->>'produtoId'=$6::text
         and (j.id <> $3::uuid or plan.k::int+o.pos::int-1 < $4)
         and (l.status in ('requested','accepted','queued')
           or (l.status='failed' and not exists(select 1 from messages fm
             where fm.organization_id=$1 and fm.conversation_id=$2
               and fm.id=l.crm_message_id and fm.status='failed' and fm.error_code=any($7::text[])))
           or (l.id is null and j.status in ('pending','running')))`,
      [
        p.tenantId,
        p.conversationId,
        p.jobId,
        p.seq,
        (produto.fotos ?? [])
          .filter((f) => fotoPertenceAoProduto(f, p.tenantId, produto.id))
          .map((f) => destinoDaFoto(f, p)),
        produto.id,
        FALHAS_ANTES_DO_CANAL,
      ],
    );
    const excluidas = new Set(usadas.map((r) => r.media_storage_path));
    const origens = [...new Set(produto.fotos ?? [])]
      .filter(
        (f) =>
          fotoPertenceAoProduto(f, p.tenantId, produto.id) && !excluidas.has(destinoDaFoto(f, p)),
      )
      .slice(0, limite);
    if (!origens.length)
      throw new FotosIneditasError(
        "fotos_ineditas_esgotadas",
        "Não há outra foto inédita disponível para esta conversa. Não repita a capa nem diga que enviou fotos. Consulte e ofereça o link real do produto, se disponível.",
      );
    const novo: Plano = {
      produtoId: produto.id,
      codigo: p.codigo.trim(),
      conversationId: p.conversationId,
      origens,
      textoAposFotos: p.textoAposFotos === true,
      ...(p.textoAposFotos ? { bodyHash: createHash("sha256").update(p.body).digest("hex") } : {}),
    };
    // CAS da chave, não overwrite do payload. Atualização com lease quando o
    // worker o fornece; uma aquisição perdida nunca grava um plano novo.
    const { rows } = await db.query<{ plano: Plano }>(
      `update job_queue set payload=jsonb_set(payload, '{fotos_ineditas}',
        coalesce(payload->'fotos_ineditas','{}'::jsonb) || jsonb_build_object($3::text,
          coalesce(payload->'fotos_ineditas'->$3::text,$4::jsonb)))
       where organization_id=$1 and id=$2
         and ($5::text is null or (status='running' and locked_by=$5 and locked_at=$6::timestamptz))
       returning payload->'fotos_ineditas'->$3::text as plano`,
      [
        p.tenantId,
        p.jobId,
        String(p.seq),
        JSON.stringify(novo),
        p.jobClaim?.worker_id ?? null,
        p.jobClaim?.acquired_at ?? null,
      ],
    );
    plano = rows[0]?.plano ?? null;
    if (!plano) throw new Error("fotos_ineditas_job_claim_lost");
  }
  if (
    (plano.textoAposFotos === true) !== (p.textoAposFotos === true) ||
    (plano.textoAposFotos === true &&
      (plano.bodyHash !== createHash("sha256").update(p.body).digest("hex") ||
        plano.origens.length > limite)) ||
    plano.produtoId !== produto.id ||
    plano.codigo !== p.codigo.trim() ||
    plano.conversationId !== p.conversationId ||
    !Array.isArray(plano.origens) ||
    plano.origens.some((f) => !fotoPertenceAoProduto(f, p.tenantId, produto.id))
  ) {
    throw new FotosIneditasError(
      "fotos_intencao_conflitante",
      "Esta posição do turno já tem outro plano de fotos. Encerre o turno; não substitua nem reenvie a intenção anterior.",
    );
  }
  // O handler usa *_error inclusive para timeout. Não rotacione nem tente de
  // novo um recibo cujo failed não prova que o canal sequer foi chamado.
  const { rows: ambiguas } = await db.query<{ id: string; error_code: string | null }>(
    `select m.id, m.error_code from messages m join send_ledger l
       on l.organization_id=$1 and l.organization_id=m.organization_id
       and (l.crm_message_id=m.id or l.id::text=m.metadata->>'idempotency_key')
     where m.organization_id=$1 and m.conversation_id=$2 and l.job_id=$3
       and l.seq >= $4 and l.seq < $4 + $5 and m.status='failed'
       and coalesce(m.error_code,'') <> all($6::text[]) limit 1`,
    [p.tenantId, p.conversationId, p.jobId, p.seq, plano.origens.length, FALHAS_ANTES_DO_CANAL],
  );
  if (ambiguas.some((m) => !falhaDeFotoPermiteNovaTentativa(m.error_code)))
    throw new FotosIneditasError(
      "foto_envio_ambiguo",
      "O resultado do envio anterior é incerto. Não reenvie esta foto nem diga que ela foi entregue; encerre este turno e peça verificação humana pelo atendimento existente.",
    );
  // Nunca compactar um plano por falha de cópia: trocar a foto da seq1 pela seq2
  // faria o ledger reconciliar a foto errada. Falha para antes de qualquer envio.
  const selecionadas = plano.origens.slice(0, limite);
  const fotos: FotoParaEnvio[] = [];
  for (const origem of selecionadas) {
    const destino = destinoDaFoto(origem, p);
    if (!(await copiar(origem, destino)))
      throw new FotosIneditasError(
        "foto_copia_falhou",
        "A foto não pôde ser preparada. Nenhuma foto deste pedido foi enviada. Não prometa o envio; ofereça o link real consultado ou tente novamente mais tarde.",
      );
    fotos.push({ storagePath: destino, mime: mimeDaFoto(origem) });
  }
  return { fotos, tinha: fotos.length };
}

/** Congela corpo pós-guards e política de bolhas antes do primeiro envio.
 * Hash apenas: não persiste texto privado; mudança no replay exige novo turno. */
export async function congelarTextoFinalDasFotos(
  db: Queryable,
  p: {
    tenantId: string;
    jobId: string;
    seq: number;
    jobClaim: JobClaim;
    body: string;
    split: boolean;
    maxChars: number;
  },
): Promise<void> {
  const hash = createHash("sha256")
    .update(JSON.stringify({ body: p.body, split: p.split, maxChars: p.maxChars }))
    .digest("hex");
  const { rows } = await db.query(
    `update job_queue set payload=jsonb_set(payload,ARRAY['fotos_ineditas',$3::text,'finalBodyHash'],to_jsonb($4::text),true)
    where organization_id=$1 and id=$2 and status='running' and locked_by=$5 and locked_at=$6::timestamptz
    and payload->'fotos_ineditas'->$3::text->>'textoAposFotos'='true'
    and (payload->'fotos_ineditas'->$3::text->>'finalBodyHash' is null or payload->'fotos_ineditas'->$3::text->>'finalBodyHash'=$4)
    returning id`,
    [p.tenantId, p.jobId, String(p.seq), hash, p.jobClaim.worker_id, p.jobClaim.acquired_at],
  );
  if (!rows.length)
    throw new FotosIneditasError(
      "fotos_texto_final_conflitante",
      "O texto ou as regras deste envio mudaram, ou a aquisição expirou. Nenhuma nova mensagem foi enviada; aguarde novo turno.",
    );
}

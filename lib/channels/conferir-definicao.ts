/**
 * O PRÉ-VOO DA DEFINIÇÃO APROVADA, PARA QUALQUER CANAL.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O caminho da plataforma direta confere a definição ANTES de gastar: se ela
 * não está no espelho, não está aprovada ou faltam valores, ele recusa com uma
 * frase que diz o que fazer. O caminho do canal intermediado postava direto —
 * zero consultas a `meta_templates`.
 *
 * O que se perde sem isto:
 *
 *   - mudou a quantidade de parâmetros → você lê `400` cru em vez de
 *     "falta o valor {{2}}";
 *   - a definição foi reprovada ou pausada → a tentativa sai, é recusada, e o
 *     motivo chega em código de erro do provedor;
 *   - mudou só o TEXTO → o pior dos três: a plataforma entrega o texto novo e o
 *     CRM grava o antigo. O inbox e o cliente passam a ver mensagens
 *     diferentes, e nada no sistema acusa a divergência.
 *
 * ─── Por que aqui, e não dentro de cada adapter ─────────────────────────────
 *
 * Porque a definição aprovada não é característica de transporte: é o mesmo
 * contrato da plataforma, com o mesmo espelho local, para os dois canais que a
 * exigem. Duplicá-la por adapter faria a segunda cópia divergir na primeira vez
 * que alguém tratasse um estado novo.
 *
 * ─── O que este pré-voo NÃO garante ─────────────────────────────────────────
 *
 * Obsolescência. O `contract_hash` sai do espelho dos DOIS lados da comparação,
 * então `bindingState` só consegue checar existência e aprovação — nunca "mudou
 * desde que você configurou". Detectar isso de verdade exige guardar o hash no
 * momento da configuração, que é outra peça. Está escrito aqui para ninguém ler
 * este arquivo e concluir que a terceira falha da lista acima está coberta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { linhaDoEspelho } from "./linha-do-espelho";
import { missingSlots } from "./meta/build-components";
import { bindingState } from "./meta/template-binding";
import { deriveTemplateContract } from "./meta/template-contract";

export interface PedidoDeDefinicao {
  organizationId: string;
  /**
   * A conexão dona da definição.
   *
   * `null` só para instalação anterior à 0144, onde a coluna não existia e as
   * linhas não sabem de qual conexão são. Com sessão, o filtro é obrigatório:
   * dois números têm definições diferentes, e conferir a do número errado
   * aprovaria um envio que a plataforma vai recusar.
   */
  channelSessionId: string | null;
  name: string;
  language: string;
  values: Record<string, string>;
}

/**
 * Lança com uma frase acionável quando a definição não serve. Silêncio é
 * aprovação.
 *
 * NÃO lança quando a definição simplesmente não está espelhada: um espelho
 * vazio (sync nunca rodou) barraria todo envio de modelo numa instalação que
 * está com tudo certo do lado da plataforma. Recusar o que não se sabe é pior
 * que deixar o provedor responder — ele é a autoridade, não este espelho.
 */
export async function conferirDefinicao(
  db: SupabaseClient,
  pedido: PedidoDeDefinicao,
): Promise<void> {
  if (!pedido.name || !pedido.language) {
    throw new Error("template_incompleto: nome e idioma são obrigatórios em type=template");
  }

  // A linha desta conexão, ou a do canal oficial (gravada sem conexão). Sem o
  // segundo passo, o canal oficial nunca era conferido: a linha não casava e o
  // "não espelhada" abaixo deixava passar tudo.
  const { data, error } = await linhaDoEspelho(
    db,
    "name, language, status, contract_hash, components, parameter_format",
    pedido,
  );

  // Falha de leitura não é definição inválida. Barrar aqui trocaria um envio
  // que ia dar certo por um erro nosso.
  if (error) return;

  const linha = data as {
    name: string;
    language: string;
    status: string;
    contract_hash: string;
    components: unknown;
    parameter_format?: string;
  } | null;

  // Não espelhada: deixa passar. Ver o cabeçalho.
  if (!linha) return;

  const estado = bindingState(
    {
      name: pedido.name,
      language: pedido.language,
      contractHash: linha.contract_hash,
      values: pedido.values,
    },
    {
      name: linha.name,
      language: linha.language,
      contractHash: linha.contract_hash,
      status: linha.status,
    },
  );

  if (estado === "not_approved") {
    throw new Error(
      `template_not_approved: "${pedido.name}" (${pedido.language}) está ${linha.status} — ` +
        `a plataforma só entrega definição APROVADA.`,
    );
  }

  const contrato = deriveTemplateContract({
    name: linha.name,
    language: linha.language,
    parameter_format: linha.parameter_format,
    components: linha.components as Parameters<typeof deriveTemplateContract>[0]["components"],
  });
  const faltando = missingSlots(contrato, pedido.values);

  if (faltando.length > 0) {
    // O nome de cada buraco, e não "faltam 2": o operador precisa saber QUAL
    // preencher, e essa é a diferença entre a frase servir e não servir.
    const nomes = faltando.map((s) => s.key).join(", ");
    throw new Error(
      `template_missing_values: "${pedido.name}" espera ${faltando.length} valor(es) — falta: ${nomes}`,
    );
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";

import { lerRegrasDeCliente } from "@/lib/contacts/regras-de-cliente";

/**
 * A regra "cliente pela agenda" está ligada nesta organização? — para o SERVIDOR.
 *
 * Existe para o caminho que não passa pelo layout: o nascimento do lead, que
 * roda na ingestão com o client de service role. A tela lê a mesma chave pelo
 * `ActiveOrg` que o layout já monta.
 *
 * ⚠️ UMA LEITURA SÓ PARA AS TRÊS CHAVES (#3644). A partir da regra "cliente
 * pela venda", o nascimento do lead precisa de `cliente_pela_agenda`,
 * `cliente_pela_venda` E `pos_venda_dias` — as três na MESMA linha de
 * `organizations`. Este nome continua existindo porque há chamador (e teste)
 * que só quer a resposta da agenda; quem precisa das três pergunta a
 * `lerRegrasDeCliente` e paga um `select` em vez de três.
 *
 * ⚠️ FALHA LÊ COMO DESLIGADA, e isso é o desenho. Quem consome isto escolhe o
 * funil de um lead que vai nascer de qualquer jeito: errar para o funil padrão
 * é o comportamento de antes da regra existir, visível e corrigível; lançar
 * aqui impediria o lead de nascer. O erro não some — vai para o log com a
 * organização.
 *
 * `organizationId` vem sempre de fonte confiável (o chamador já filtrou por
 * ela); o filtro explícito é a regra de todo acesso com service role.
 */
export async function lerClientePelaAgenda(
  db: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  return (await lerRegrasDeCliente(db, organizationId)).pelaAgenda;
}

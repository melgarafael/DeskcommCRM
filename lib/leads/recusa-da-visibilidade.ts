/**
 * O banco recusou a escrita em `crm_leads` pela visibilidade do funil.
 *
 * A `crm_leads_update` repete `fn_can_view_lead` no USING e no WITH CHECK. A
 * linha que o chamador leu passa pelo USING; o que recusa um dono novo fora do
 * escopo dele é o WITH CHECK, e WITH CHECK violado num UPDATE é ERRO 42501 —
 * não zero linhas.
 *
 * Só a policy de `crm_leads`: o mesmo 42501 também é GRANT faltando numa
 * função ou numa tabela que um gatilho alcança — defeito nosso, que tem de
 * continuar sendo falha, e não virar "visibilidade". A recusa de RLS nomeia a
 * tabela entre aspas na mensagem em inglês, que é o lc_messages do Supabase
 * (en_US); a de GRANT ("permission denied for table crm_leads") não. Num
 * Postgres com mensagens em de, es ou fr as aspas mudam e a recusa cai no
 * caminho de falha, que é a direção segura.
 */
export function ehRecusaDaVisibilidadeDoFunil(
  erro: { code?: string; message?: string } | null | undefined,
): boolean {
  return erro?.code === "42501" && (erro.message?.includes('"crm_leads"') ?? false);
}

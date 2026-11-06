/**
 * O link para um NEGÓCIO a partir de Configurações › Conversões.
 *
 * ── Por que a URL ESTÁVEL, e não o quadro direto ────────────────────────────
 *
 * As duas linhas desta tela ("Abrir negócio", no Histórico de envios, e o nome
 * do negócio, na tabela de pendências da aba Configuração) apontavam para a
 * lista de funis com o `?lead=` colado na URL. A lista de funis (`/app/kanban`)
 * não lê `lead`, então quem clicava caía na lista e tinha de adivinhar em qual
 * funil o negócio estava.
 *
 * Quem sabe levar ao quadro certo é `/app/leads/[id]` — a URL estável do
 * negócio, que resolve o funil ATUAL na hora (leads mudam de funil) e
 * redireciona para `/app/pipelines/[funil]?lead=[id]`, que o board abre no card.
 * Ela também é a única que já existe no produto: três outras telas a usam, e
 * não há por que inventar uma segunda resolução de funil aqui.
 *
 * O `notFound()` da rota estável fica preservado: um negócio de OUTRA
 * organização não é enxergado pela consulta filtrada pela organização ativa, e
 * continua respondendo 404 — este componente nunca resolve o funil por conta
 * própria, então não tem como vazar negócio de outra org pela URL.
 */

/**
 * A URL estável de um negócio — a mesma que o board e o dossiê já entendem.
 * Exportada para quem precisa só do caminho (teste, link em texto).
 */
export function caminhoDoNegocio(leadId: string): string {
  return `/app/leads/${leadId}`;
}

export function LinkDoNegocio({
  leadId,
  className,
  children,
}: {
  leadId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a className={className} href={caminhoDoNegocio(leadId)}>
      {children}
    </a>
  );
}

import type { ReactNode } from "react";

/**
 * A superfície clara de Configurações.
 *
 * ── Por que um `layout.tsx` ─────────────────────────────────────────────────
 *
 * São DEZESSEIS páginas sob `/app/settings` (perfil, segurança, marca, billing,
 * tokens, notificações, atendimento, conversões, atualização, os três de
 * `tenant/`, e três redirecionamentos de rota antiga). Editar dezesseis
 * arquivos para pintar um fundo é dezesseis chances de esquecer um — e a que
 * ficasse de fora só apareceria quando alguém navegasse até ela. Aqui é um
 * ponto só, e ele vale para a próxima página que nascer nesta pasta.
 *
 * Os três redirecionamentos (`canal-oficial`, `templates`, `tenant/whatsapp`)
 * atravessam isto sem renderizar nada: `redirect()` interrompe antes do render,
 * então o layout não os alcança nem precisa alcançar.
 *
 * ── Por que SEM `p-6` ───────────────────────────────────────────────────────
 *
 * Mesma razão do layout de Contatos: `-m-6` cancela o respiro do `<main>` e
 * quem o repõe é cada página, que já tem o seu. Quinze das dezesseis já tinham;
 * a exceção era `atualizacao/page.tsx`, que devolvia `<UpdatePanel />` cru e
 * vivia do padding do `<main>` — ela ganhou o `p-6` que já tinha na prática,
 * agora dito por ela mesma. O resultado na tela é o mesmo pixel de antes.
 */
export default function ConfiguracoesLayout({ children }: { children: ReactNode }) {
  return (
    <div data-superficie="clara" className="-m-6 min-h-[calc(100%+3rem)] bg-bg text-text">
      {children}
    </div>
  );
}

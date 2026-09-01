import { LogoDaFachada } from "@/components/auth/LogoDaFachada";

/**
 * A casca centrada das telas de acesso que NÃO são o `/login`: cadastro,
 * recuperação de senha, definição de nova senha, MFA e códigos de recuperação.
 *
 * O `/login` tem painel próprio (dividido em dois) desde o redesenho; as outras
 * cinco continuam sendo uma coluna estreita no meio da tela, que é a forma certa
 * para elas — são passos curtos, quase sempre alcançados por link de e-mail, e
 * um painel de marca gigante ao lado só empurraria o campo para longe.
 *
 * O logo sai de `LogoDaFachada` — o mesmo componente que o `/login` usa — para
 * que as duas cascas não divirjam na resolução da marca.
 */
export function FachadaCentrada({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <LogoDaFachada />
        </div>
        {children}
      </div>
    </div>
  );
}

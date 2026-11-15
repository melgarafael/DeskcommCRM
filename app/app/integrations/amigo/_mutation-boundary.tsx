"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { execute, errorText } from "./_api";
import type { AmigoOperation, Receipt } from "./_types";
type PendingRequest = {
  operation: AmigoOperation;
  input: Record<string, unknown>;
  key: string;
  contactId?: string;
  protocol?: string;
  onConfirmed: (receipt: Receipt) => void;
};
const Context = createContext<{
  blocked: boolean;
  report: (request: PendingRequest) => void;
  resolve: (key: string) => void;
} | null>(null);
export const useMutationBlock = () => useContext(Context);
/** Retém a pendência mesmo se o formulário fechar ou o contato mudar. */
export function AmigoMutationBoundary({ children }: { children: ReactNode }) {
  const parent = useContext(Context);
  return parent ? children : <Boundary>{children}</Boundary>;
}
function Boundary({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const check = async () => {
    if (!request || checking) return;
    setChecking(true);
    setMessage("");
    try {
      const result = await execute(
        request.operation,
        request.input,
        request.key,
        request.contactId,
      );
      if (result.uncertain) {
        setMessage(
          "O resultado continua incerto. Confira diretamente com a clínica; não repita a solicitação.",
        );
        setRequest({ ...request, protocol: result.operation_id });
      } else {
        request.onConfirmed(result);
        setRequest(null);
        setMessage("Resultado confirmado. Atualize a agenda ou o cadastro antes de continuar.");
      }
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setChecking(false);
    }
  };
  return (
    <Context.Provider
      value={{
        blocked: !!request,
        report: setRequest,
        resolve: (key) => setRequest((current) => (current?.key === key ? null : current)),
      }}
    >
      {request && (
        <aside
          role="status"
          className="space-y-2 rounded-md border border-destructive/40 p-4 text-sm"
        >
          <p className="font-medium">Há uma solicitação com resultado incerto.</p>
          <p>
            Novas alterações ficam bloqueadas nesta área. Confira a agenda ou o cadastro no Amigo
            antes de continuar.
          </p>
          <p className="text-xs break-all">Protocolo: {request.protocol ?? request.key}</p>
          <Button variant="outline" disabled={checking} onClick={() => void check()}>
            Conferir protocolo pendente
          </Button>
        </aside>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {children}
    </Context.Provider>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { AssistenteAvatar } from "./AssistenteAvatar";
import { AssistenteChat } from "./AssistenteChat";

/**
 * Orquestra avatar + chat no canto inferior direito da ÁREA LOGADA.
 *
 * Montado no `AppShell` (só `/app/*`), então login, onboarding e landing
 * nunca o veem. `Esc` fecha o chat; o estado vive aqui para o avatar reagir
 * visualmente (boca aberta) enquanto o chat está aberto.
 */
export function AssistenteFlutuante() {
  const [aberto, setAberto] = useState(false);
  const alternar = useCallback(() => setAberto((v) => !v), []);
  const fechar = useCallback(() => setAberto(false), []);

  useEffect(() => {
    if (!aberto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") fechar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [aberto, fechar]);

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3 print:hidden" data-assistente="flutuante">
      <AssistenteChat aberto={aberto} onFechar={fechar} />
      <AssistenteAvatar aberto={aberto} onToggle={alternar} />
    </div>
  );
}

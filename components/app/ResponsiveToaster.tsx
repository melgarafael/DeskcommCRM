"use client";
import { Toaster } from "sonner";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * Doc de responsividade pede toast `bottom-center` full-width com
 * safe-area em mobile, `bottom-right` (ou top-right, como já era) em desktop.
 * O componente sonner não observa breakpoint sozinho — precisa de um wrapper
 * client pra escolher a posição via JS (é por isso que isto não vive direto
 * no RootLayout, que é server component).
 */
export function ResponsiveToaster() {
  const isMobile = useIsMobile();
  return (
    <Toaster
      position={isMobile ? "bottom-center" : "top-right"}
      richColors
      closeButton
      duration={4000}
      toastOptions={
        isMobile
          ? { style: { marginBottom: "env(safe-area-inset-bottom)" } }
          : undefined
      }
    />
  );
}

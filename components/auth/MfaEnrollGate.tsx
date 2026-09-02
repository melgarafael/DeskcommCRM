"use client";

import { useState } from "react";

import { MfaEnrollModal } from "@/components/auth/MfaEnrollModal";

/**
 * Full-viewport blocker shown to users (admin / platform_admin) who haven't
 * enrolled MFA yet. The modal cannot be dismissed — the user MUST complete
 * enrollment to access the app.
 *
 * The blocking decision is LATCHED on first mount: `confirmMfaEnroll` is a
 * Server Action, and Next.js revalidates the route when it returns. If the
 * gate re-read `enrolled` live, the freshly-verified factor would flip it to
 * "enrolled" and unmount this modal — destroying the one-time recovery codes
 * before the user could save them. Latching keeps the modal alive until the
 * user acknowledges and the modal itself reloads the page.
 */
export function MfaEnrollGate({
  enrolled,
  children,
}: {
  enrolled: boolean;
  children: React.ReactNode;
}) {
  const [blocking] = useState(!enrolled);

  if (!blocking) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-40 bg-background">
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">
          A configurar autenticação em duas etapas...
        </p>
      </div>
      <MfaEnrollModal />
    </div>
  );
}

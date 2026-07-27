import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { Stepper } from "./_components/Stepper";
import { SkipToEnd } from "./_components/SkipToEnd";
import { branding } from "@/lib/branding";

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  const { onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt) redirect("/app/inbox");

  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") ?? "";
  const stepKey = currentStepFromPath(pathname);

  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{branding().name}</p>
            <h1 className="text-lg font-semibold tracking-tight">{activeOrg.name}</h1>
          </div>
          {isDev ? <SkipToEnd /> : null}
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-2">
          <Stepper current={stepKey} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}

function currentStepFromPath(pathname: string): string {
  if (pathname.includes("/welcome")) return "welcome";
  if (pathname.includes("/connect-whatsapp")) return "whatsapp";
  if (pathname.includes("/connect-nuvemshop")) return "nuvemshop";
  if (pathname.includes("/setup-ai")) return "ai";
  if (pathname.includes("/invite-team")) return "team";
  if (pathname.includes("/done")) return "done";
  return "welcome";
}

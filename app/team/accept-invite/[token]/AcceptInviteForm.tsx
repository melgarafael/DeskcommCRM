"use client";
import { useActionState } from "react";
import { acceptInviteAction, type AcceptInviteResult } from "@/app/actions/team/acceptInvite";

export function AcceptInviteForm({
  token,
  label,
  failureLabel,
  pendingLabel,
  limitLabel,
}: {
  token: string;
  label: string;
  failureLabel: string;
  pendingLabel: string;
  limitLabel: string;
}) {
  const [result, submit, pending] = useActionState<AcceptInviteResult | null, FormData>(
    async () => acceptInviteAction(token),
    null,
  );
  return (
    <form action={submit} className="mt-4 space-y-3">
      {result && !result.ok && (
        <p role="alert">
          {result.error === "subscription_resource_limit" ? limitLabel : failureLabel}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        {pending ? pendingLabel : label}
      </button>
    </form>
  );
}

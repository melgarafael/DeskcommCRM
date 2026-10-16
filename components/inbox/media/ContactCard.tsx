"use client";



import { useRouter } from "next/navigation";

import { useState } from "react";

import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";

import { UserCircle } from "@/lib/ui/icons";

import { resolveSharedContact } from "@/lib/messaging/contact-card";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

import type { Message } from "@/lib/types/messaging";

import { cn } from "@/lib/utils";



interface Props {

  message: Message;

}



/** Cartão de contato compartilhado — toque abre a conversa no inbox (mesma sessão). */

export function ContactCard({ message }: Props) {

  const t = useT();

  const router = useRouter();

  const [loading, setLoading] = useState(false);

  const contact = resolveSharedContact(message);



  if (!contact) {

    return (

      <div className="rounded-lg border border-current/20 bg-background/10 px-3 py-2 text-xs opacity-80">

        {t("Contato")}

      </div>

    );

  }



  const canOpen = !!(contact.contact_id || contact.phone_number?.trim());



  async function handleOpen() {

    if (!canOpen || loading) return;

    setLoading(true);

    try {

      const res = await fetch("/api/v1/conversations/open-with-contact", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          channel_session_id: message.channel_session_id,

          contact_id: contact!.contact_id,

          phone_number: contact!.phone_number?.trim() || undefined,

          name: contact!.name,

        }),

      });

      const json = (await res.json()) as {

        data?: { conversation_id: string; bloqueada_por?: string | null };

        error?: { message?: string };

      };

      if (!res.ok || !json.data?.conversation_id) {

        throw new Error(json.error?.message ?? t("Não foi possível abrir a conversa."));

      }

      // A conversa já é de OUTRA atendente e esta não a enxerga: abrir levaria a uma página
      // em branco. Avisa de quem é, em vez de navegar.
      if (json.data.bloqueada_por) {

        toast.info(`${t("Esta conversa já está com")} ${json.data.bloqueada_por}.`);

        return;

      }

      router.push(`/app/inbox?id=${json.data.conversation_id}`);

    } catch (err) {

      toast.error(err instanceof Error ? t(err.message) : t("Não foi possível abrir a conversa."));

    } finally {

      setLoading(false);

    }

  }



  return (

    <button

      type="button"

      disabled={!canOpen || loading}

      onClick={handleOpen}

      title={canOpen ? t("Abrir conversa com este contato") : undefined}

      className={cn(

        "flex max-w-[220px] items-center gap-2 rounded-lg border border-current/20 bg-background/10 px-2 py-2 text-left transition-colors",

        canOpen && "cursor-pointer hover:bg-background/20 disabled:cursor-wait disabled:opacity-70",

        !canOpen && "cursor-default opacity-90",

      )}

    >

      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background/20">

        <UserCircle size={28} weight="duotone" aria-hidden />

      </span>

      <span className="min-w-0 flex-1">

        <span className="block truncate font-medium">{contact.name}</span>

        {contact.phone_number ? (

          <span className="block truncate text-xs opacity-80">{phoneForDisplay(contact.phone_number)}</span>

        ) : null}

      </span>

    </button>

  );

}


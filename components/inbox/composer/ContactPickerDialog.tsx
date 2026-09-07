"use client";

import { useT } from "@/hooks/i18n/useT";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useContactList } from "@/hooks/contacts/useContactList";
import { parseDialablePhone, phoneToWhatsappId } from "@/lib/messaging/contact-card";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { MagnifyingGlass, UserCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { Contact } from "@/lib/types/contacts";

/** Contato da base ou informado na hora — o que vai no cartão WhatsApp. */
export interface ContactPickPayload {
  contactId?: string;
  name: string;
  phone_number: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Contato da conversa atual — não aparece na lista (não faz sentido compartilhar consigo). */
  excludeContactId?: string | null;
  sending?: boolean;
  onPick: (payload: ContactPickPayload) => void;
}

function displayName(c: Contact, t: (texto: string) => string = (texto) => texto): string {
  return rotuloDoContato(c, t);
}

export function ContactPickerDialog({
  open,
  onOpenChange,
  excludeContactId,
  sending,
  onPick,
}: Props) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");

  useEffect(() => {
    if (!open) {
      setSearch("");
      setDebounced("");
      setManualName("");
      setManualPhone("");
      return;
    }
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search, open]);

  const searchPhone = parseDialablePhone(debounced);

  useEffect(() => {
    if (searchPhone) setManualPhone(searchPhone);
  }, [searchPhone]);

  const list = useContactList({ search: debounced || undefined });
  const contacts =
    list.data?.pages.flatMap((p) => p.data).filter((c) => {
      if (excludeContactId && c.id === excludeContactId) return false;
      if (c.is_anonymized) return false;
      return Boolean(c.phone_number);
    }) ?? [];

  const resolvedManualPhone = parseDialablePhone(manualPhone);
  const phoneAlreadyInList =
    resolvedManualPhone &&
    contacts.some(
      (c) =>
        c.phone_number &&
        phoneToWhatsappId(c.phone_number) === phoneToWhatsappId(resolvedManualPhone),
    );

  function close(v: boolean) {
    if (!v) {
      setSearch("");
      setManualName("");
      setManualPhone("");
    }
    onOpenChange(v);
  }

  function pickFromDb(c: Contact) {
    const phone = c.phone_number!;
    onPick({
      contactId: c.id,
      name: displayName(c),
      phone_number: phone,
    });
  }

  function pickManual() {
    if (!resolvedManualPhone) return;
    onPick({
      name: manualName.trim() || resolvedManualPhone,
      phone_number: resolvedManualPhone,
    });
  }

  const showManualForm = contacts.length === 0 || Boolean(searchPhone) || manualPhone.length > 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Enviar contato")}</DialogTitle>
          <DialogDescription>
            {t("Escolha alguém da base ou informe nome e telefone — como no WhatsApp.")}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou telefone…"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="max-h-48 overflow-y-auto rounded-md border border-border">
          {list.isLoading && contacts.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Carregando…</p>
          ) : contacts.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              {debounced ? t("Nenhum contato encontrado na base.") : t("Nenhum contato com telefone na base.")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {contacts.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={sending}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm",
                      "hover:bg-muted disabled:opacity-50",
                    )}
                    onClick={() => pickFromDb(c)}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <UserCircle size={22} weight="duotone" className="text-primary" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{displayName(c)}</span>
                      {c.phone_number && (
                        <span className="block truncate text-xs text-muted-foreground">{phoneForDisplay(c.phone_number)}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {list.hasNextPage && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={list.isFetchingNextPage}
            onClick={() => list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
          </Button>
        )}

        {showManualForm && (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              {searchPhone && !phoneAlreadyInList
                ? t("Enviar número informado")
                : "Ou informe um contato"}
            </p>
            {searchPhone && !phoneAlreadyInList && (
              <button
                type="button"
                disabled={sending}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left text-sm",
                  "hover:bg-muted disabled:opacity-50",
                )}
                onClick={pickManual}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <UserCircle size={22} weight="duotone" className="text-primary" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {manualName.trim() || searchPhone}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{searchPhone}</span>
                </span>
              </button>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="manual-contact-name">Nome (opcional)</Label>
              <Input
                id="manual-contact-name"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder={t("Como aparece no cartão")}
                disabled={sending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-contact-phone">{t("Telefone")}</Label>
              <Input
                id="manual-contact-phone"
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder="+55 32 98479-3302"
                disabled={sending}
              />
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={sending || !resolvedManualPhone}
              onClick={pickManual}
            >
              Enviar contato
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={sending}>
            Cancelar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

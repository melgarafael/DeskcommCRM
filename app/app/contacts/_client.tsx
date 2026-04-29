"use client";
import { useEffect, useMemo, useState } from "react";
import { Plus, MagnifyingGlass } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useContactList } from "@/hooks/contacts/useContactList";
import { ContactsTable } from "@/components/contacts/ContactsTable";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { EmptyContacts } from "@/components/empty";

const SOURCE_OPTIONS = [
  { value: undefined, label: "Todas as origens" },
  { value: "manual", label: "Manual" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "nuvemshop", label: "Nuvemshop" },
];

export function ContactsListClient() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);

  // Debounce search 250ms
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters = useMemo(() => ({ search, tag, source }), [search, tag, source]);
  const q = useContactList(filters);

  const allContacts = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allContacts) for (const t of c.tags) set.add(t);
    return Array.from(set).sort();
  }, [allContacts]);

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contatos</h1>
          <p className="text-sm text-muted-foreground">
            Customer 360 — busque, filtre e gerencie contatos.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} weight="bold" aria-hidden />
          <span>Novo contato</span>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Buscar por nome, email ou telefone…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 w-72 pl-8"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={tagOptions.length === 0}>
              {tag ? `Tag: ${tag}` : "Tag: todas"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Tag</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTag(undefined)}>Todas</DropdownMenuItem>
            {tagOptions.map((t) => (
              <DropdownMenuItem key={t} onClick={() => setTag(t)}>
                {t}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? "Origem"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SOURCE_OPTIONS.map((s) => (
              <DropdownMenuItem key={s.label} onClick={() => setSource(s.value)}>
                {s.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {(search || tag || source) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setTag(undefined);
              setSource(undefined);
            }}
          >
            Limpar filtros
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">Erro ao carregar contatos.</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => q.refetch()}
          >
            Tentar novamente
          </Button>
        </Card>
      ) : allContacts.length === 0 ? (
        <Card className="p-2">
          <EmptyContacts />
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <ContactsTable contacts={allContacts} />
          </Card>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
              >
                {q.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
              </Button>
            </div>
          )}
        </>
      )}

      <NewContactDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

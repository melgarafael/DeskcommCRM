"use client";
import { randomId } from "@/lib/random-id";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notifySupportTransition } from "@/components/app/ImpersonateBanner";
import { showApiError } from "@/components/feedback/ApiErrorToast";
interface Cliente {
  id: string;
  display_name: string;
  slug: string;
  status: string;
}
interface Lista {
  clientes: Cliente[];
  utilizadas: number;
  limite_clientes: number;
  tem_mais: boolean;
}
export function ClientesDaAgencia() {
  const t = useT();
  const [pagina, setPagina] = useState(1);
  const [nome, setNome] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const lista = useQuery({
    queryKey: ["agencia-clientes", pagina],
    queryFn: () => apiClient.get<{ data: Lista }>(`/api/v1/agencia/clientes?pagina=${pagina}`),
  });
  async function criar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const chave = key ?? randomId();
    setKey(chave);
    try {
      await apiClient.post(
        "/api/v1/agencia/clientes",
        { display_name: nome, slug },
        { idempotencyKey: chave },
      );
      setNome("");
      setSlug("");
      setKey(null);
      await lista.refetch();
    } catch (e) {
      showApiError(e);
    } finally {
      setBusy(false);
    }
  }
  async function abrir(id: string) {
    setBusy(true);
    try {
      await apiClient.post(`/api/v1/agencia/clientes/${id}/abrir`, {});
      notifySupportTransition();
      window.location.assign("/app/inbox");
    } catch (e) {
      showApiError(e);
      setBusy(false);
    }
  }
  if (lista.isPending) return <p className="p-6">{t("Carregando organizações…")}</p>;
  if (lista.isError)
    return (
      <div className="space-y-4 p-6">
        <p role="alert">{t("Não foi possível carregar as organizações.")}</p>
        <Button onClick={() => void lista.refetch()}>{t("Tentar novamente")}</Button>
      </div>
    );
  const dados = lista.data.data;
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{t("Organizações clientes")}</h1>
      <p>
        {t("Organizações vinculadas")}: {dados.utilizadas} / {dados.limite_clientes}
      </p>
      <form onSubmit={criar} className="space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">{t("Criar organização cliente")}</h2>
        <label className="block">
          {t("Nome")}
          <Input
            value={nome}
            onChange={(e) => {
              setNome(e.target.value);
              setKey(null);
            }}
            required
            minLength={2}
            maxLength={120}
          />
        </label>
        <label className="block">
          {t("Identificador")}
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setKey(null);
            }}
            required
            minLength={2}
            maxLength={40}
            pattern="[a-z0-9-]+"
          />
        </label>
        <Button disabled={busy || dados.utilizadas >= dados.limite_clientes}>
          {t("Criar organização cliente")}
        </Button>
        {dados.utilizadas >= dados.limite_clientes && (
          <p role="status">
            {t("Limite atingido. Solicite um aumento ao administrador da plataforma.")}
          </p>
        )}
      </form>
      <div className="space-y-3">
        {dados.clientes.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <h2 className="font-semibold">{c.display_name}</h2>
              <p className="text-sm text-muted-foreground">
                {c.slug} · {c.status === "active" ? t("Ativo") : t("Indisponível")}
              </p>
            </div>
            <Button disabled={busy || c.status !== "active"} onClick={() => void abrir(c.id)}>
              {t("Abrir organização")}
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-3">
        <Button disabled={pagina === 1 || busy} onClick={() => setPagina((p) => p - 1)}>
          {t("Anterior")}
        </Button>
        <Button disabled={!dados.tem_mais || busy} onClick={() => setPagina((p) => p + 1)}>
          {t("Próxima")}
        </Button>
      </div>
    </div>
  );
}

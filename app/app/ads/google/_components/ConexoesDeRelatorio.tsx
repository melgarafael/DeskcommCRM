"use client";

import { useState, useTransition } from "react";
import { useT } from "@/hooks/i18n/useT";
import type { ContaDeRelatorio } from "@/lib/plataformas-de-anuncio/google/contas-de-relatorio";

export type RemoverConta = (id: string) => Promise<{ ok: true } | { ok: false; detalhe: string }>;

const campo = "min-h-9 rounded-md border border-border-strong bg-surface px-3 text-sm text-text";
const botao = "min-h-9 cursor-pointer rounded-md border border-border-strong bg-surface px-3 text-sm font-semibold text-accent hover:bg-accent-soft disabled:opacity-60";
const padraoId = "[0-9]{10}|[0-9]{3}-[0-9]{3}-[0-9]{4}";
const ROTA_DE_CONEXAO = "/api/v1/plataformas-de-anuncio/google/connect";

export function ConexoesDeRelatorio({ conta, remover }: { conta?: ContaDeRelatorio; remover: RemoverConta }) {
  const t = useT();
  const [modo, setModo] = useState<"nova" | "reconectar" | "remover" | null>(null);
  const [erro, setErro] = useState("");
  const [ocupado, iniciar] = useTransition();
  const editada = modo === "reconectar" ? conta : undefined;

  function confirmarRemocao() {
    if (!conta?.propria) return;
    setErro("");
    iniciar(async () => {
      try {
        const resultado = await remover(conta.customerId);
        if (resultado.ok) setModo(null);
        else setErro(t(resultado.detalhe));
      } catch {
        setErro(t("Não foi possível remover o acesso de leitura. Tente novamente."));
      }
    });
  }

  return (
    <div className="grid justify-items-start gap-3">
      {modo === null && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={botao} onClick={() => setModo("nova")}>{t("Conectar conta de leitura")}</button>
          {conta && <button type="button" className={botao} onClick={() => setModo("reconectar")}>
            {conta.propria ? t("Reconectar para leitura") : t("Autorizar leitura desta conta")}
          </button>}
          {conta?.propria && <button type="button" className={botao} onClick={() => setModo("remover")}>{t("Remover acesso de leitura")}</button>}
        </div>
      )}
      {(modo === "nova" || modo === "reconectar") && (
        <form
          method="get" action={ROTA_DE_CONEXAO}
          className="w-full rounded-lg border border-border bg-surface p-4"
          aria-label={t("Autorização de relatórios")}
          onSubmit={(evento) => {
            // A CSP global tem `form-action 'self'`, e o Chromium a aplica também ao
            // redirect: o envio nativo do formulário para a rota, que responde 307 para
            // accounts.google.com, era cancelado em silêncio (medido na prova do #5041).
            // Navegar pela URL não passa por form-action. A validação nativa (required,
            // pattern) já rodou: o submit só dispara com o formulário válido.
            evento.preventDefault();
            const dados = new URLSearchParams();
            new FormData(evento.currentTarget).forEach((valor, chave) => {
              if (typeof valor === "string") dados.append(chave, valor);
            });
            window.location.assign(`${ROTA_DE_CONEXAO}?${dados.toString()}`);
          }}
        >
          <input type="hidden" name="purpose" value="reporting" />
          <p className="mb-3 text-sm text-muted-foreground">{t("Use um login Google com acesso a esta conta de anúncios. Esta conexão serve apenas para consultar relatórios.")}</p>
          <div className="grid gap-3 sm:grid-cols-3 [&_label]:grid [&_label]:gap-1 [&_label]:text-sm">
            <label>{t("Nome para identificar a conta")}
              <input name="label" className={campo} required maxLength={80} defaultValue={editada?.propria ? editada.label : ""} />
            </label>
            <label>{t("ID da conta de anúncios")}
              <input name="customer_id" className={campo} required inputMode="numeric" pattern={padraoId}
                placeholder="123-456-7890" maxLength={12} readOnly={!!editada} defaultValue={editada?.customerId} />
            </label>
            <label>{t("ID da conta gerente (MCC, opcional)")}
              <input name="login_customer_id" className={campo} inputMode="numeric" pattern={padraoId}
                placeholder="123-456-7890" maxLength={12} defaultValue={editada?.loginCustomerId ?? ""} />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className={botao} type="submit">{t("Continuar no Google")}</button>
            <button className={botao} type="button" onClick={() => setModo(null)}>{t("Cancelar")}</button>
          </div>
        </form>
      )}
      {modo === "remover" && conta?.propria && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="mb-3 text-sm">{t("Remover a autorização de leitura de {conta}? O envio de conversões será preservado.").replace("{conta}", conta.label || conta.customerId)}</p>
          <div className="flex gap-2">
            <button className={botao} type="button" disabled={ocupado} onClick={confirmarRemocao}>{t("Confirmar remoção")}</button>
            <button className={botao} type="button" disabled={ocupado} onClick={() => { setModo(null); setErro(""); }}>{t("Cancelar")}</button>
          </div>
          {erro && <p role="alert" className="mt-3 text-sm">{erro}</p>}
        </div>
      )}
    </div>
  );
}

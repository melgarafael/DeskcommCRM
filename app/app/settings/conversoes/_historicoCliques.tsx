import type { LinhaDeClique } from "@/lib/conversoes/historico-de-cliques";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { ReprocessarClique } from "./_reprocessarClique";

export function HistoricoDeCliques({
  linhas,
  idioma,
}: {
  linhas: LinhaDeClique[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <section className="flex flex-col gap-3" data-testid="historico-de-cliques-ctwa">
      <h2 className="text-base font-semibold">{t("LeadSubmitted por clique CTWA")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "Últimos 20 cliques recebidos. O mesmo contato pode aparecer mais de uma vez sem criar outro negócio.",
        )}
      </p>
      {linhas.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t("Nenhum clique CTWA registrado.")}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {linhas.map((linha) => (
            <li key={linha.id} className="p-3 text-sm">
              <details>
                <summary className="cursor-pointer">
                  {new Date(linha.capturedAt).toLocaleString(idioma)} ·{" "}
                  {t(
                    linha.status === "sent"
                      ? "Entregue"
                      : linha.status === "error"
                        ? "Falhou"
                        : linha.status === "skipped"
                          ? "Não enviado"
                          : "Aguardando",
                  )}
                </summary>
                <div className="mt-2 flex flex-col gap-2 text-xs">
                  <p>
                    {t("ID do evento")}:{" "}
                    <span className="font-mono break-all">{linha.eventId}</span>
                  </p>
                  <p>
                    {t("Primeira mensagem")}:{" "}
                    <span className="font-mono break-all">{linha.firstMessageId}</span>
                  </p>
                  {linha.reason && (
                    <p>
                      {t("Motivo")}: {t(linha.reason)}
                    </p>
                  )}
                  {linha.status !== "sent" && linha.reason !== "lead_submitted_desativado" && (
                    <ReprocessarClique clickId={linha.id} idioma={idioma} />
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

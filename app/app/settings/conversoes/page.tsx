/**
 * Configurações → Conversões. Onde o dono do tráfego conecta a conta de anúncios
 * e vê quais vendas foram (ou não foram) reportadas de volta.
 *
 * ── Por que esta tela nasce JUNTO com o mecanismo, e não depois ──────────────
 *
 * Invariante 6 da doutrina de restrição de canal: "nenhum mecanismo de backend
 * pode depender de estado configurável que não tenha tela para ver, tela para
 * mudar, e caminho visível de falha". A #144 mediu o preço de ignorar isso —
 * rodízio e visibilidade por atendente existiam INTEIROS, sem tela, e um
 * contribuidor abriu issue pedindo a feature que já estava construída.
 *
 * O handler de conversões teria caído no mesmo buraco, e pior: a falha mais
 * comum dele (`sem_valor`) é ACIONÁVEL por quem opera. Sem esta lista, "a Meta
 * não recebe minhas vendas" não teria resposta em lugar nenhum do produto.
 *
 * ── Por que ADMIN CLIENT para ler, diferente de `settings/marca` ─────────────
 *
 * A tela da marca lê `organizations` pelo client de sessão, porque a RLS
 * entrega essa linha a qualquer membro. Aqui não existe policy nenhuma:
 * `ad_platform_connections` e `ad_conversion_dispatches` têm RLS ligada com ZERO
 * policies e grants revogados de anon/authenticated (0204), exatamente para não
 * serem alcançáveis pela anon key que vai para o browser. Pelo client de sessão
 * esta página mostraria vazio para todo mundo — o gate de papel acima é o que
 * autoriza, e a leitura privilegiada acontece no servidor.
 *
 * ── Por que `admin`, e não `manager` ────────────────────────────────────────
 *
 * O objeto é uma credencial que escreve na conta de anúncios da empresa, ao lado
 * de billing e API tokens na mesma prancheta. Mesmo gate de `settings/marca`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  contaEnviadas,
  lerEstadoDaConexao,
  lerPendencias,
  MOTIVO_LEGIVEL,
} from "@/lib/conversoes/estado-da-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import { formatCentsBRL } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDeConversoes } from "./_form";

export const metadata = { title: "Conversões" };
export const dynamic = "force-dynamic";

export default async function ConversoesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const admin = createAdminClient();
  const [estado, pendencias, enviadas] = await Promise.all([
    lerEstadoDaConexao(admin, activeOrg.orgId),
    lerPendencias(admin, activeOrg.orgId),
    contaEnviadas(admin, activeOrg.orgId),
  ]);
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Conversões")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Quando um negócio que veio de anúncio é marcado como ganho, o valor da venda volta para a plataforma que trouxe o cliente. É esse retorno que ensina o anúncio a procurar mais gente parecida com quem comprou.",
          )}
        </p>
      </header>

      {estado.conectada && !estado.habilitada && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          {t("O envio está pausado. As vendas continuam sendo registradas aqui, mas não vão para a plataforma enquanto isto estiver desligado.")}
        </div>
      )}

      {estado.testEventCode && (
        <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-4 text-sm">
          {t("Modo de teste ligado: as vendas vão marcadas como teste e não contam para a otimização. Apague o código de teste quando terminar de conferir.")}
        </div>
      )}

      <FormularioDeConversoes estado={estado} idioma={idioma} />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{t("Vendas que não foram reportadas")}</h2>
          <span className="text-sm text-muted-foreground">
            {enviadas} {t("reportadas com sucesso")}
          </span>
        </div>

        {pendencias.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            {/*
              Ausência de pendência tem DUAS causas com significados opostos, e
              dizer só "tudo certo" esconderia a segunda: ou nada falhou, ou nunca
              fechou uma venda vinda de anúncio. Quem acabou de conectar precisa
              saber que a lista vazia ainda não prova que funciona.
            */}
            {t("Nenhuma pendência. Ou tudo que veio de anúncio foi reportado, ou ainda não fechou nenhuma venda com origem em anúncio.")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Negócio")}</th>
                  <th className="p-3 font-medium">{t("Valor")}</th>
                  <th className="p-3 font-medium">{t("O que houve")}</th>
                  <th className="p-3 font-medium">{t("Quando")}</th>
                </tr>
              </thead>
              <tbody>
                {pendencias.map((p) => (
                  <tr key={p.leadId} className="border-t align-top">
                    <td className="p-3">
                      <a className="underline underline-offset-2" href={`/app/kanban?lead=${p.leadId}`}>
                        {p.tituloDoLead ?? t("(sem título)")}
                      </a>
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {p.valorCentavos === null ? "—" : formatCentsBRL(p.valorCentavos)}
                    </td>
                    <td className="p-3">
                      <span>{t(MOTIVO_LEGIVEL[p.motivo ?? ""] ?? p.motivo ?? "—")}</span>
                      {p.detalhe && (
                        <span className="mt-1 block text-xs text-muted-foreground">{p.detalhe}</span>
                      )}
                    </td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(p.tentadoEm).toLocaleString(idioma)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";

import { LinhaDoRecurso } from "@/components/recursos-opcionais/LinhaDoRecurso";
import { loadAuthUser } from "@/lib/auth/server";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { MODULOS_AINDA_NAO_LIGAVEIS, MODULOS_OPCIONAIS_POR_FLAG, modulosLigados, type ModuloOpcional } from "@/lib/instalacao/modulos";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  RECURSOS_OPCIONAIS,
  ROTULO_DO_ESTADO,
  estadoDoRecurso,
  type EstadoDoRecurso,
} from "@/lib/recursos-opcionais/catalogo";
import { detectarServidor } from "@/lib/recursos-opcionais/estado";

import { FormularioDeComportamento, FormularioDeModulos } from "./_form";

export const metadata = { title: "Recursos opcionais" };

/** Para o que depende do servidor, a voz é "configurado", não "ligado". */
const ROTULO_NO_SERVIDOR: Record<EstadoDoRecurso, string> = {
  ...ROTULO_DO_ESTADO,
  ligado: "Configurado",
  desligado: "Não configurado",
  nao_verificado: "Não dá para ver daqui",
};
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação decide COMO ela se comporta, sem SSH.
 *
 * ── O defeito que ela fecha (issue #1034) ───────────────────────────────────
 *
 * As chaves que decidem o comportamento de uma instalação JÁ EM OPERAÇÃO — o
 * kill switch do orçamento de IA, a exigência de assinatura no webhook do
 * canal, o modo do portão de divulgação e a camada semântica de promessa — só
 * existiam no `.env`: quem instalou a VPS era o único que conseguia mudá-las,
 * por SSH. É a decisão de produto escondida atrás de infraestrutura.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO inteira, não uma empresa. Num revendedor que hospeda
 * várias organizações, deixar o admin de um tenant desligar o bloqueio de gasto
 * mudaria o comportamento de TODOS os clientes daquele servidor. Mesmo
 * argumento de `/admin/cadastro`, `/admin/marca` e `/admin/google` — esta tela
 * é irmã das três, e usa o mesmo `traduzir`/`_form` das irmãs.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/cadastro`.
 *
 * ── Por que ela virou "Recursos opcionais" (doc 80) ─────────────────────────
 *
 * Os módulos se ligavam aqui, e a porta se chamava "Comportamento": o
 * mantenedor procurou onde ligar recursos e não achou. Agora são três blocos —
 * Módulos, Comportamento e o que Depende do servidor (só leitura, detectado
 * pelos mesmos leitores das telas de cada recurso). Os dois primeiros continuam
 * gravando pelos formulários de sempre; a lista de recursos é
 * `lib/recursos-opcionais/catalogo.ts`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const idioma = usuario.idioma;

  // O valor EFETIVO (linha acima, `.env` como piso): a tela mostra o que está
  // valendo de verdade, e não o que a linha diria se ela existisse.
  const admin = createAdminClient();
  const [comportamento, ligados, servidor] = await Promise.all([
    carregarComportamentoDaInstalacao(),
    modulosLigados(admin),
    detectarServidor(),
  ]);
  // Spec da cobrança §7(h): o aviso de quantas o desligar libera só existe com ela ligada.
  const suspensasPorCobranca = ligados.includes("cobranca") ? await contarSuspensasPorCobranca(admin) : 0;
  // Módulo que ainda não se liga nesta versão só aparece se já estiver ligado
  // (pelo banco): dá para desligar, e quem nunca ligou não vê interruptor que recusa.
  const escondidos = MODULOS_AINDA_NAO_LIGAVEIS.filter((m) => !ligados.includes(m));
  const fontes = { modulos: ligados, settings: null, servidor };

  // Os módulos que NÃO se ligam por interruptor aqui (módulo de tabela, ADR-0002)
  // aparecem com o caminho de onde se instalam — saem do catálogo, sem lista escrita.
  const modulosDeOutraTela = RECURSOS_OPCIONAIS.filter(
    (r) =>
      r.nivel === "instalacao" &&
      r.modulo &&
      !(MODULOS_OPCIONAIS_POR_FLAG as readonly ModuloOpcional[]).includes(r.modulo),
  );
  const outrasChaves = RECURSOS_OPCIONAIS.filter(
    (r) => r.nivel === "instalacao" && !r.modulo && r.href !== "/admin/sistema",
  );
  const doServidor = RECURSOS_OPCIONAIS.filter((r) => r.nivel === "servidor");

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Recursos opcionais", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Tudo o que se liga e desliga nesta instalação, num lugar só. Vale para todas as empresas hospedadas aqui.",
            idioma,
          )}
        </p>
      </div>

      <section className="space-y-3" aria-labelledby="bloco-modulos">
        <h2 id="bloco-modulos" className="text-lg font-semibold">
          {traduzir("Módulos", idioma)}
        </h2>
        <FormularioDeModulos ligados={ligados} escondidos={escondidos} suspensasPorCobranca={suspensasPorCobranca} />
        {modulosDeOutraTela.length > 0 && (
          <ul className="space-y-3">
            {modulosDeOutraTela.map((r) => {
              const estado = estadoDoRecurso(r, fontes);
              return (
                <LinhaDoRecurso
                  key={r.id}
                  recurso={r}
                  estado={estado}
                  rotuloDoEstado={traduzir(ROTULO_DO_ESTADO[estado], idioma)}
                  ajustar={r.href}
                  idioma={idioma}
                />
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="bloco-comportamento">
        <h2 id="bloco-comportamento" className="text-lg font-semibold">
          {traduzir("Comportamento", idioma)}
        </h2>
        <FormularioDeComportamento inicial={comportamento} />
        <ul className="space-y-3">
          {outrasChaves.map((r) => (
            <LinhaDoRecurso
              key={r.id}
              recurso={r}
              estado="nao_verificado"
              rotuloDoEstado={traduzir("Veja na tela dele", idioma)}
              ajustar={r.href}
              idioma={idioma}
            />
          ))}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="bloco-servidor">
        <div className="space-y-1">
          <h2 id="bloco-servidor" className="text-lg font-semibold">
            {traduzir("Depende do servidor", idioma)}
          </h2>
          <p className="text-sm text-muted-foreground">
            {traduzir(
              "Só leitura. Estes dependem de credencial ou do arquivo de ambiente do servidor. Nenhum valor de segredo aparece aqui.",
              idioma,
            )}
          </p>
        </div>
        <ul className="space-y-3">
          {doServidor.map((r) => {
            const estado = estadoDoRecurso(r, fontes);
            return (
              <LinhaDoRecurso
                key={r.id}
                recurso={r}
                estado={estado}
                rotuloDoEstado={traduzir(ROTULO_NO_SERVIDOR[estado], idioma)}
                ajustar={r.href}
                idioma={idioma}
              />
            );
          })}
        </ul>
      </section>
    </div>
  );
}

const SUSPENSA_POR_COBRANCA: TipoDeSuspensao = "cobranca";

/** Quantas empresas estão suspensas por falta de pagamento. `null` = a leitura falhou: a tela não afirma número que não leu. */
async function contarSuspensasPorCobranca(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("status", "suspended")
    .eq("suspended_kind", SUSPENSA_POR_COBRANCA);
  return error ? null : (count ?? 0);
}

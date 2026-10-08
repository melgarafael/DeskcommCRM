/**
 * Configurações › Sua empresa › Recursos opcionais.
 *
 * A TELA QUE FALTAVA (pedido do mantenedor, doc 73; desenho no doc 80): tudo o
 * que esta empresa pode ligar, num lugar só, com o estado e um botão que leva à
 * tela onde a chave mora. Antes, cada chave vivia perto do assunto dela, em pelo
 * menos nove telas, e ninguém sabia que existia.
 *
 * SÓ LEITURA, de propósito: ligar daqui criaria um segundo caminho de escrita
 * para a mesma chave. Quem liga continua sendo a tela do assunto.
 *
 * Gate = manager+. O admin vê tudo com "Ajustar"; o gerente vê a lista inteira,
 * mas só ganha o botão onde a tela de destino o aceita — link que morre em /403
 * ensina a não clicar. Atendente e leitor não veem: não decidem nada daqui.
 */
import { redirect } from "next/navigation";

import { LinhaDoRecurso } from "@/components/recursos-opcionais/LinhaDoRecurso";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  MODULOS_DA_EMPRESA,
  RECURSOS_OPCIONAIS,
  ROTULO_DO_ESTADO,
  estadoDoRecurso,
  portaDoModuloNaEmpresa,
  type RecursoOpcional,
} from "@/lib/recursos-opcionais/catalogo";
import { fontesDaEmpresa } from "@/lib/recursos-opcionais/estado";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recursos opcionais" };

const PAPEL_QUE_DECIDE: Record<Exclude<RecursoOpcional["quemDecide"], "dono_do_servidor">, Role> = {
  admin: "admin",
  manager: "manager",
};

export default async function RecursosOpcionaisPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const dono = user.is_platform_admin && !user.support;
  if (!dono && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const idioma = user.idioma;
  // Admin client: `platform_config` não tem policy. O id da organização vem da sessão.
  const fontes = await fontesDaEmpresa(createAdminClient(), activeOrg.orgId);
  const podeAbrir = (r: RecursoOpcional): boolean =>
    dono ||
    (r.quemDecide !== "dono_do_servidor" && ROLE_RANK[activeOrg.role] >= ROLE_RANK[PAPEL_QUE_DECIDE[r.quemDecide]]);

  const modulos = MODULOS_DA_EMPRESA;
  const daEmpresa = RECURSOS_OPCIONAIS.filter((r) => r.nivel === "organizacao");
  const deCadaAgente = RECURSOS_OPCIONAIS.filter((r) => r.nivel === "agente");

  /** Recurso que depende de módulo desligado no servidor: a empresa sabe que existe e a quem pedir. */
  const semModulo = (r: RecursoOpcional): boolean =>
    !!r.modulo && fontes.modulos !== null && !fontes.modulos.includes(r.modulo);

  const linha = (r: RecursoOpcional) => {
    const estado = estadoDoRecurso(r, fontes);
    const rotulo = semModulo(r)
      ? traduzir("Desligado por quem administra o servidor", idioma)
      : traduzir(ROTULO_DO_ESTADO[estado], idioma);
    return (
      <LinhaDoRecurso
        key={r.id}
        recurso={r}
        estado={estado}
        rotuloDoEstado={rotulo}
        ajustar={!semModulo(r) && r.href && podeAbrir(r) ? r.href : null}
        idioma={idioma}
      />
    );
  };

  return (
    <div className="flex h-full flex-col gap-8 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Recursos opcionais", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Tudo o que se liga e desliga, num lugar só. Cada recurso continua sendo ligado na tela dele: o botão Ajustar leva até lá.",
            idioma,
          )}
        </p>
      </header>

      <section className="space-y-3" aria-labelledby="recursos-modulos">
        <div className="space-y-1">
          <h2 id="recursos-modulos" className="text-lg font-semibold">
            {traduzir("Módulos desta instalação", idioma)}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {traduzir(
              "Quem administra o servidor decide se eles existem aqui. Desligado, peça a essa pessoa.",
              idioma,
            )}
          </p>
        </div>
        <ul className="space-y-3">
          {modulos.map((r) => {
            const estado = estadoDoRecurso(r, fontes);
            const porta = r.modulo ? portaDoModuloNaEmpresa(r.modulo) : null;
            return (
              <LinhaDoRecurso
                key={r.id}
                recurso={r}
                estado={estado}
                rotuloDoEstado={
                  estado === "ligado"
                    ? traduzir("Disponível nesta instalação", idioma)
                    : estado === "desligado"
                      ? traduzir("Desligado por quem administra o servidor", idioma)
                      : traduzir(ROTULO_DO_ESTADO[estado], idioma)
                }
                ajustar={
                  estado === "ligado" && porta && (dono || ROLE_RANK[activeOrg.role] >= ROLE_RANK[porta.minRole ?? "viewer"])
                    ? porta.href
                    : null
                }
                idioma={idioma}
              />
            );
          })}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="recursos-empresa">
        <h2 id="recursos-empresa" className="text-lg font-semibold">
          {traduzir("Da sua empresa", idioma)}
        </h2>
        <ul className="space-y-3">{daEmpresa.map(linha)}</ul>
      </section>

      <section className="space-y-3" aria-labelledby="recursos-agente">
        <div className="space-y-1">
          <h2 id="recursos-agente" className="text-lg font-semibold">
            {traduzir("Em cada agente", idioma)}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {traduzir("Estes se ligam em cada agente, em Agente de IA › Agentes.", idioma)}
          </p>
        </div>
        <ul className="space-y-3">{deCadaAgente.map(linha)}</ul>
      </section>
    </div>
  );
}

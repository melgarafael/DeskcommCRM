"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ArrowRight, Check, Plus, Sparkle } from "@/lib/ui/icons";
import {
  EMPLOYEE_ROLE_PRESETS,
  type EmployeeDepartment,
  employeeRoleFromConfig,
} from "@/lib/ai/agents/employee-roles";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { useT } from "@/hooks/i18n/useT";

const DEPARTMENTS: readonly EmployeeDepartment[] = ["Comercial", "Relacionamento", "Operações"];

const DEPARTMENT_STYLE: Record<EmployeeDepartment, string> = {
  Comercial: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20",
  Relacionamento: "bg-violet-500/10 text-violet-300 ring-violet-400/20",
  Operações: "bg-sky-500/10 text-sky-300 ring-sky-400/20",
};

interface Props {
  agents: AgentRow[];
  canWrite: boolean;
}

export function EmployeeRoleCatalog({ agents, canWrite }: Props) {
  const t = useT();
  const countByRole = new Map<string, number>();
  for (const agent of agents) {
    const role = employeeRoleFromConfig(agent.config);
    if (role) countByRole.set(role.id, (countByRole.get(role.id) ?? 0) + 1);
  }

  return (
    <section aria-labelledby="catalogo-funcoes" className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-primary uppercase ring-1 ring-primary/20">
            <Sparkle size={12} weight="fill" aria-hidden /> {t("Equipe pronta para montar")}
          </div>
          <h2 id="catalogo-funcoes" className="text-xl font-semibold tracking-tight">
            {t("Contrate por função")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t(
              "Cada funcionário começa com missão, limites e linguagem da função. Você revisa o treinamento, escolhe o número e publica quando estiver pronto.",
            )}
          </p>
        </div>
      </div>

      <div className="space-y-7">
        {DEPARTMENTS.map((department) => {
          const roles = EMPLOYEE_ROLE_PRESETS.filter((role) => role.department === department);
          return (
            <div key={department} className="space-y-3">
              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className={`rounded-full border-0 px-3 py-1 text-[10px] tracking-[0.16em] uppercase ring-1 ${DEPARTMENT_STYLE[department]}`}
                >
                  {t(department)}
                </Badge>
                <div className="h-px flex-1 bg-gradient-to-r from-border/80 to-transparent" />
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {roles.map((role) => {
                  const count = countByRole.get(role.id) ?? 0;
                  return (
                    <article
                      key={role.id}
                      className="group rounded-[1.45rem] bg-foreground/[0.035] p-1.5 ring-1 ring-foreground/[0.06] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5"
                    >
                      <div className="flex h-full min-h-64 flex-col rounded-[1.15rem] bg-card p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                              {t(role.eyebrow)}
                            </p>
                            <h3 className="mt-2 text-2xl font-semibold tracking-tight">
                              {t(role.title)}
                            </h3>
                          </div>
                          {count > 0 ? (
                            <span className="inline-flex size-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-400/20">
                              <Check
                                size={15}
                                weight="bold"
                                aria-label={`${count} ${t("contratado")}`}
                              />
                            </span>
                          ) : (
                            <span className="inline-flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                              <Plus size={15} aria-hidden />
                            </span>
                          )}
                        </div>

                        <p className="mt-3 text-sm leading-6 text-muted-foreground">
                          {t(role.description)}
                        </p>
                        <p className="mt-4 text-xs leading-5 text-foreground/80">
                          {t(role.mission)}
                        </p>

                        <div className="mt-auto flex items-end justify-between gap-3 pt-5">
                          <span className="text-xs text-muted-foreground">
                            {count === 0 ? t("Ainda não contratado") : `${count} ${t("na equipe")}`}
                          </span>
                          {canWrite ? (
                            <Link
                              href={`/app/ai/agents/new?cargo=${role.id}`}
                              className="group/button inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-xs font-semibold text-background transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98]"
                            >
                              {count > 0 ? t("Adicionar outro") : t("Contratar")}
                              <span className="inline-flex size-6 items-center justify-center rounded-full bg-background/15 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover/button:translate-x-0.5">
                                <ArrowRight size={12} aria-hidden />
                              </span>
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

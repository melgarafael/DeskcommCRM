"use server";

/**
 * Lista, para o EDITOR do agente, as ferramentas que o servidor MCP externo da
 * organização anuncia — no formato pronto para virar `tool_ids` (#2147, item 6).
 *
 * ── Por que esta função existe ──────────────────────────────────────────────
 *
 * Um `tool_ids` remoto só é escolhível se alguém conseguir listar o que existe
 * lá fora: sem isto, o editor só teria um campo de texto e o administrador
 * teria de decorar nomes de tool de um sistema alheio.
 *
 * ── Por quem passa ──────────────────────────────────────────────────────────
 *
 * Pela MESMA regra de quem cadastra (`regraPlatformAdmin`), por duas razões: a
 * lista entrega o host do endpoint e os nomes de tool do ERP — dado do dono da
 * instalação, não da empresa —, e cada organização enxerga só o registro da
 * própria linha. O `endpoint` volta SÓ como host, a mesma régua da trilha de
 * auditoria (item 5): endereço inteiro não sai daqui.
 *
 * ── Por que um tool_id carrega a MARCA ──────────────────────────────────────
 *
 * O `id` de cada opção traz `leitura`/`escrita` porque é o ID que vai para o
 * `tool_ids` — a marca é metade do que decide a categoria da ferramenta no
 * turno (item 8). A outra metade é `annotations.readOnlyHint`, e só quando as
 * duas batem a remota é lida durante conversa; por isso a opção `leitura` só
 * aparece para ferramenta que o servidor DECLAROU, e a marca final é sempre do
 * administrador, nunca do servidor remoto.
 */
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { regraPlatformAdmin } from "@/lib/extensions/http";
import { supportWriteError } from "@/lib/impersonate/support";
import { carregarServidorMcpExterno } from "@/lib/mcp/servidor-externo/carregar";
import { toolIdRemoto, type MarcaRemota } from "@/lib/mcp/servidor-externo/ids";
import { hostDoEndpoint } from "@/lib/mcp/servidor-externo/registro";
import { createAdminClient } from "@/lib/supabase/admin";

/** Uma ferramenta anunciada, com os `tool_id`s que o administrador pode marcar. */
export interface OpcaoRemotaParaOEditor {
  /** Nome da tool no servidor remoto. */
  nome: string;
  descricao: string | null;
  /** Os ids prontos para o `tool_ids` — um por marca aceita. */
  ids: string[];
  /** Se o servidor DECLAROU `annotations.readOnlyHint === true`. */
  declaradaLeitura: boolean;
}

export type ResultadoDaListagem =
  | { ok: true; host: string; ferramentas: OpcaoRemotaParaOEditor[] }
  | {
      ok: false;
      error:
        | "unauthenticated"
        | "forbidden_role"
        | "upstream_unavailable"
        | "mfa_required"
        | "forbidden_tenant"
        | "sem_servidor";
    };

export async function listarFerramentasMcpExternas(): Promise<ResultadoDaListagem> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // Mesma barreira de suporte das actions de escrita desta pasta: a lista
  // devolve o host do endpoint e nomes de tool do ERP, que são dado do dono da
  // instalação — dado que uma sessão emprestada não existe para enxergar.
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };

  const regra = await regraPlatformAdmin(user);
  if (!regra.ok) {
    return {
      ok: false,
      error:
        regra.codigo === "upstream_unavailable"
          ? "upstream_unavailable"
          : regra.codigo === "mfa_required"
            ? "mfa_required"
            : "forbidden_role",
    };
  }

  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };

  // `null` cobre os três motivos de não haver o que listar: sem registro, turno
  // com contato (que não é o caso aqui) e servidor que não respondeu.
  const montado = await carregarServidorMcpExterno(createAdminClient(), org.orgId);
  if (!montado) return { ok: false, error: "sem_servidor" };

  const ferramentas = montado.ferramentas.map((ferramenta) => {
    const declarada = ferramenta.somenteLeitura === true;
    // Só a ferramenta DECLARADA pode nascer marcada como leitura; a que não
    // declarou só admite a marca `escrita`. O inverso (recusar a marca `escrita`
    // de quem declarou leitura) seria tirar do administrador o direito de não
    // confiar na declaração de um sistema alheio.
    const marcas: MarcaRemota[] = declarada ? ["leitura", "escrita"] : ["escrita"];
    return {
      nome: ferramenta.name,
      descricao: ferramenta.description ?? null,
      ids: marcas.map((marca) => toolIdRemoto(ferramenta.name, marca)),
      declaradaLeitura: declarada,
    };
  });

  return { ok: true, host: hostDoEndpoint(montado.servidor.endpoint), ferramentas };
}

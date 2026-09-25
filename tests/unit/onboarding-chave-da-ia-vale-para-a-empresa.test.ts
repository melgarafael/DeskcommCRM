/**
 * A IA QUE A PESSOA ESCOLHE NO PASSO DA CHAVE PASSA A VALER PARA A EMPRESA.
 *
 * ─── A DECISÃO, E POR QUE ELA MORA AQUI ────────────────────────────────────
 *
 * Decisão do dono do produto sobre a #1007: quem escolhe um provedor no
 * onboarding e cola a chave dele está respondendo "qual inteligência artificial
 * vai atender seus clientes" — e a resposta vale para a ORGANIZAÇÃO INTEIRA
 * (`organizations.settings.llm`), não só para o atendente que nasce ali.
 *
 * O passo que grava isso é `salvarChaveDaIa` (`app/actions/onboarding/chaveDaIa.ts`),
 * porque é nele que a escolha é feita. Sem essa gravação o produto mentia duas
 * vezes, e as duas aparecem na issue: o atendente nascia em rascunho pedindo
 * chave de um provedor que ninguém escolheu, e a prova de crédito da própria
 * tela (`_inteligencia.tsx`, via `lib/instalacao/retrato.ts`) procurava a chave
 * no provedor da EMPRESA — sobre uma chave que funcionava.
 *
 * ─── O QUE ESTE ARQUIVO MEDE, E O QUE ELE NÃO MEDE ─────────────────────────
 *
 * Mede a ESCRITA: o par provedor+modelo gravado, no lugar certo do jsonb, pelo
 * client certo, com o `organization_id` da sessão — e o comportamento honesto
 * quando o par não pode ser formado (catálogo vazio), que é o estado de uma
 * instalação nova.
 *
 * Não mede a credencial: `guardarCredencial` é substituída por um dublê porque
 * o miolo dela (cifrar, gravar, auditar, validar a chave no provedor) tem
 * cobertura própria e a validação faz uma chamada de REDE real — que é justa-
 * mente o que não pode entrar aqui. O que está sob teste é a orquestração do
 * passo, não a cifra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Consulta {
  table: string;
  op: "select" | "update";
  payload: Record<string, unknown> | null;
  filtros: Record<string, unknown>;
  colunas: string;
}
type ErroDb = { code?: string; message: string } | null;
interface Resposta {
  data: unknown;
  error: ErroDb;
}

const ORG = "22222222-2222-4222-8222-222222222222";
/** A organização "de outro cliente", que o corpo do formulário não pode alcançar. */
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";

let responder: (c: Consulta) => Resposta;
/** Toda UPDATE que o passo mandou — é sobre isto que as asserções falam. */
let escritas: { orgId: string; settings: Record<string, unknown> }[] = [];
/** O org id que o `.eq("id", …)` do UPDATE recebeu. */
let orgIdAtualizado: string | null = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, email: "dono@qa.local", full_name: "Dono" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: "admin" })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso() }));
/**
 * ⚠️ O CLIENT DE SESSÃO NÃO ENTRA, E AQUI ISSO É MEDIDO EM VEZ DE COMENTADO.
 *
 * A única policy de escrita de `organizations` é `orgs_write_platform_admin`:
 * um UPDATE pelo client do usuário casa ZERO linhas para o admin do próprio
 * tenant e o PostgREST devolve SUCESSO — o passo diria "gravado" sem nada
 * gravado. Um dublê que simplesmente não fosse usado não guardaria nada; este
 * LANÇA, então trocar a implementação para o client de sessão deixa o teste
 * vermelho no lugar de deixá-lo verde por vacuidade.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    throw new Error(
      "o passo NÃO pode gravar em `organizations` pelo client de sessão (policy orgs_write_platform_admin)",
    );
  },
}));
vi.mock("@/lib/ai/credenciais/guardar", () => ({
  guardarCredencial: vi.fn(async () => ({ ok: true, id: "cred-1", last4: "7193" })),
}));

import { salvarChaveDaIa } from "@/app/actions/onboarding/chaveDaIa";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";

/** Construtor de consulta no formato do PostgREST: encadeável, thenable. */
function clienteFalso() {
  const abrir = (table: string) => {
    const c: Consulta = { table, op: "select", payload: null, filtros: {}, colunas: "" };
    const resolver = () => Promise.resolve(responder(c));
    const b = {
      select: (colunas?: string) => {
        if (typeof colunas === "string") c.colunas = colunas;
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        c.op = "update";
        c.payload = payload;
        return b;
      },
      eq: (coluna: string, valor: unknown) => {
        c.filtros[coluna] = valor;
        return b;
      },
      is: (coluna: string, valor: unknown) => {
        c.filtros[`is:${coluna}`] = valor;
        return b;
      },
      limit: () => b,
      single: () => resolver(),
      maybeSingle: () => resolver(),
      then: (ok: (r: Resposta) => unknown, no?: (e: unknown) => unknown) => resolver().then(ok, no),
    };
    return b;
  };
  return { from: abrir } as never;
}

interface Mundo {
  /** O modelo curado (`is_default_for_provider`) de cada provedor. */
  modelosPorProvedor?: Record<string, string>;
  /** O `settings` que a organização já tinha antes do passo. */
  settings?: Record<string, unknown> | null;
  /** Erro na leitura do settings. */
  erroLeitura?: ErroDb;
  /** A UPDATE casa zero linhas (o modo de falha mudo do PostgREST). */
  escritaCasaZeroLinhas?: boolean;
}

function montarBanco(mundo: Mundo = {}) {
  const modelos = mundo.modelosPorProvedor ?? { anthropic: "claude-sonnet-5" };
  const settingsAtuais = mundo.settings === undefined ? { llm: { provider: "anthropic", default_model: "claude-sonnet-5" } } : mundo.settings;

  responder = (c) => {
    if (c.table === "ai_models") {
      const provider = String(c.filtros.provider ?? "");
      const modelId = modelos[provider];
      // Consciente do filtro, de propósito: um dublê que devolvesse o MESMO
      // modelo para qualquer provedor faria um par emprestado pela metade
      // passar verde — que é o defeito que este arquivo existe para pegar.
      return {
        data: modelId
          ? [
              {
                model_id: modelId,
                is_default_for_provider: true,
                supports_tools: true,
                input_price_per_million_cents: 150,
                output_price_per_million_cents: 600,
              },
            ]
          : [],
        error: null,
      };
    }

    if (c.table === "organizations") {
      if (c.op === "update") {
        const orgId = String(c.filtros.id ?? "");
        orgIdAtualizado = orgId;
        const settings = (c.payload?.settings ?? {}) as Record<string, unknown>;
        if (mundo.escritaCasaZeroLinhas) return { data: null, error: null };
        escritas.push({ orgId, settings });
        return { data: { settings }, error: null };
      }
      if (mundo.erroLeitura) return { data: null, error: mundo.erroLeitura };
      return { data: { settings: settingsAtuais }, error: null };
    }

    throw new Error(`tabela não dublada no teste: ${c.table}`);
  };
}

function formulario(campos: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("provider", "openai");
  fd.set("api_key", "sk-de-teste-1234567");
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  escritas = [];
  orgIdAtualizado = null;
  (guardarCredencial as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    ok: true,
    id: "cred-1",
    last4: "7193",
  });
});

describe("onboarding: a IA escolhida no passo da chave vale para a empresa inteira", () => {
  it("#1007: colar a chave da OpenAI grava o PAR — provedor e o modelo do catálogo DELE", async () => {
    // O defeito de origem: a escolha ficava só na credencial, e a empresa
    // continuava com o `anthropic` semeado pelo gatilho do banco. Todo ponto de
    // IA sem escolha própria seguia o padrão da empresa — inclusive a prova de
    // crédito da tela, que procurava chave da Anthropic sobre uma chave da
    // OpenAI que funcionava.
    montarBanco({ modelosPorProvedor: { anthropic: "claude-sonnet-5", openai: "gpt-5-mini" } });

    const r = await salvarChaveDaIa(formulario());

    expect(r.ok).toBe(true);
    expect(escritas).toHaveLength(1);
    // ⚠️ O PAR, não só o provedor. `{ provider: "openai" }` sozinho deixaria o
    // `default_model` da Anthropic no lugar — um id que o endpoint da OpenAI não
    // conhece, e o atendente responderia texto plausível sem criar negócio.
    expect(escritas[0]!.settings.llm).toEqual({
      provider: "openai",
      default_model: "gpt-5-mini",
    });
    expect(r.ok && r.padrao).toEqual({ provider: "openai", modelo: "gpt-5-mini" });
  });

  it("o modelo sai do catálogo do provedor escolhido, não do que já estava no settings", async () => {
    // O gatilho `fn_seed_org_llm_defaults` semeia o curado da Anthropic. Quem
    // "aproveitasse" esse `default_model` mandaria `claude-sonnet-5` ao endpoint
    // da OpenAI — o par emprestado pela metade que o corpo do PR já descrevia.
    montarBanco({
      settings: { llm: { provider: "anthropic", default_model: "claude-sonnet-5" } },
      modelosPorProvedor: { anthropic: "claude-sonnet-5", openai: "gpt-5-mini" },
    });

    await salvarChaveDaIa(formulario());

    const llm = escritas[0]!.settings.llm as Record<string, unknown>;
    expect(llm.default_model).toBe("gpt-5-mini");
    expect(llm.default_model).not.toBe("claude-sonnet-5");
  });

  it("não sobrescreve o resto do settings nem o resto do llm — é MERGE nos dois níveis", async () => {
    // `settings` é jsonb compartilhado: marca, política de MFA e o estado do
    // wizard moram no mesmo objeto, e `params`/`enabled_models` dentro de `llm`
    // são lidos pelo turno (`lib/agent-engine/edge/llm/credentials.ts`). Um
    // update ingênuo apaga tudo isso em silêncio, e o sintoma aparece dias
    // depois, longe daqui.
    montarBanco({
      settings: {
        branding: { accent_hex: "#112233" },
        security: { mfa_required: true },
        onboarding_state: { step: "ai" },
        llm: {
          provider: "anthropic",
          default_model: "claude-sonnet-5",
          params: { temperature: 0.2 },
          enabled_models: ["gpt-5-mini"],
        },
      },
      modelosPorProvedor: { anthropic: "claude-sonnet-5", openai: "gpt-5-mini" },
    });

    await salvarChaveDaIa(formulario());

    const s = escritas[0]!.settings;
    expect(s.branding).toEqual({ accent_hex: "#112233" });
    expect(s.security).toEqual({ mfa_required: true });
    expect(s.onboarding_state).toEqual({ step: "ai" });
    expect(s.llm).toEqual({
      provider: "openai",
      default_model: "gpt-5-mini",
      params: { temperature: 0.2 },
      enabled_models: ["gpt-5-mini"],
    });
  });

  it("grava na organização da SESSÃO: o `organization_id` do corpo é ignorado", async () => {
    // O client é o admin (service role) e passa por cima da RLS: o `.eq("id", …)`
    // é a ÚNICA cerca entre "mudei a IA da minha empresa" e "mudei a de toda
    // instalação". O id vem de `requireOnboardingCtx` (cookie de sessão), nunca
    // do formulário — que é justamente por onde ele chegaria de outra empresa.
    montarBanco({ modelosPorProvedor: { anthropic: "claude-sonnet-5", openai: "gpt-5-mini" } });

    await salvarChaveDaIa(formulario({ organization_id: OUTRA_ORG, org_id: OUTRA_ORG }));

    expect(orgIdAtualizado).toBe(ORG);
    expect(escritas.map((e) => e.orgId)).toEqual([ORG]);
  });

  it("catálogo do provedor escolhido VAZIO: não troca o provedor pela metade — e a tela diz por quê", async () => {
    // O estado de uma instalação nova: a OpenRouter chega com ZERO linhas até o
    // cron do catálogo rodar. Gravar `provider: "openrouter"` sem modelo (ou
    // inventar um id) entregaria o pior desfecho do produto. A chave fica salva
    // — o passo não vira erro por causa do padrão da empresa — e a pessoa
    // recebe o motivo, em vez de achar que a IA da empresa mudou.
    montarBanco({ modelosPorProvedor: { anthropic: "claude-sonnet-5" } });

    const r = await salvarChaveDaIa(formulario({ provider: "openrouter" }));

    expect(r.ok).toBe(true);
    expect(escritas).toHaveLength(0);
    expect(r.ok && r.padrao).toBeNull();
    expect(r.ok && r.aviso).toBe("sem_modelo_no_catalogo");
    // A chave continua salva: o desfecho principal não é perdido pelo segundo.
    expect(r.ok && r.final).toBe("7193");
    expect(guardarCredencial).toHaveBeenCalledTimes(1);
  });

  it("falha nossa ao gravar: a chave segue salva e a tela recebe o aviso, não o silêncio", async () => {
    // Zero linhas no PostgREST volta como SUCESSO. Sem a conferência, o passo
    // diria "gravado" para uma escrita que não aconteceu — a falha-em-verde que
    // este repo trata como o pior defeito.
    montarBanco({
      modelosPorProvedor: { anthropic: "claude-sonnet-5", openai: "gpt-5-mini" },
      escritaCasaZeroLinhas: true,
    });

    const r = await salvarChaveDaIa(formulario());

    expect(r.ok).toBe(true);
    expect(r.ok && r.padrao).toBeNull();
    expect(r.ok && r.aviso).toBe("nao_gravou");
  });

  it("a chave do Jev NÃO vira a IA da empresa: ele decide, não conversa", async () => {
    // O passo responde "qual IA vai atender seus clientes" e grava o padrão da
    // empresa inteira. O Jev tem chave, mas não escreve: aceito aqui, todo
    // ponto sem escolha própria passaria a pedir texto a quem só devolve nota.
    montarBanco();

    const r = await salvarChaveDaIa(formulario({ provider: "typesafe", api_key: "apikey_de_teste_1234567" }));

    expect(r.ok).toBe(false);
    expect(guardarCredencial).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });
});

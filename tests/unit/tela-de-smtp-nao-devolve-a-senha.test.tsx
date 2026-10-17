/**
 * A TELA DE SMTP NÃO DEVOLVE A SENHA AO NAVEGADOR.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * `getSmtpConfig()` decifra a senha porque o TRANSPORTE precisa dela no servidor
 * para autenticar. A TELA não precisa: para desenhar o campo basta saber que
 * existe uma senha gravada. Então é isso, e só isso, que atravessa a fronteira —
 * a mesma disciplina de `temSegredoSalvo` em `/admin/google` e `/admin/meta`.
 *
 * ─── Por que a asserção não é "o campo está vazio" ──────────────────────────
 *
 * Porque o campo está vazio dos dois jeitos: o que a tela DESENHA e o que ela
 * RECEBE são coisas diferentes, e props de componente de cliente viajam no
 * payload do RSC quer apareçam na tela, quer não. Conferir o desenho seria medir
 * a coisa errada. Por isso a asserção varre o payload inteiro das props e
 * procura o valor.
 *
 * Sabotagem que confirma que a guarda vigia: fazer `page.tsx` passar a senha
 * como prop (sozinha ou dentro do objeto de configuração) deixa o caso ⭐
 * vermelho. Medido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const SENHA_EM_CLARO = "senha-do-smtp-que-nao-pode-vazar";

let usuario: { is_platform_admin: boolean; idioma: "pt-BR" } | null = null;
let config: Record<string, unknown>;

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => usuario }));
// `importOriginal` de propósito: a action de salvar importa constantes do MESMO
// módulo, e um mock que só devolve `getSmtpConfig` apaga os outros exports
// (issue #2804 quebrou esta tela exatamente assim, no CI).
vi.mock("@/lib/email/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/config")>()),
  getSmtpConfig: async () => config,
}));
// O roteador é real; o que se mocka é a única fonte que ele consulta (acima) e
// a Resend, para o caso de "nenhum dos dois" não depender do `.env` da máquina.
let resendLigada = false;
vi.mock("@/lib/email/resend", () => ({
  isEmailConfigured: () => resendLigada,
  sendEmail: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import Page from "@/app/admin/(protected)/email/page";
import { FormularioDeSmtp } from "@/app/admin/(protected)/email/_form";

beforeEach(() => {
  usuario = { is_platform_admin: true, idioma: "pt-BR" };
  resendLigada = false;
  config = {
    host: "smtp.revenda.com.br",
    port: 587,
    security: "starttls",
    username: "nao-responda@revenda.com.br",
    password: SENHA_EM_CLARO,
    fromEmail: "nao-responda@revenda.com.br",
    fromName: "Vendas Turbo",
    source: "database",
  };
});

afterEach(cleanup);

type Props = Parameters<typeof FormularioDeSmtp>[0];

async function propsDaPagina(): Promise<Props> {
  const elemento = (await Page()) as unknown as { type: unknown; props: Props };
  expect(elemento.type).toBe(FormularioDeSmtp);
  return elemento.props;
}

describe("/admin/email — o que a página entrega ao navegador", () => {
  it("⭐ com senha gravada, a senha NÃO atravessa — só o fato de existir", async () => {
    const props = await propsDaPagina();

    expect(JSON.stringify(props), "a página entregou a senha do SMTP ao navegador").not.toContain(
      SENHA_EM_CLARO,
    );
    expect(props).toMatchObject({
      temSenhaSalva: true,
      host: "smtp.revenda.com.br",
      remetente: "nao-responda@revenda.com.br",
      origem: "database",
      transporte: "smtp",
    });
  });

  it("instalação que nunca configurou: sem senha, e o SMTP não está em vigor", async () => {
    config = {
      host: "",
      port: 587,
      security: "starttls",
      username: "",
      password: "",
      fromEmail: "",
      fromName: "",
      source: "none",
    };

    const props = await propsDaPagina();

    expect(props).toMatchObject({ temSenhaSalva: false, transporte: "nenhum", origem: "none" });
  });

  it("host sem remetente não conta como em vigor — meia configuração não entrega e-mail", async () => {
    // É o mesmo corte do roteador: com `fromEmail` vazio não há remetente, e
    // sem remetente não existe e-mail. A tela tem de dizer isso a quem preencheu
    // pela metade, em vez de declarar sucesso.
    config = { ...config, fromEmail: "" };

    expect((await propsDaPagina()).transporte).toBe("nenhum");
  });

  it("instalação que já manda e-mail pelo serviço externo lê isso, não 'não está em uso'", async () => {
    // A leitura errada que esta linha evita: quem tem Resend abriria a única
    // tela de e-mail do produto e concluiria que o e-mail está desligado.
    config = { ...config, host: "", fromEmail: "", password: "", source: "none" };
    resendLigada = true;

    expect((await propsDaPagina()).transporte).toBe("resend");
  });

  it("quem não é dono da instalação não vê a tela", async () => {
    usuario = { is_platform_admin: false, idioma: "pt-BR" };

    await expect(propsDaPagina()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

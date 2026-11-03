import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, type Page, type TestInfo } from "./test";

import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { PONTO_TRANSCRICAO_DE_AUDIO } from "@/lib/ai/pontos/registro";
import { isMediaPathInOrganization } from "@/lib/messaging/media/upload-validation";

/** Banco/Storage reais; somente o fornecedor e a origem HTTP são sintéticos. */
export async function provarTranscricaoOpenRouter(page: Page, info: TestInfo): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  expect(Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)).toBe(true);
  // A tela lê o ambiente do app, que não pode escolher um degrau anterior.
  for (const nome of ["OPENAI_API_KEY", "TRANSCRIPTION_API_KEY"]) {
    expect(Boolean(process.env[nome]), `${nome} deve estar ausente no rig sintético`).toBe(false);
  }
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const sufixo = randomUUID();
  const email = `stt-3408-${sufixo}@example.com`;
  const senha = `E2e-3408-${randomUUID()}!`;
  const evidence = path.join(process.cwd(), "evidence", "openrouter-stt-3408-01a178b3");
  fs.mkdirSync(evidence, { recursive: true });
  let usuario = "";
  let orgId = "";
  try {
    const { data: criada, error: eUsuario } = await admin.auth.admin.createUser({
      email, password: senha, email_confirm: true,
    });
    if (eUsuario || !criada.user) throw new Error("fixture_stt_usuario");
    usuario = criada.user.id;
    const { data: org, error: eOrg } = await admin.from("organizations").insert({
      slug: `e2e-stt-3408-${sufixo}`, display_name: "Empresa de áudio sintético",
      legal_name: "Empresa de áudio sintético", status: "active", created_by: usuario,
      onboarded_at: new Date().toISOString(), locale: "pt-BR",
      settings: {
        llm: { provider: "openrouter", default_model: "google/gemini-2.5-flash" },
        // Sem agente/turno pago: este caso mede a escada de mídia e seu anúncio.
        ai_dispatch_mode: "external",
      },
    }).select("id").single();
    if (eOrg || !org) throw new Error("fixture_stt_organizacao");
    orgId = org.id;
    const { error: eVinculo } = await admin.from("user_organizations").insert({
      organization_id: orgId, user_id: usuario, role: "manager", accepted_at: new Date().toISOString(),
    });
    if (eVinculo) throw new Error("fixture_stt_vinculo_manager");
    const cifrada = encryptKey("e2e-openrouter-sem-provedor-pago-3408");
    // Fixture cifrada pelo helper real. guardarCredencial validaria na rede pública.
    const { error: eCredencial } = await admin.from("ai_provider_credentials").insert({
      organization_id: orgId, provider: "openrouter", label: "Fornecedor sintético de áudio",
      api_key_encrypted: bufToBytea(cifrada.ciphertext), api_key_iv: bufToBytea(cifrada.iv),
      api_key_tag: bufToBytea(cifrada.tag), api_key_last4: cifrada.last4,
      is_active: true, created_by: usuario, validated_at: new Date().toISOString(),
    });
    if (eCredencial) throw new Error("fixture_stt_credencial");
    const { data: canal, error: eCanal } = await admin.from("channel_sessions").insert({
      organization_id: orgId, waha_session_name: `e2e-stt-3408-${sufixo}`,
      display_name: "Canal sintético de áudio", status: "WORKING", webhook_secret_encrypted: "\\x00",
    }).select("id").single();
    if (eCanal || !canal) throw new Error("fixture_stt_canal");

    // O mesmo encoder já exigido pela parte 6; nenhum áudio inválido "ogg".
    const ogg = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:a", "libopus", "-f", "ogg", "pipe:1",
    ]);
    const arquivo = info.outputPath("entrada-valida.ogg");
    fs.writeFileSync(arquivo, ogg);
    const recibo = info.outputPath("transcricao-observada.json");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "scripts/e2e-transcricao-openrouter.ts", orgId, canal.id, arquivo, recibo,
      ], { env: process.env, stdio: ["ignore", "inherit", "inherit"], timeout: 60_000 });
      child.once("error", reject);
      child.once("close", (code) => {
        // O recibo físico vai para os dois coletores mesmo se o filho falhar.
        if (fs.existsSync(recibo)) fs.copyFileSync(recibo, path.join(evidence, "transcricao-observada.json"));
        if (code === 0) resolve();
        else reject(new Error("pipeline_stt_real_falhou_consulte_recibo"));
      });
    });
    const observado = JSON.parse(fs.readFileSync(recibo, "utf8"));
    expect(observado).toMatchObject({
      ok: true, processadorReal: true, eventosReais: true, storageReal: true,
      workersReais: true, bytesStorageIguais: true, multipartCorreto: true,
      caminhoAntigoRecusaOggAntesDoHttp: true,
      downloadsDoCanal: 1, chamadasStt: 2, ready: true, custoCents: 0.0508,
      redirectRecusado: true, chamadasDestinoRecusado: 0,
    });
    await info.attach("contrato real com fornecedor sintético", { path: recibo, contentType: "application/json" });

    // Manager pode LER o anúncio; editar provedores continua exigindo admin/MFA.
    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app\//);
    await page.goto("/app/ai/providers");
    await expect(page.getByTestId("painel-de-provedores")).toBeVisible();
    await page.getByTestId("avancado-perceber").click();
    const cartao = page.getByTestId(`ponto-${PONTO_TRANSCRICAO_DE_AUDIO}`);
    await expect(cartao).toBeVisible();
    await expect(cartao).toContainText("openai/whisper-large-v3");
    await expect(page.getByTestId(`origem-${PONTO_TRANSCRICAO_DE_AUDIO}`)).toContainText(
      "o provedor de conversa desta organização é a OpenRouter, que transcreve na própria API com a mesma chave",
    );
    await expect(page.getByTestId(`provider-${PONTO_TRANSCRICAO_DE_AUDIO}`)).toHaveCount(0);
    await cartao.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, "anuncio-da-transcricao.png") });
  } finally {
    let falhouLimpeza = false;
    if (orgId) {
      try {
        const { data: mensagens, error } = await admin.from("messages").select("media_storage_path").eq("organization_id", orgId);
        falhouLimpeza ||= error !== null;
        const caminhos = (mensagens ?? []).map((m) => m.media_storage_path).filter(
          (p): p is string => typeof p === "string" && isMediaPathInOrganization(p, orgId),
        );
        if (caminhos.length) {
          const removidos = await admin.storage.from("whatsapp-media").remove(caminhos);
          falhouLimpeza ||= removidos.error !== null;
        }
      } catch { falhouLimpeza = true; }
      try {
        const { error } = await admin.from("organizations").delete().eq("id", orgId);
        falhouLimpeza ||= error !== null;
      } catch { falhouLimpeza = true; }
    }
    if (usuario) {
      try {
        const { error } = await admin.auth.admin.deleteUser(usuario);
        falhouLimpeza ||= error !== null;
      } catch { falhouLimpeza = true; }
    }
    if (falhouLimpeza) throw new Error("fixture_stt_limpeza_incompleta");
  }
}

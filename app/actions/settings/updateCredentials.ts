"use server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ email: z.string().trim().email(), password: z.string().min(8).optional().or(z.literal("")) });
export async function updateCredentials(input: z.input<typeof schema>) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Informe um e-mail válido e uma senha de pelo menos 8 caracteres." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Sessão expirada." };
  const values: { email?: string; password?: string } = {};
  if (parsed.data.email !== user.email) values.email = parsed.data.email;
  if (parsed.data.password) values.password = parsed.data.password;
  if (!Object.keys(values).length) return { ok: true as const, emailConfirmationRequired: false };
  const { error } = await supabase.auth.updateUser(values);
  if (error) return { ok: false as const, error: "Não foi possível atualizar suas credenciais." };
  return { ok: true as const, emailConfirmationRequired: Boolean(values.email) };
}

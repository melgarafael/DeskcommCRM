/**
 * Supabase client para Client Components (browser).
 *
 * Use este em qualquer arquivo com "use client". NUNCA em Server Components,
 * Route Handlers, ou middleware — eles devem usar `lib/supabase/server.ts`.
 *
 * Sessão persiste via cookie SameSite=Strict gerenciado pelo @supabase/ssr.
 */

import { createBrowserClient } from "@supabase/ssr";

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  // Singleton no browser pra reaproveitar canais Realtime e auth state.
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "[supabase/browser] NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY ausentes.",
    );
  }

  _client = createBrowserClient(url, key, {
    // D-01.01: cookie name canônico alinhado ao middleware/server.
    cookieOptions: {
      name: "sb-deskcomm-auth",
      sameSite: "strict",
      path: "/",
    },
  });
  return _client;
}

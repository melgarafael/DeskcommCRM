/**
 * Client-side placeholder hook for /admin pages.
 *
 * The authoritative guard is server-side (`requirePlatformAdmin` in
 * `app/admin/(protected)/layout.tsx`). This hook exists so client components
 * within the admin shell have a hook signature to opt into in the future
 * (e.g. realtime checks for revoked_at). For now it's a no-op.
 */
"use client";

export function useAdminGuard(): void {
  // Intentionally empty. Server guard is the source of truth.
}

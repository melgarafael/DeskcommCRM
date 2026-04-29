import type { ReactNode } from "react";

/**
 * Outermost /admin layout — intentionally minimal so that
 * `app/admin/forbidden` (sibling of the `(protected)` group) can render
 * without invoking `requirePlatformAdmin` and creating a redirect loop.
 *
 * The actual platform shell + guard lives in `(protected)/layout.tsx`.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

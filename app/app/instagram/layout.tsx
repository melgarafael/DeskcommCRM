import { requireAuth } from "@/lib/auth/server";
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  return children;
}

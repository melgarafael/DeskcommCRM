import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { Providers } from "@/app/providers";
import { useOrganizationTransition } from "@/components/shell/OrganizationTransitionProvider";
import type { AuthUser } from "@/lib/auth/types";
vi.mock("@/lib/supabase/browser", () => ({ resetRealtimeAuthentication: vi.fn(), createClient: () => ({ auth: { refreshSession: vi.fn() } }) }));
const user = { id: "user-a", organizations: [], idioma: "pt-BR", email: "a@example.test", full_name: null, avatar_url: null, is_platform_admin: false } as AuthUser;
function Data({ fetcher }: { fetcher: () => Promise<string> }) {
  const { data } = useQuery({ queryKey: ["same-unscoped-key"], queryFn: fetcher, staleTime: Infinity });
  return <div>{data ?? "Carregando"}</div>;
}
function View({ org, fetcher, who = user }: { org: string; fetcher: () => Promise<string>; who?: AuthUser }) {
  return <AuthProvider user={who} activeOrg={{ orgId: org, name: org, role: "admin" }}><Data fetcher={fetcher} /></AuthProvider>;
}
describe("cache autenticado por usuário e organização", () => {
  it("A→B→A descarta resposta antiga em voo e recria cache ao mudar usuário", async () => {
    let finishA!: (value: string) => void;
    const pendingA = new Promise<string>(resolve => { finishA = resolve; });
    const initial = vi.fn(() => pendingA);
    const view = render(<View org="a" fetcher={initial} />);
    await waitFor(() => expect(initial).toHaveBeenCalledOnce());
    view.rerender(<View org="b" fetcher={async () => "Dados B"} />);
    await screen.findByText("Dados B");
    await act(async () => finishA("Dados A atrasados"));
    expect(screen.queryByText("Dados A atrasados")).toBeNull();
    expect(screen.getByText("Dados B")).toBeTruthy();
    view.rerender(<View org="a" fetcher={async () => "Dados A novos"} />);
    await screen.findByText("Dados A novos");
    expect(screen.queryByText("Dados B")).toBeNull();
    view.rerender(<View org="a" who={{ ...user, id: "user-b" }} fetcher={async () => "Dados outro usuário"} />);
    await screen.findByText("Dados outro usuário");
    expect(screen.queryByText("Dados A novos")).toBeNull();
  });
});

function TransitionControls() {
  const transition = useOrganizationTransition();
  return <><button onClick={() => transition.begin("Carregando")}>Trocar</button><button onClick={transition.cancel}>Falhou</button></>;
}
it("guarda sobrevive refresh RSC da org e pode cancelar na falha", () => {
  const shell = (org: string) => <Providers><AuthProvider user={user} activeOrg={{ orgId: org, name: org, role: "admin" }}><TransitionControls /></AuthProvider></Providers>;
  const view = render(shell("a"));
  fireEvent.click(screen.getByText("Trocar"));
  expect(screen.getByTestId("organization-transition")).toBeTruthy();
  view.rerender(shell("b"));
  expect(screen.getByTestId("organization-transition")).toBeTruthy();
  fireEvent.click(screen.getByText("Falhou"));
  expect(screen.queryByTestId("organization-transition")).toBeNull();
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { AmigoMutationBoundary } from "./_mutation-boundary";
import { useAmigoMutation } from "./_hooks";
function Form({ id }: { id: number }) {
  const mutation = useAmigoMutation();
  return (
    <button
      disabled={mutation.blocked || mutation.pending}
      onClick={() => void mutation.run("attendance_cancel", { id })}
    >
      Alterar consulta {id}
    </button>
  );
}
function Area() {
  const [id, setId] = useState(1);
  return (
    <AmigoMutationBoundary>
      <button onClick={() => setId((current) => current + 1)}>Trocar contexto</button>
      <Form key={id} id={id} />
    </AmigoMutationBoundary>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("retém resultado incerto ao desmontar o formulário e confere apenas o protocolo original", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { data: true, state: "confirmed" } })),
    );
  vi.stubGlobal("fetch", fetchMock);
  render(<Area />);
  fireEvent.click(screen.getByRole("button", { name: "Alterar consulta 1" }));
  expect(await screen.findByText("Há uma solicitação com resultado incerto.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Trocar contexto" }));
  expect(screen.getByRole("button", { name: "Alterar consulta 2" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Conferir protocolo pendente" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Alterar consulta 2" })).toBeEnabled(),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
  expect(fetchMock.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(
    fetchMock.mock.calls[1]![1].headers["Idempotency-Key"],
  );
});

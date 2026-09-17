import { describe, expect, it } from "vitest";

import type { ExtensionOperationKind } from "@/lib/extensions/vocabulario";

import {
  compatibleKinds,
  expectedOperation,
  operationMatchesOrganization,
  parseExtensionOperationView,
} from "./operation-receipt";

const ID = "00000000-0000-4000-8000-000000000004";
const ORG = "00000000-0000-4000-8000-000000000001";

function receipt(kind: ExtensionOperationKind = "configure") {
  return {
    id: ID,
    organization_id: kind === "configure" ? ORG : null,
    actor_id: "00000000-0000-4000-8000-000000000010",
    kind,
    status: "completed" as const,
    catalog_id: null,
    installation_id: "00000000-0000-4000-8000-000000000003",
    publisher: "equipe-exemplo",
    name: "rotina-comercial",
    version: "1.0.0",
    error_code: null,
    error_message: null,
    from_revision: null,
    from_version: null,
    to_version: null,
    organizations_affected: null,
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:01:00.000Z",
  };
}

describe("recibo de operação recebido pela UI", () => {
  it("rejeita JSON que omite organization_id ou os campos da troca", () => {
    const { organization_id: _, ...missing } = receipt();
    expect(parseExtensionOperationView(missing)).toBeNull();
    const { from_revision: __, ...semRevisao } = receipt("update");
    expect(parseExtensionOperationView(semRevisao)).toBeNull();
    expect(parseExtensionOperationView({ ...receipt("removal"), organizations_affected: -1 })).toBeNull();
    expect(parseExtensionOperationView({ ...receipt("update"), actor_id: "não-é-uuid" })).toBeNull();
    const { actor_id: ___, ...semAutor } = receipt("update");
    expect(parseExtensionOperationView(semAutor)).toBeNull();
    expect(parseExtensionOperationView({ ...receipt("update"), actor_id: null })).not.toBeNull();
    expect(
      parseExtensionOperationView({
        ...receipt("update"),
        from_revision: 2,
        from_version: "1.0.0",
        to_version: "1.1.0",
        organizations_affected: 3,
      }),
    ).not.toBeNull();
  });

  it("exige organização exata para configuração", () => {
    const kinds = ["configure"] as const;
    expect(expectedOperation(receipt(), { id: ID, kinds, organizationId: ORG })).not.toBeNull();
    expect(
      expectedOperation({ ...receipt(), organization_id: null }, { id: ID, kinds, organizationId: ORG }),
    ).toBeNull();
    expect(
      expectedOperation(
        { ...receipt(), organization_id: "00000000-0000-4000-8000-000000000002" },
        { id: ID, kinds, organizationId: ORG },
      ),
    ).toBeNull();
    expect(expectedOperation(receipt("install"), { id: ID, kinds, organizationId: ORG })).toBeNull();
  });

  it("aceita organização nula para toda operação de plataforma, inclusive as de versão", () => {
    for (const kind of ["catalog_admission", "install", "update", "revert", "removal"] as const) {
      expect(operationMatchesOrganization(receipt(kind), ORG), kind).toBe(true);
      expect(
        operationMatchesOrganization({ ...receipt(kind), organization_id: ORG }, ORG),
        `${kind} com organização`,
      ).toBe(false);
    }
    expect(
      expectedOperation(receipt("install"), { id: ID, kinds: ["catalog_admission"], organizationId: ORG }),
    ).toBeNull();
  });

  it("o pedido de instalação aceita a resposta de atualização, e só ele", () => {
    expect(compatibleKinds("install")).toEqual(["install", "update"]);
    expect(compatibleKinds("update")).toEqual(["install", "update"]);
    expect(compatibleKinds("revert")).toEqual(["revert"]);
    expect(
      expectedOperation(receipt("update"), {
        id: ID,
        kinds: compatibleKinds("install"),
        organizationId: ORG,
      }),
    ).not.toBeNull();
    expect(
      expectedOperation(receipt("removal"), { id: ID, kinds: compatibleKinds("revert"), organizationId: ORG }),
    ).toBeNull();
  });

  it("exige o mesmo UUID solicitado", () => {
    expect(
      expectedOperation(receipt(), {
        id: "00000000-0000-4000-8000-000000000099",
        kinds: ["configure"],
        organizationId: ORG,
      }),
    ).toBeNull();
  });
});

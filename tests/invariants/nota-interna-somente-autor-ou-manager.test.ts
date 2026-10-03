/**
 * 0509 — NOTA INTERNA: EDITAR E APAGAR SÓ O AUTOR OU MANAGER+ (#1870, cont. da #1868).
 *
 * A #1868 (0478) fez a nota seguir a visibilidade da conversa na leitura e na
 * escrita. O que continuava aberto (a própria issue #1870): a ESCRITA era uma
 * policy única `for all` (`conversation_notes_write`) cuja condição era org +
 * papel `agent` + `fn_can_view_conversation` — sem distinguir o AUTOR. Entre
 * quem VÊ a conversa, qualquer AGENT podia, pelo PostgREST com o JWT da sessão
 * dele (a mesma porta da anon key), editar ou apagar a nota de um colega —
 * inclusive nota sigilosa — sem passar pela rota. A rota DELETE já exigia
 * autor+/manager+ no app (`[noteId]/route.ts`); o banco era porta tão aberta
 * quanto ela.
 *
 * Este arquivo mede a RLS por operação (formato 0464/0489/0490) que a 0509
 * instala:
 *   · INSERT  = org + `agent` + ver a conversa + autor = a própria sessão;
 *   · UPDATE  = autor OU manager+, sempre dentro da visibilidade da conversa;
 *   · DELETE  = autor OU manager+, sempre dentro da visibilidade da conversa.
 *
 * Que o leitor leia o caso mais importante primeiro: dois agentes da MESMA
 * organização que VÊEM a MESMA conversa. O cenário GOV_CONV_AGENT_B (assigned
 * a GOV_AGENT_B) NÃO discrimina — GOV_AGENT_A não vê essa conversa, então o
 * bloqueio seria de visibilidade, não de autoria. Por isso este arquivo usa
 * GOV_CONV_UNASSIGNED: no modo `own_and_unassigned` (padrão) QUALQUER agent da
 * org a vê, então a ÚNICA razão de GOV_AGENT_A não poder editar/apagar a nota
 * de GOV_AGENT_B ali É a autoria — é exatamente o buraco que a #1870 aponta.
 *
 * Previsão escrita antes de rodar (sabotagem): sem as policies de UPDATE/DELETE
 * novas (retornando `conversation_notes_write` `for all` ao estado da 0478),
 * os casos "agent que vê a conversa NÃO edita/apaga nota de colega" ficam
 * VERMELHOS: devolvem 1 em vez de 0.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/** Nota autorada por GOV_AGENT_B na conversa LIVRE (visível a qualquer agent). */
const NOTA_DE_B = "d0d0d0d0-0503-4000-8000-000000000001";
/** Sondas de UPDATE/DELETE; recriadas no seed para o controle contar a cada rodada. */
const SONDA_UPDATE = "d0d0d0d0-0503-4000-8000-000000000002";
const SONDA_DELETE = "d0d0d0d0-0503-4000-8000-000000000003";
/** Nota que GOV_AGENT_A tenta criar em nome de GOV_AGENT_B; nunca deve existir. */
const SONDA_FORJADA = "d0d0d0d0-0503-4000-8000-000000000004";

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.conversation_notes where id in ('${NOTA_DE_B}', '${SONDA_UPDATE}', '${SONDA_DELETE}', '${SONDA_FORJADA}');
    insert into public.conversation_notes
      (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
      values
        ('${NOTA_DE_B}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'nota do B na conversa livre', '${GOV_AGENT_B}', 'B'),
        ('${SONDA_UPDATE}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'sonda update', '${GOV_AGENT_B}', 'B'),
        ('${SONDA_DELETE}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'sonda delete', '${GOV_AGENT_B}', 'B');
  `);
});

describe("0509 — edita e apaga nota só o autor ou manager+", () => {
  it("os dois agentes VÊEM a conversa livre (controle de cenário)", () => {
    const contar = `select count(*) from public.conversation_notes where id = '${NOTA_DE_B}';`;
    expect(countAs(GOV_AGENT_A, contar)).toBe(1);
    expect(countAs(GOV_AGENT_B, contar)).toBe(1);
  });

  it("o agent que VÊ a conversa mas NÃO é o autor NÃO edita a nota", () => {
    // sem a 0509 isto devolve 1 — era o buraco da #1870
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.conversation_notes set body = 'hackeada' where id = '${NOTA_DE_B}'`,
      ),
    ).toBe(0);
  });

  it("o agent que VÊ a conversa mas NÃO é o autor NÃO apaga a nota", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.conversation_notes where id = '${NOTA_DE_B}'`),
    ).toBe(0);
  });

  it("o AUTOR edita a própria nota", () => {
    expect(
      writeCountAs(
        GOV_AGENT_B,
        `update public.conversation_notes set body = 'editada pelo autor' where id = '${SONDA_UPDATE}'`,
      ),
    ).toBe(1);
  });

  it("o AUTOR apaga a própria nota", () => {
    expect(
      writeCountAs(GOV_AGENT_B, `delete from public.conversation_notes where id = '${SONDA_DELETE}'`),
    ).toBe(1);
  });

  it("VIEWER (abaixo de agent) nunca escreve, mesmo sendo autor", () => {
    // viewer não passa no piso `agent` das policies novas
    expect(
      writeCountAs(
        GOV_VIEWER,
        `update public.conversation_notes set body = 'x' where id = '${NOTA_DE_B}'`,
      ),
    ).toBe(0);
  });

  it("o agent NÃO cria nota em nome de outro", () => {
    // sem o `created_by_user_id = auth.uid()` do INSERT isto devolve 1
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.conversation_notes
           (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
           values ('${SONDA_FORJADA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'forjada', '${GOV_AGENT_B}', 'B')`,
      ),
    ).toBe(0);
  });

  it("o AUTOR NÃO transfere a autoria da própria nota para um colega", () => {
    // o `with check` do UPDATE exige que a linha gravada siga sendo dele (ou manager+)
    expect(
      writeCountAs(
        GOV_AGENT_B,
        `update public.conversation_notes set created_by_user_id = '${GOV_AGENT_A}' where id = '${SONDA_UPDATE}'`,
      ),
    ).toBe(0);
  });

  it("MANAGER+ edita nota de colega (que ele vê)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.conversation_notes set body = 'editada pelo manager' where id = '${NOTA_DE_B}'`,
      ),
    ).toBe(1);
  });

  it("MANAGER+ apaga nota de colega (que ele vê)", () => {
    // manager vê a conversa livre e passa em `fn_role_at_least(org,'manager')`
    expect(
      writeCountAs(GOV_MANAGER, `delete from public.conversation_notes where id = '${NOTA_DE_B}'`),
    ).toBe(1);
  });
});
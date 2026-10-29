# Running image identity — validation evidence

The host checkout, a requested update, and the running services are different sources.
This change uses the native authenticated host heartbeat to report immutable image
observations, then derives a bounded, coherent installed identity on the server.

## Reproduction and regression

Before the fix, two directed regressions failed while their two controls passed:
1. The update link replaced the installed version in the footer.
2. APP_VERSION alone cleared a failed/rolled-back deployment.

After the fix: seven relevant files / 139 tests passed, including the native version,
heartbeat and update routes, successful same-version reinstallation with later host
proof, rollback controls and UI components. Following a strict indexed-access typing
correction, only the two affected files were repeated: 56 tests passed. Assertions and
negative protections were retained. This is directed coverage, not a full unit-suite claim.

The actual Bash collector was exercised with synthetic Git/image/compose inputs:
official and customized builds, a different checkout, unhealthy/missing metadata,
divergent revisions and foreign project ownership. All six scenarios passed. The
collector is included in the native test:shell command, which also passed.

## Schema and artifact

The migration adds one nullable JSONB column to the existing global system_version
row. It was applied twice inside a transaction on the existing QA database, with
row contents, ACLs and RLS preserved, and then rolled back. The identical additive
SQL is appended to the public baseline. No business table or authorization policy
changes. The native collision gate measured the public main, local refs and all 41
open PR heads at validation time; the new timestamp/NNNN were free.

Native production TypeScript checking passed before each actual source-variant build
(3,132 input files / 8,634 total sources). The bounded Docker build used separate
compile/generate processes after native type checking, with a temporary build-context
configuration; tracked source configuration was restored and checked. App, worker
loop and scheduler boots were checked. This is an AMD64 artifact proof, not ARM64 proof.

## Compiled UI

A compiled production-mode app was connected to the existing synthetic QA stack.
The screenshot below uses invented image IDs/revision and a fictional later release;
it is not evidence that this later release exists. Native API and rendered UI agreed:
installed base 1.89.0, customized, coherent host observation, later-release notice
separate from the installed version, and explicit reconciliation before image replacement.

![Compiled version card with synthetic revision](qa-version-card.jpg)

Desktop at 1280×720, collapsed navigation and mobile at 390×844 were checked.
The full identity remained accessible in collapsed navigation; the mobile footer
and separate update link were visible without horizontal overflow. Temporary QA
metadata/owner fixture were restored; app stopped; messages and organization settings
were preserved. No real messages, AI-provider calls, bookings or paid tests were needed.

## Limits and verification still delegated to CI

This task did not manually rerun the whole unit, E2E or database matrix. It reused
existing evidence and ran the changed paths, native packaging gate and proportional
schema checks. The broad structural project could not produce a valid result in the
Alpine dependency image: GNU grep/Bash-dependent instruments failed. This was recorded
rather than weakening assertions or changing unrelated functionality. Public native
CI remains the authority for those broader gates; no universal green/interpretation,
ARM64 installation, or clean fresh-baseline E2E is claimed from this evidence.

No Docker socket, extra privilege, new host service, parallel ledger or business
configuration is introduced. Older heartbeat schemas remain accepted, explicitly
unconfirmed, and invalidate rather than refresh earlier modern evidence.

The collector fixture clears inherited local Git variables before creating its temporary repository. The native shell-identity guard passed all three checks; the fixture collector passed again after this test-only hardening. Runtime code and built/deployed artifacts were unchanged.

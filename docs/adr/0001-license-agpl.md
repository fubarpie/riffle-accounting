# ADR-0001: License under AGPL-3.0-or-later

- Status: Accepted
- Date: 2026-10-18

## Context
Riffle must stay free and open source, must not be closed off by hosted forks,
and benefits from reusing the design and behaviour of Firefly III (AGPL-3.0),
which has a mature rules engine and SimpleFIN import.

## Decision
License Riffle under **AGPL-3.0-or-later**.

## Consequences
- Firefly III behaviour may be ported with attribution. Firefly III is PHP, so
  this is a manual port, not a copy of files.
- MIT-licensed references (for example Actual Budget's SimpleFIN client) keep
  their copyright notice and license text in `NOTICE`.
- Every source file carries an `SPDX-License-Identifier: AGPL-3.0-or-later`
  header. Files that adapt third-party work also name the original.
- The web UI links to the source (AGPL section 13).
- Riffle will never include a phone-home, license-key, or feature-gating
  mechanism.
- Dependencies must be licensed compatibly with AGPL-3.0.

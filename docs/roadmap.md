# Roadmap

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Foundation** | Monorepo, license, ADRs, Dockerfile, compose, CI and GHCR pipeline, `/healthz` | A merge to `main` publishes an image that passes the smoke test |
| **1. Core ledger and tenancy** | Auth, businesses, memberships, chart of accounts, double-entry, manual transactions and journals, row-level security | Property tests show the ledger always balances and cross-tenant access is impossible |
| **2. Rules and reports** | Rules engine, categorization, P&L, balance sheet, trial balance | Rules are unit tested and reports tie out to the ledger |
| **3. SimpleFIN import** | Adapter, daily scheduler, dedupe, error surfacing | Works against a mock server, then a real SimpleFIN Bridge account |
| **4. Reconciliation and vault** | Reconcile UI, statement attachments | Each reconciliation links to its statement |
| **5. AI upload** | Extractor interface, validation gate, staging and approval UI | Extractions that fail the balance check are flagged, never auto-staged |
| **6. Wave migration and hardening** | CSV importers, backup and restore docs, security review | Beta release |

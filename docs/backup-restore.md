<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Backup and restore

> **Status: draft, commands not yet exercised end to end.** The commands below follow the
> layout in `docker-compose.yml` but have not been run against a live stack. Do a trial
> restore on a scratch machine before relying on them (see "Test your backups").

## What to back up

A complete backup has **four** parts. Losing any one can make the others unusable.

| Part | Where it lives | Why it matters |
| --- | --- | --- |
| Database | `pgdata` volume (PostgreSQL) | All books, users, rules, reconciliations, encrypted bank links. |
| Statement vault | `riffle-statements` volume | Uploaded statements. The database stores only a key and a SHA-256 for each file. |
| `RIFFLE_SECRET_KEY` | your `.env` | Encrypts stored SimpleFIN Access URLs. **Without the same key ring, restored bank connections cannot be decrypted** and must be re-linked. |
| `.env` | the deployment directory | Database passwords, image tag, settings. Store it somewhere safer than the backup disk (it holds secrets). |

The `riffle-data` volume (`/data`) is declared in the stack, but the application code does not
currently read `DATA_DIR`. It is not expected to hold anything you need, but include it if you
want to be safe.

Back up the database and the vault **at the same time** (or with the app stopped). A vault file
without its database row is orphaned; a row without its file shows a missing statement.

## Back up

Run from the directory containing `docker-compose.yml` and `.env`. Volume names assume the
default Compose project name `riffle`.

```sh
mkdir -p backups && STAMP=$(date +%Y%m%d-%H%M%S)

# 1. Quiesce writers so the database and vault agree.
docker compose stop api worker

# 2. Database (custom format, compressed, restorable with pg_restore).
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "backups/riffle-db-$STAMP.dump"

# 3. Statement vault.
docker run --rm -v riffle_riffle-statements:/src:ro -v "$PWD/backups":/out alpine \
  tar -czf "/out/riffle-statements-$STAMP.tar.gz" -C /src .

# 4. Config and key (keep these private).
cp .env "backups/env-$STAMP" && chmod 600 "backups/env-$STAMP"

docker compose start api worker
```

Copy `backups/` off the machine (another disk, another host, or encrypted cloud storage).
A backup on the same disk as the data does not protect against disk failure.

The app is unavailable for the length of the dump. For a small business this is seconds to
minutes. If you cannot stop the app, `pg_dump` is still consistent on its own, but the vault
may be a few files ahead of or behind it.

## Restore

Restore onto a stack that has **never held data**, or one you are happy to overwrite.

```sh
# 1. Put the saved .env back, then start only the database.
cp backups/env-<STAMP> .env
docker compose up -d postgres

# 2. Let the API create the schema and the restricted riffle_app role once, then stop it.
docker compose up -d api && sleep 20 && docker compose stop api

# 3. Load the database dump over it.
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < backups/riffle-db-<STAMP>.dump

# 4. Restore the vault.
docker run --rm -v riffle_riffle-statements:/dst -v "$PWD/backups":/in:ro alpine \
  sh -c 'cd /dst && tar -xzf /in/riffle-statements-<STAMP>.tar.gz'

# 5. Start everything.
docker compose up -d
```

Why step 2: the application runs as the restricted `riffle_app` role, which is subject to
row-level security. That role must exist, with its grants, before the data is useful. Starting
the API once creates it using `RIFFLE_APP_DB_PASSWORD` from the restored `.env`.

### Check the result

1. `curl -fsS http://localhost:3000/healthz` returns OK.
2. Sign in and open a business. Reports and balances match what you recorded before the backup.
3. Open a reconciliation that has an attached statement and download it.
4. If you use bank import, confirm a connection shows as healthy. If it reports a decryption
   error, the `RIFFLE_SECRET_KEY` does not match the one used when the backup was taken.

## Upgrading from an older layout

If you installed before the vault moved to `/var/lib/riffle/statements`, the volume and its
contents are unchanged; only the mount path differs. A `.env` that sets
`STATEMENT_STORAGE_DIR=/data/statements` must be updated or that line removed.

## Test your backups

A backup you have never restored is a hope, not a backup. At least once, and after any
upgrade that changes the database:

1. Copy a backup to a different machine (or a fresh directory with a different Compose project name).
2. Follow the restore steps above.
3. Run the checks above.

If any command in this guide does not work as written, please open an issue so the guide can be fixed.

## Retention suggestion

Keep daily backups for a week, weekly for a month, and one per month for as long as your
accountant or tax obligations require. Check your local record-keeping rules; this guide gives
no tax or legal advice.

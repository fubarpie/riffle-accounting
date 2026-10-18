// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Pool } from "pg";

/** Cross-tenant metadata about a connection. Never includes the access URL. */
export interface WorkerConnection {
  id: string;
  businessId: string;
  /** Recorded as the actor for audit rows and `staged_transactions.created_by`. */
  createdBy: string;
  status: "active" | "disabled" | "error";
  lastSyncedAt: Date | null;
  updatedAt: Date;
  scheduleMinute: number;
}

/**
 * Where the scheduler learns which connections exist. Row-level security
 * confines `riffle_app` to one business per transaction, so listing across
 * tenants needs a narrow, secret-free SECURITY DEFINER function; see
 * docs/worker-import.md for the migration this requires.
 */
export interface ConnectionSource {
  list(): Promise<WorkerConnection[]>;
  get(id: string): Promise<WorkerConnection | undefined>;
}

interface Row {
  id: string;
  business_id: string;
  created_by: string;
  status: WorkerConnection["status"];
  last_synced_at: Date | null;
  updated_at: Date;
  schedule_minute: number;
}

const toConn = (r: Row): WorkerConnection => ({
  id: r.id,
  businessId: r.business_id,
  createdBy: r.created_by,
  status: r.status,
  lastSyncedAt: r.last_synced_at,
  updatedAt: r.updated_at,
  scheduleMinute: r.schedule_minute,
});

/** Name of the database function the worker calls. */
export const WORKER_LIST_FUNCTION = "riffle_worker_bank_connections";

export function pgConnectionSource(pool: Pool): ConnectionSource {
  const query = async (id: string | null): Promise<WorkerConnection[]> => {
    const { rows } = await pool.query<Row>(`SELECT * FROM ${WORKER_LIST_FUNCTION}($1::uuid)`, [id]);
    return rows.map(toConn);
  };
  return {
    list: () => query(null),
    get: async (id) => (await query(id))[0],
  };
}

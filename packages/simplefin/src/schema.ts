import { z } from "zod";

const epoch = z.number().int().nonnegative();

export const transactionSchema = z.object({
  id: z.string().min(1),
  posted: epoch,
  amount: z.string(),
  description: z.string(),
  pending: z.boolean().optional(),
});

export const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  currency: z.string().min(1),
  balance: z.string(),
  "available-balance": z.string().nullish(),
  "balance-date": epoch,
  conn_id: z.string().optional(),
  transactions: z.array(transactionSchema).default([]),
});

export const connectionSchema = z.object({
  conn_id: z.string(),
  name: z.string().optional(),
  org_id: z.string().optional(),
  org_url: z.string().optional(),
  sfin_url: z.string().optional(),
});

export const errlistEntrySchema = z.object({
  code: z.string(),
  msg: z.string().default(""),
  conn_id: z.string().optional(),
  account_id: z.string().optional(),
});

export const accountSetSchema = z.object({
  errlist: z.array(errlistEntrySchema).optional(),
  errors: z.array(z.string()).optional(),
  connections: z.array(connectionSchema).default([]),
  accounts: z.array(accountSchema),
});

export type RawAccountSet = z.infer<typeof accountSetSchema>;

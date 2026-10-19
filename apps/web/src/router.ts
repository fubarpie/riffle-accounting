// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hash routing: the API serves the built app as static files, so a hash needs
 * no server-side fallback rules.
 *   #/                      business list
 *   #/b/:id                 extractions of a business (upload + list)
 *   #/b/:id/x/:eid          review one extraction
 */

export type Route =
  | { name: "businesses" }
  | { name: "extractions"; businessId: string }
  | { name: "review"; businessId: string; extractionId: string }
  | { name: "not-found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length === 0) return { name: "businesses" };
  if (parts[0] === "b" && parts[1] !== undefined && UUID.test(parts[1])) {
    if (parts.length === 2) return { name: "extractions", businessId: parts[1] };
    if (parts.length === 4 && parts[2] === "x" && parts[3] !== undefined && UUID.test(parts[3])) {
      return { name: "review", businessId: parts[1], extractionId: parts[3] };
    }
  }
  return { name: "not-found" };
}

export const hrefFor = {
  businesses: () => "#/",
  extractions: (businessId: string) => `#/b/${businessId}`,
  review: (businessId: string, extractionId: string) => `#/b/${businessId}/x/${extractionId}`,
};

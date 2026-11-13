import { createHash } from "node:crypto";
export function canonicalHash(value: unknown): string {
  const canonical = (v: any): any =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map(k => [k, canonical(v[k])])
            )
          : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

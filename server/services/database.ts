export async function lockedSelect(query: any) {
  // Real Drizzle queries acquire row locks; the in-memory test adapter has no SQL lock API.
  return typeof query.for === "function" ? query.for("update") : query;
}

export function currencyPrecision(currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
}

export function formatMoney(minorUnits: number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minorUnits / 10 ** currencyPrecision(currency));
}

export function parseMoney(input: string, currency: string) {
  const precision = currencyPrecision(currency);
  if (!/^\d+(?:\.\d+)?$/.test(input)) throw new Error("Enter a positive amount without separators.");
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > precision) throw new Error(`${currency} accepts at most ${precision} decimal places.`);
  const amount = BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, "0") || "0");
  if (amount <= 0n || amount > 2147483647n) throw new Error("Amount is outside the supported range.");
  return Number(amount);
}

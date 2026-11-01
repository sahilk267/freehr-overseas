/** Bounded CSV intake, including quoted commas, newlines and doubled quotes. */
export function parseIntakeCsv(text: string, kind: "candidate" | "prospect") {
  if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error("CSV must be smaller than 256 KB.");
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ""; closed = false; if (row.length > 20) throw Error("Too many CSV columns."); };
  const pushRow = () => { pushCell(); if (row.some(c => c.trim())) rows.push(row); row = []; if (rows.length > 51) throw Error("Import at most 50 records per batch."); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === ',') pushCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed) { if (!/\s/.test(c)) throw Error("Unexpected content after a quoted CSV cell."); }
    else { if (c === '"') throw Error("Unexpected quote in an unquoted CSV cell."); cell += c; }
    if (cell.length > 5000) throw Error("A CSV cell exceeds 5,000 characters.");
  }
  if (quoted) throw Error("CSV contains an unclosed quote.");
  if (cell || row.length || closed) pushRow();
  if (rows.length < 2) throw Error("CSV needs a header and at least one record.");
  const headers = rows.shift()!.map(s => s.trim());
  const allowed = kind === "candidate" ? ["externalKey", "fullName", "email", "phone", "headline", "location", "availability", "sourceUrl"] : ["externalKey", "name", "domain", "sector", "location", "hiringSignal", "sourceUrl", "contactName", "contactEmail", "contactTitle", "contactPhone"];
  if (new Set(headers).size !== headers.length || headers.some(h => !allowed.includes(h))) throw Error("CSV has duplicate or unsupported headers.");
  const required = kind === "candidate" ? ["externalKey", "fullName"] : ["externalKey", "name", "domain"];
  if (required.some(h => !headers.includes(h))) throw Error(`Required CSV headers: ${required.join(", ")}.`);
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw Error(`CSV row ${index + 2} has the wrong column count.`);
    const values = Object.fromEntries(headers.flatMap((h, i) => cells[i].trim() ? [[h, cells[i].trim()]] : []));
    if (kind === "candidate") return values;
    const { contactName, contactEmail, contactTitle, contactPhone, ...record } = values;
    return { ...record, ...(contactName || contactEmail || contactTitle || contactPhone ? { contact: { name: contactName, email: contactEmail, ...(contactTitle ? { title: contactTitle } : {}), ...(contactPhone ? { phone: contactPhone } : {}) } } : {}) };
  });
}

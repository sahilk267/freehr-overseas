import { describe, expect, it } from "vitest";
import { parseIntakeCsv } from "../../shared/intakeCsv";

describe("bounded source CSV intake", () => {
  it("reads quoted newlines, commas, escaped quotes and CRLF without changing identity strings", () => {
    const rows = parseIntakeCsv('\uFEFFexternalKey,fullName,email,headline\r\nsource-A,"Example, Candidate",person@example.test,"First line\nA ""quoted"" role"\r\n', "candidate");
    expect(rows).toEqual([{ externalKey: "source-A", fullName: "Example, Candidate", email: "person@example.test", headline: 'First line\nA "quoted" role' }]);
  });
  it("builds optional prospect contacts and omits blank optional fields", () => {
    expect(parseIntakeCsv('externalKey,name,domain,contactName,contactEmail,contactTitle\na,Company,example.test,Person,person@example.test,\n', "prospect")).toEqual([{ externalKey: "a", name: "Company", domain: "example.test", contact: { name: "Person", email: "person@example.test" } }]);
  });
  it("rejects malformed quotes, mismatched columns and unsupported permission/state columns", () => {
    for (const text of ['externalKey,fullName\na,"Unfinished', 'externalKey,fullName\na,"Name"extra', 'externalKey,fullName\na,Name,extra', 'externalKey,fullName,profileState\na,Name,consented', 'externalKey,fullName,fullName\na,Name,Name']) expect(() => parseIntakeCsv(text, "candidate")).toThrow();
  });
  it("bounds record count, cell length and encoded payload size", () => {
    expect(() => parseIntakeCsv('externalKey,fullName\n' + Array.from({ length: 51 }, (_, i) => `${i},Name`).join('\n'), "candidate")).toThrow(/50/);
    expect(() => parseIntakeCsv('externalKey,fullName\na,' + 'x'.repeat(5001), "candidate")).toThrow(/5,000/);
    expect(() => parseIntakeCsv('x'.repeat(256 * 1024 + 1), "candidate")).toThrow(/256/);
  });
});

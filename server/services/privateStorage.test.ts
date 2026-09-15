import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storagePut = vi.fn(async (key: string) => ({ key: `managed/${key}`, url: `/manus-storage/managed/${key}` }));
const storageGetSignedUrl = vi.fn(async (key: string) => `https://signed.example.test/${key}`);

vi.mock("../storage", () => ({ storagePut, storageGetSignedUrl }));

const { getPrivateDocumentUrl, getPrivateStorageStatus, putPrivateDocument, readPrivateDocument } = await import("./privateStorage");
const originalEnv = { ...process.env };

describe("private document storage adapter", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "development" };
    delete process.env.PRIVATE_STORAGE_MODE;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_REGION;
    delete process.env.STORAGE_ACCESS_KEY_ID;
    delete process.env.STORAGE_SECRET_ACCESS_KEY;
    storagePut.mockClear();
    storageGetSignedUrl.mockClear();
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  it("uses the managed private-storage adapter during development", async () => {
    expect(getPrivateStorageStatus()).toEqual({ mode: "managed", configured: true, missing: [] });
    await expect(putPrivateDocument("private/17/cv.pdf", Buffer.from("cv"), "application/pdf")).resolves.toEqual({ key: "managed/private/17/cv.pdf", url: "/manus-storage/managed/private/17/cv.pdf" });
    await expect(getPrivateDocumentUrl("private/17/cv.pdf")).resolves.toBe("https://signed.example.test/private/17/cv.pdf");
    expect(storagePut).toHaveBeenCalledWith("private/17/cv.pdf", expect.any(Buffer), "application/pdf");
  });

  it("writes and reads private files in explicit local mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.PRIVATE_STORAGE_MODE = "local";
    process.env.PRIVATE_LOCAL_STORAGE_PATH = `/tmp/freelancehr-storage-test-${process.pid}`;
    await expect(putPrivateDocument("private/17/local.txt", Buffer.from("private-data"), "text/plain")).resolves.toEqual({ key: "local/private/17/local.txt", url: "/api/private-storage/private%2F17%2Flocal.txt" });
    await expect(readPrivateDocument("local/private/17/local.txt")).resolves.toEqual(Buffer.from("private-data"));
    await expect(getPrivateDocumentUrl("local/private/17/local.txt")).resolves.toBe("/api/private-storage/private%2F17%2Flocal.txt");
  });

  it("fails closed in explicit S3 mode when S3-compatible private storage is incomplete", () => {
    process.env.NODE_ENV = "production";
    process.env.PRIVATE_STORAGE_MODE = "s3";
    expect(getPrivateStorageStatus()).toEqual(expect.objectContaining({ mode: "s3", configured: false, missing: expect.arrayContaining(["bucket", "region", "accessKeyId", "secretAccessKey"]) }));
  });

  it("does not treat a private S3 record as a public URL", () => {
    process.env.NODE_ENV = "production";
    process.env.PRIVATE_STORAGE_MODE = "s3";
    process.env.STORAGE_BUCKET = "private-freelancehr";
    process.env.STORAGE_REGION = "ap-south-1";
    process.env.STORAGE_ACCESS_KEY_ID = "test-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "test-secret";
    expect(getPrivateStorageStatus()).toEqual({ mode: "s3", configured: true, missing: [] });
  });
});

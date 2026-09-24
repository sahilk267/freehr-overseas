import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageGetSignedUrl, storagePut } from "../storage";

type PrivateStorageMode = "managed" | "local" | "s3";

function getMode(): PrivateStorageMode {
  const configured = process.env.PRIVATE_STORAGE_MODE?.trim().toLowerCase();
  if (configured === "s3") return "s3";
  if (configured === "managed") return "managed";
  if (configured === "local") return "local";
  if (process.env.NODE_ENV === "development") return "managed";
  return "local";
}

function normalizeKey(value: string) {
  const key = value.replace(/^\/+/, "").replace(/^local\//, "");
  if (!key || key.includes("\\0") || key.split("/").some(part => part === "..")) throw new Error("Invalid private storage key.");
  return key;
}

function localRoot() {
  return path.resolve(process.env.PRIVATE_LOCAL_STORAGE_PATH?.trim() || path.join(process.cwd(), "private-storage"));
}

function localFile(key: string) {
  const root = localRoot();
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid private storage key.");
  return target;
}

function requiredS3Config() {
  const values = {
    bucket: process.env.STORAGE_BUCKET?.trim(),
    region: process.env.STORAGE_REGION?.trim(),
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY?.trim(),
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  return { values, missing };
}

function getS3Client() {
  const { values, missing } = requiredS3Config();
  if (missing.length) throw new Error(`Private storage is not configured; missing ${missing.join(", ")}.`);
  return {
    bucket: values.bucket!,
    client: new S3Client({
      region: values.region!,
      endpoint: process.env.STORAGE_ENDPOINT?.trim() || undefined,
      forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId: values.accessKeyId!, secretAccessKey: values.secretAccessKey! },
    }),
  };
}

export function getPrivateStorageStatus() {
  const mode = getMode();
  const { missing } = requiredS3Config();
  return { mode, configured: mode !== "s3" || missing.length === 0, missing: mode === "s3" ? missing : [] };
}

export async function putPrivateDocument(relKey: string, data: Buffer | Uint8Array | string, contentType: string) {
  const mode = getMode();
  const key = normalizeKey(relKey);
  if (mode === "local") {
    const target = localFile(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return { key: `local/${key}`, url: `/api/private-storage/${encodeURIComponent(key)}` };
  }
  if (mode === "managed") return storagePut(relKey, data, contentType);
  const { bucket, client } = getS3Client();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  return { key, url: `private://s3/${key}` };
}

export async function getPrivateDocumentUrl(relKey: string, expiresInSeconds = 300) {
  const key = normalizeKey(relKey);
  const boundedExpiry = Math.max(60, Math.min(expiresInSeconds, 900));
  if (getMode() === "local") return `/api/private-storage/${encodeURIComponent(key)}`;
  if (getMode() === "managed") return storageGetSignedUrl(key);
  const { bucket, client } = getS3Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: boundedExpiry });
}

export async function readPrivateDocument(relKey: string): Promise<Buffer> {
  const mode = getMode();
  const key = normalizeKey(relKey);
  if (mode === "local") {
    return readFile(localFile(key));
  }
  if (mode === "managed") {
    const url = await storageGetSignedUrl(key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to read document from managed storage: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  const { bucket, client } = getS3Client();
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`Empty response body reading S3 key: ${key}`);
  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

export async function deletePrivateDocument(relKey: string): Promise<boolean> {
  const mode = getMode();
  const key = normalizeKey(relKey);
  if (mode === "local") {
    try {
      await unlink(localFile(key));
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // Document already absent from disk; idempotent erasure success
        return true;
      }
      throw err;
    }
  }
  if (mode === "managed") {
    // Managed storage stub does not support physical file deletion.
    // Statutory erasure must fail closed rather than falsely reporting physical erasure completion.
    throw new Error("[FreelanceHR] Physical document deletion is not supported in managed storage mode. Erasure cannot proceed safely.");
  }
  const { bucket, client } = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return true;
}


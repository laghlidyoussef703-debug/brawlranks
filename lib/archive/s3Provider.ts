/**
 * DATASET Phase 4 — S3-compatible object storage provider (DigitalOcean Spaces).
 *
 * Self-contained AWS Signature V4 over node:crypto + global fetch — no AWS SDK
 * dependency (which would touch package.json/lock). Credentials come ONLY from
 * the environment and are never logged; error messages never include a secret,
 * a signature, or an Authorization header.
 *
 * The signer (`signV4`) is a pure function, unit-tested against the published
 * AWS SigV4 test-suite "get-vanilla" vector, so the cryptography is proven even
 * though a live Spaces call requires owner-provisioned credentials/bucket.
 */

import { createHash, createHmac } from "node:crypto";
import type {
  HeadObjectResult,
  ObjectStorageProvider,
  PutObjectInput,
} from "./provider";
import { ObjectNotFoundError } from "./provider";

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

export interface S3Config {
  endpoint: string; // e.g. https://fra1.digitaloceanspaces.com
  region: string; // e.g. fra1
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Resolves S3 config from env. Returns null when not configured (so callers can
 *  fall back to a local/in-memory provider without throwing). */
export function resolveS3Config(env: Record<string, string | undefined> = process.env): S3Config | null {
  const endpoint = env.ARCHIVE_S3_ENDPOINT;
  const region = env.ARCHIVE_S3_REGION;
  const bucket = env.ARCHIVE_S3_BUCKET;
  const accessKeyId = env.ARCHIVE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.ARCHIVE_S3_SECRET_ACCESS_KEY;
  if (!endpoint && !region && !bucket && !accessKeyId && !secretAccessKey) return null;

  const missing: string[] = [];
  if (!endpoint) missing.push("ARCHIVE_S3_ENDPOINT");
  if (!region) missing.push("ARCHIVE_S3_REGION");
  if (!bucket) missing.push("ARCHIVE_S3_BUCKET");
  if (!accessKeyId) missing.push("ARCHIVE_S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("ARCHIVE_S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    throw new Error(`S3 archive storage is partially configured (missing ${missing.join(", ")}).`);
  }
  return {
    endpoint: endpoint!,
    region: region!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    forcePathStyle: (env.ARCHIVE_S3_FORCE_PATH_STYLE ?? "true").toLowerCase() !== "false",
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** RFC 3986 encoding used by SigV4 for the canonical URI (does not encode "/"). */
export function encodeRfc3986(segment: string, encodeSlash = true): string {
  return segment
    .split("")
    .map((ch) => {
      if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
      if (ch === "/" && !encodeSlash) return ch;
      return "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

export interface SignV4Input {
  method: string;
  host: string;
  canonicalUri: string; // already-encoded path, starting with "/"
  canonicalQuery?: string;
  headers: Record<string, string>; // must include host; values used as-is
  payloadHash: string; // hex sha256 of the body (or UNSIGNED-PAYLOAD)
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
}

export interface SignV4Result {
  authorization: string;
  signedHeaders: string;
  signature: string;
  credentialScope: string;
}

/** Pure AWS Signature V4. Returns the Authorization header value and parts. */
export function signV4(input: SignV4Input): SignV4Result {
  const service = input.service ?? SERVICE;
  const dateStamp = input.amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const headerNames = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    headerNames
      .map((name) => {
        const original = Object.keys(input.headers).find((k) => k.toLowerCase() === name)!;
        return `${name}:${input.headers[original].trim().replace(/\s+/g, " ")}`;
      })
      .join("\n") + "\n";
  const signedHeaders = headerNames.join(";");

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery ?? "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    input.amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, signedHeaders, signature, credentialScope };
}

function amzDateNow(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export class S3CompatibleObjectStorage implements ObjectStorageProvider {
  readonly name = "s3";
  private readonly host: string;
  private readonly baseProtocol: string;

  constructor(private readonly config: S3Config) {
    const url = new URL(config.endpoint);
    this.baseProtocol = url.protocol;
    // Path-style: host is the endpoint host, bucket is the first path segment.
    // Virtual-hosted: host is <bucket>.<endpoint-host>.
    this.host = config.forcePathStyle ? url.host : `${config.bucket}.${url.host}`;
  }

  private urlFor(key: string): { url: string; canonicalUri: string } {
    const encodedKey = encodeRfc3986(key, false);
    const canonicalUri = this.config.forcePathStyle
      ? `/${encodeRfc3986(this.config.bucket)}/${encodedKey}`
      : `/${encodedKey}`;
    return { url: `${this.baseProtocol}//${this.host}${canonicalUri}`, canonicalUri };
  }

  private signedRequest(
    method: string,
    key: string,
    body?: Buffer
  ): { url: string; headers: Record<string, string> } {
    const { url, canonicalUri } = this.urlFor(key);
    const amzDate = amzDateNow();
    const payloadHash = sha256hex(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };
    const { authorization } = signV4({
      method,
      host: this.host,
      canonicalUri,
      headers,
      payloadHash,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      amzDate,
    });
    return { url, headers: { ...headers, Authorization: authorization } };
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const { url, headers } = this.signedRequest("PUT", input.key, input.body);
    const metaHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.metadata ?? {})) {
      metaHeaders[`x-amz-meta-${k}`] = v;
    }
    // NOTE: x-amz-meta-* headers are not part of SignedHeaders here; Spaces
    // accepts unsigned user metadata. If a target rejects them, sign them too.
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        ...headers,
        ...metaHeaders,
        "content-type": input.contentType ?? "application/gzip",
      },
      // Buffer is a Uint8Array subclass; pass a plain Uint8Array view so the
      // fetch BodyInit overload matches across lib versions.
      body: new Uint8Array(input.body),
    });
    if (!res.ok) throw new Error(`S3 putObject failed: HTTP ${res.status}`);
  }

  async headObject(bucket: string, key: string): Promise<HeadObjectResult | null> {
    const { url, headers } = this.signedRequest("HEAD", key);
    const res = await fetch(url, { method: "HEAD", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 headObject failed: HTTP ${res.status}`);
    const len = res.headers.get("content-length");
    return { size: len ? Number(len) : 0 };
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    const { url, headers } = this.signedRequest("GET", key);
    const res = await fetch(url, { method: "GET", headers });
    if (res.status === 404) throw new ObjectNotFoundError(bucket, key);
    if (!res.ok) throw new Error(`S3 getObject failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

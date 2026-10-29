import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';

// Almacenamiento de archivos compatible con S3 (Cloudflare R2). Sin dependencias: la firma (AWS Signature V4) se arma acá.
// Las fotos NO pasan por la API: la API firma un permiso de subida de pocos minutos y el navegador sube directo.

const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

// RFC 3986: lo que firma AWS (encodeURIComponent deja sin codificar ! ' ( ) *)
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

export interface SigningInput {
  method: string;
  host: string;
  path: string; // ya codificado, empieza con /
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  date: Date;
  // encabezados que entran en la firma (nombres en minúscula). `host` se agrega solo.
  headers?: Record<string, string>;
}

function signingKey(secretKey: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
}

function canonical(input: SigningInput, query: Record<string, string>, payloadHash: string) {
  const headers: Record<string, string> = { ...(input.headers ?? {}), host: input.host };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k])}`)
    .join('&');
  const request = [input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  return { request, signedHeaders, canonicalQuery };
}

/** URL prefirmada (la firma va en la dirección): quien la tenga puede hacer UNA operación sobre ese archivo hasta que venza. */
export function presignUrl(input: SigningInput & { expiresSeconds: number; payloadHash?: string }): string {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const headers = input.headers ?? {};
  const signedNames = [...Object.keys(headers), 'host'].sort().join(';');
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKey}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': signedNames,
  };
  const { request, canonicalQuery } = canonical(input, query, input.payloadHash ?? 'UNSIGNED-PAYLOAD');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(request)].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretKey, day, input.region, input.service)).update(toSign, 'utf8').digest('hex');
  return `https://${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Encabezados de autorización para una llamada directa del servidor (sin cuerpo): HEAD, DELETE. */
export function authHeaders(input: SigningInput): Record<string, string> {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const payloadHash = sha256('');
  const headers = { ...(input.headers ?? {}), 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  const { request, signedHeaders } = canonical({ ...input, headers }, {}, payloadHash);
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(request)].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretKey, day, input.region, input.service)).update(toSign, 'utf8').digest('hex');
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const pathOf = (bucket: string, key: string) => `/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;

/** Dirección pública de una foto (la que ve el cliente), o null si no hay almacenamiento configurado o no hay foto. */
export function publicImageUrl(key: string | null | undefined): string | null {
  const base = (process.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  return key && base ? `${base}/${key.split('/').map(encode).join('/')}` : null;
}

export interface StoredObject {
  size: number;
  contentType: string;
}

@Injectable()
export class ObjectStorageService {
  private get cfg() {
    const env = process.env;
    return {
      account: (env.R2_ACCOUNT_ID ?? '').trim(),
      accessKey: (env.R2_ACCESS_KEY_ID ?? env.ACCESS_KEY_ID ?? '').trim(),
      secretKey: (env.R2_SECRET_ACCESS_KEY ?? env.SECRET_ACCESS_KEY ?? '').trim(),
      bucket: (env.R2_BUCKET ?? '').trim(),
      publicUrl: (env.R2_PUBLIC_URL ?? '').trim(),
    };
  }

  /** ¿Está todo configurado para subir y mostrar fotos? Si no, la función queda apagada (no rompe nada). */
  get enabled(): boolean {
    const c = this.cfg;
    return !!(c.account && c.accessKey && c.secretKey && c.bucket && c.publicUrl);
  }

  private base(method: string, key: string, headers?: Record<string, string>): SigningInput {
    const c = this.cfg;
    return {
      method,
      host: `${c.account}.r2.cloudflarestorage.com`,
      path: pathOf(c.bucket, key),
      region: 'auto',
      service: 's3',
      accessKey: c.accessKey,
      secretKey: c.secretKey,
      date: new Date(),
      headers,
    };
  }

  /** Permiso para que el navegador suba UN archivo con ese tipo, durante unos minutos. */
  presignPut(key: string, contentType: string, expiresSeconds = 300): string {
    return presignUrl({ ...this.base('PUT', key, { 'content-type': contentType }), expiresSeconds });
  }

  /** Sube un archivo desde el servidor (lo usa la subida por la API). */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.presignPut(key, contentType), { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(body) });
    if (!res.ok) throw new Error(`No se pudo guardar el archivo (${res.status})`);
  }

  private async call(method: 'HEAD' | 'DELETE', key: string): Promise<Response> {
    const input = this.base(method, key);
    return fetch(`https://${input.host}${input.path}`, { method, headers: { ...authHeaders(input) } });
  }

  /** Tamaño y tipo del archivo subido (null si no existe). */
  async head(key: string): Promise<StoredObject | null> {
    const res = await this.call('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`No se pudo consultar el archivo (${res.status})`);
    return { size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') ?? '' };
  }

  /** Borra el archivo; si ya no estaba, no pasa nada. */
  async delete(key: string): Promise<void> {
    const res = await this.call('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`No se pudo borrar el archivo (${res.status})`);
  }
}

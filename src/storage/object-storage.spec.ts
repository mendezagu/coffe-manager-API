import { authHeaders, presignUrl, publicImageUrl } from './object-storage';

describe('Firma de archivos (AWS Signature V4)', () => {
  // Ejemplo oficial de la documentación de AWS (URL prefirmada de lectura): si la firma coincide, el algoritmo está bien
  it('reproduce la firma de referencia de AWS', () => {
    const url = presignUrl({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
      expiresSeconds: 86400,
    });
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('la firma depende del tipo de archivo: no sirve para subir otra cosa', () => {
    const base = {
      method: 'PUT',
      host: 'cuenta.r2.cloudflarestorage.com',
      path: '/bucket/t/x/menu/a.webp',
      region: 'auto',
      service: 's3',
      accessKey: 'AK',
      secretKey: 'SK',
      date: new Date('2026-10-27T10:00:00Z'),
      expiresSeconds: 300,
    };
    const webp = presignUrl({ ...base, headers: { 'content-type': 'image/webp' } });
    const png = presignUrl({ ...base, headers: { 'content-type': 'image/png' } });
    expect(webp).not.toBe(png);
    expect(webp).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
    expect(webp).toContain('X-Amz-Expires=300');
    // no se filtra la clave secreta
    expect(webp).not.toContain('SK');
  });

  it('las llamadas del servidor llevan su autorización y no incluyen la clave secreta', () => {
    const h = authHeaders({
      method: 'DELETE',
      host: 'cuenta.r2.cloudflarestorage.com',
      path: '/bucket/a.webp',
      region: 'auto',
      service: 's3',
      accessKey: 'AK',
      secretKey: 'SECRETO',
      date: new Date('2026-10-27T10:00:00Z'),
    });
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261027\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(h)).not.toContain('SECRETO');
  });

  it('la dirección pública sale de R2_PUBLIC_URL y es null si no hay foto o no está configurado', () => {
    const prev = process.env.R2_PUBLIC_URL;
    process.env.R2_PUBLIC_URL = 'https://fotos.ejemplo.app/';
    expect(publicImageUrl('t/abc/menu/x.webp')).toBe('https://fotos.ejemplo.app/t/abc/menu/x.webp');
    expect(publicImageUrl(null)).toBeNull();
    process.env.R2_PUBLIC_URL = '';
    expect(publicImageUrl('t/abc/menu/x.webp')).toBeNull();
    process.env.R2_PUBLIC_URL = prev;
  });
});

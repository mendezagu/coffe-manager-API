import { HttpException, HttpStatus } from '@nestjs/common';

// Límite de pedidos por ventana de tiempo, en memoria. Alcanza para frenar abuso desde un mismo celular
// o una misma conexión; los límites que protegen al negocio (pedidos esperando, espera entre envíos)
// viven en la base de datos y valen aunque el servidor se reinicie.
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  // Anota un intento. Si ya se pasó del máximo, responde 429.
  hit(key: string, message = 'Demasiados intentos, esperá un momento'): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(now);
  }

  // Cuántos intentos quedan sin anotar uno nuevo
  isBlocked(key: string): boolean {
    const now = Date.now();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.max;
  }

  private sweep(now: number) {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

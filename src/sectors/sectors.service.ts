import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapSector } from '../common/mappers';

// Normaliza para comparar nombres: sin tildes, sin mayúsculas y con espacios colapsados.
// Así "Salón", "salon" y "  SALON " cuentan como el mismo sector.
export function normalizeSectorName(name: string): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

@Injectable()
export class SectorsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const sectors = await this.prisma.sector.findMany();
    return sectors
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'es'))
      .map(mapSector);
  }

  // Recibe los ids de todos los sectores en el orden deseado y guarda su posición.
  async reorder(ids: unknown) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      throw new BadRequestException('Se esperaba una lista de ids de sectores');
    }

    await this.prisma.$transaction(
      (ids as string[]).map((id, index) =>
        this.prisma.sector.updateMany({ where: { id }, data: { position: index } }),
      ),
    );
    return this.findAll();
  }

  async create(createSectorDto: any) {
    const name = this.cleanName(createSectorDto?.name);
    await this.assertNameAvailable(name);

    try {
      // el sector nuevo queda al final de la lista
      const last = await this.prisma.sector.aggregate({ _max: { position: true } });
      const position = (last._max.position ?? -1) + 1;
      const sector = await this.prisma.sector.create({ data: { name, position } });
      return mapSector(sector);
    } catch (error) {
      this.rethrowIfDuplicate(error);
      throw error;
    }
  }

  async update(id: string, updateSectorDto: any) {
    const name = this.cleanName(updateSectorDto?.name);
    await this.assertNameAvailable(name, id);

    try {
      const sector = await this.prisma.sector.update({ where: { id }, data: { name } });
      return mapSector(sector);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Sector no encontrado');
      }
      this.rethrowIfDuplicate(error);
      throw error;
    }
  }

  // Las mesas del sector no se borran: la FK es onDelete SetNull y quedan "sin sector".
  async remove(id: string): Promise<{ message: string }> {
    try {
      await this.prisma.sector.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Sector no encontrado');
      }
      throw error;
    }
    return { message: 'Sector eliminado' };
  }

  private cleanName(name: unknown): string {
    const cleaned = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!cleaned) {
      throw new BadRequestException('El nombre del sector es obligatorio');
    }
    return cleaned;
  }

  // Compara en memoria (son pocos sectores) para ignorar tildes y mayúsculas, cosa que
  // el índice único de la base no hace.
  private async assertNameAvailable(name: string, excludeId?: string) {
    const target = normalizeSectorName(name);
    const sectors = await this.prisma.sector.findMany();
    const duplicated = sectors.some(s => s.id !== excludeId && normalizeSectorName(s.name) === target);
    if (duplicated) {
      throw new ConflictException('Ya existe un sector con ese nombre');
    }
  }

  // Red de seguridad ante dos pedidos simultáneos: el índice único de la base lo frena.
  private rethrowIfDuplicate(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Ya existe un sector con ese nombre');
    }
  }
}

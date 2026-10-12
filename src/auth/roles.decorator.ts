import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';
// Restringe una ruta a los roles indicados. Sin @Roles, basta con estar logueado.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

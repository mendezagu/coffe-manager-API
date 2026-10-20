import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_KEY = 'allowPendingPassword';
// Un usuario al que le asignaron la contraseña (mustChangePassword) solo puede llamar a las rutas marcadas con esto
// (ver su sesión y cambiar la contraseña). Todo lo demás responde 403 hasta que la cambie.
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

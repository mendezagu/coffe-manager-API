// Menús de ejemplo para el asistente de primeros pasos. Los precios son inventados:
// el dueño los cambia por los suyos (o borra todo el ejemplo de una vez).
export interface MenuTemplate {
  key: string;
  label: string;
  categories: { name: string; items: { name: string; price: number }[] }[];
}

export const MENU_TEMPLATES: MenuTemplate[] = [
  {
    key: 'cafeteria',
    label: 'Cafetería',
    categories: [
      {
        name: 'Bebidas calientes',
        items: [
          { name: 'Café', price: 2500 },
          { name: 'Cortado', price: 2700 },
          { name: 'Capuchino', price: 3500 },
        ],
      },
      {
        name: 'Bebidas frías',
        items: [
          { name: 'Gaseosa', price: 2800 },
          { name: 'Agua mineral', price: 2000 },
          { name: 'Jugo de naranja', price: 3800 },
        ],
      },
      {
        name: 'Para comer',
        items: [
          { name: 'Medialuna', price: 1200 },
          { name: 'Tostado de jamón y queso', price: 5500 },
          { name: 'Torta del día', price: 4800 },
        ],
      },
    ],
  },
];

export const findTemplate = (key: string) => MENU_TEMPLATES.find((t) => t.key === key);

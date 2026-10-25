/**
 * Tarifas del carrier de ejemplo («Envíos Ejemplo»): tabla simple por zona y peso.
 * Son números inventados; en una app real acá consultás tu propio tarificador.
 */

export type Zone = "caba" | "gba" | "interior";

/** Zonificación de juguete por código postal de 4 dígitos. */
export function zoneFor(postalCode: string): Zone {
  const cp = Number(postalCode);
  if (cp >= 1000 && cp <= 1499) return "caba";
  if (cp >= 1500 && cp <= 1999) return "gba"; // aproximación del conurbano
  return "interior";
}

export interface Weight {
  value: number;
  unit: "g" | "kg";
}

export interface QuoteItem {
  quantity: number;
  weight?: Weight | null;
}

/** Si un producto no trae peso (puede faltar), asumimos 500 g para no cotizar $0. */
const DEFAULT_ITEM_GRAMS = 500;

export function totalGrams(items: QuoteItem[]): number {
  return items.reduce((sum, item) => {
    const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    const w = item.weight;
    const grams = w ? (w.unit === "kg" ? w.value * 1000 : w.value) : DEFAULT_ITEM_GRAMS;
    return sum + grams * qty;
  }, 0);
}

/** Precio base por escalón de peso (en pesos): hasta 1 kg, 5 kg, 10 kg y más. */
const BASE_PRICE: Record<Zone, [number, number, number, number]> = {
  caba: [3200, 4200, 5600, 7500],
  gba: [3900, 5100, 6800, 9200],
  interior: [5400, 7200, 9800, 13500],
};

const STANDARD_DAYS: Record<Zone, string> = {
  caba: "1 a 2 días",
  gba: "2 a 3 días",
  interior: "4 a 7 días",
};

function tier(grams: number): 0 | 1 | 2 | 3 {
  if (grams <= 1000) return 0;
  if (grams <= 5000) return 1;
  if (grams <= 10000) return 2;
  return 3;
}

export interface Method {
  method_id: string;
  name: string;
  price: number;
  estimated_days?: string | number;
  min_date?: string;
  max_date?: string;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Cotiza las opciones para un CP y un carrito. `items` puede venir vacío (bot de WhatsApp). */
export function quote(postalCode: string, items: QuoteItem[], now = new Date()): Method[] {
  const zone = zoneFor(postalCode);
  const grams = totalGrams(items);
  const price = BASE_PRICE[zone][tier(grams)];

  const methods: Method[] = [
    { method_id: "standard", name: "Envío estándar a domicilio", price, estimated_days: STANDARD_DAYS[zone] },
  ];

  // Entrega al día siguiente sólo en AMBA y hasta 5 kg.
  if (zone !== "interior" && grams <= 5000) {
    const next = new Date(now.getTime() + 24 * 3600 * 1000);
    methods.push({
      method_id: "express",
      name: "Entrega al día siguiente",
      price: Math.round(price * 1.8 * 100) / 100, // `price` siempre un NÚMERO, nunca un texto
      min_date: isoDate(next),
      max_date: isoDate(next),
    });
  }
  return methods;
}

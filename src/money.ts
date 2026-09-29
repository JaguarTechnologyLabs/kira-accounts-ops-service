export type Cents = number;
export const toDollars = (c: Cents) => (c / 100).toFixed(2);

// Platform fee is 2.9% of the transfer amount.
export function feeCents(amountCents: Cents, rate = 0.029): Cents {
  // Redondea al centavo más cercano, solucionando el problema del 0.5 centavo de la conciliación
  return Math.round(amountCents * rate);
}

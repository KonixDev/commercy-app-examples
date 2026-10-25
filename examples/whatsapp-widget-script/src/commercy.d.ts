// Tipos de `window.Commercy` según https://docs.commercy.com.ar (Scripts en la tienda).
// El objeto está congelado y no tiene datos personales.

export type CommercyPageType =
  | 'home' | 'product' | 'catalog' | 'search' | 'cart' | 'page' | 'contact' | 'other';

export interface CommercyEvents {
  page_viewed: { type: CommercyPageType; path: string };
  product_viewed: { productId: string; name: string; price: number; currency: string };
  product_added_to_cart: {
    productId: string; variantSku: string | null; name: string; price: number; quantity: number; currency: string;
  };
  checkout_started: {
    itemCount: number; subtotal: number; currency: string;
    items: ReadonlyArray<{ productId: string; variantSku: string | null; name: string; quantity: number; unitPrice: number }>;
  };
}

export interface CommercyGlobal {
  readonly version: 1;
  readonly store: Readonly<{
    id: string;
    shopId: string | null;
    name: string;
    domain: string;
    currency: string;
    locale: 'es-AR';
  }>;
  getPage(): Readonly<{
    type: CommercyPageType;
    path: string;
    product: Readonly<{ id: string; name: string; price: number }> | null;
  }>;
  getCart(): Readonly<{
    itemCount: number;
    subtotal: number;
    currency: string;
    items: ReadonlyArray<
      Readonly<{ productId: string; variantSku: string | null; name: string; quantity: number; unitPrice: number }>
    >;
  }>;
  getCustomer(): Readonly<{ loggedIn: boolean }>;
  /** Devuelve una función para desuscribirse. `page_viewed` y `product_viewed` se reenvían al suscribirte. */
  on<E extends keyof CommercyEvents>(event: E, cb: (payload: Readonly<CommercyEvents[E]>) => void): () => void;
  off<E extends keyof CommercyEvents>(event: E, cb: (payload: Readonly<CommercyEvents[E]>) => void): void;
}

declare global {
  interface Window {
    Commercy?: CommercyGlobal;
  }
}

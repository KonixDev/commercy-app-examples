/**
 * Empuje del seguimiento a Commercy. Commercy NO consulta el estado de los envíos:
 * lo informa la app con la API pública (scope `write_orders`) y el token de la instalación.
 */
import {
  CommercyClient,
  CommercyError,
  refreshAccessToken,
  type Credentials,
} from "./commercy.js";
import { installations, type Shipment, type ShipmentStatus } from "./store.js";

/** Paso siguiente de la simulación: en preparación → despachado → entregado. */
export const NEXT_STATUS: Partial<Record<ShipmentStatus, "preparing" | "shipped" | "delivered">> = {
  created: "preparing",
  preparing: "shipped",
  shipped: "delivered",
};

// Un refresh token se usa UNA vez: si dos requests refrescan a la vez, uno rompería al otro.
// Serializamos los refreshes por instalación compartiendo la promesa en curso.
const refreshing = new Map<string, Promise<void>>();

async function refresh(installationId: string, credentials: Credentials): Promise<void> {
  const inFlight = refreshing.get(installationId);
  if (inFlight) return inFlight;

  const job = (async () => {
    const inst = installations.get(installationId);
    if (!inst) throw new Error(`Instalación desconocida: ${installationId}`);
    const tokens = await refreshAccessToken(credentials, inst.refreshToken);
    installations.put({
      ...inst,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, // el anterior queda invalidado: SIEMPRE guardar el nuevo
      scope: tokens.scope,
    });
  })().finally(() => refreshing.delete(installationId));

  refreshing.set(installationId, job);
  return job;
}

/** Corre `fn` con el token de la instalación; si la API responde 401 renueva el token y reintenta una vez. */
async function withToken<T>(
  installationId: string,
  credentials: Credentials | null,
  fn: (client: CommercyClient) => Promise<T>,
): Promise<T> {
  const inst = installations.get(installationId);
  if (!inst) {
    throw new Error(`No tenemos el token de la instalación ${installationId}: instalá la app (GET /install) para poder informar el seguimiento.`);
  }
  try {
    return await fn(new CommercyClient(inst.accessToken));
  } catch (err) {
    if (!(err instanceof CommercyError) || err.status !== 401 || !credentials) throw err;
    await refresh(installationId, credentials);
    return fn(new CommercyClient(installations.get(installationId)!.accessToken));
  }
}

/**
 * Informa a Commercy el nuevo estado del envío.
 * - `shipped` también carga el seguimiento (número y link) en la venta.
 * - `delivered` CIERRA la venta (descuenta stock, mueve la caja, asiento contable):
 *   mandalo sólo cuando el paquete se entregó de verdad.
 */
export async function pushTracking(
  shipment: Shipment,
  next: "preparing" | "shipped" | "delivered",
  credentials: Credentials | null,
): Promise<void> {
  await withToken(shipment.installationId, credentials, async (client) => {
    await client.updateOrderStatus(shipment.orderId, next, `Envíos Ejemplo: ${shipment.code}`);
    if (next === "shipped") {
      await client.updateFulfillment(shipment.orderId, {
        tracking_number: shipment.trackingNumber,
        tracking_url: shipment.trackingUrl,
      });
    }
  });
}

import { ApiError } from "@/lib/rbac";
import type { Tx } from "@/lib/tx";
import { getSetting } from "@/lib/core/settings-service";

type Db = Pick<Tx, "warehouse" | "storageLocation">;

/** The warehouse a screen means when it does not name one (a setting, not a constant). */
export async function resolveWarehouse(db: Db, warehouseId?: string | null) {
  if (warehouseId) {
    const w = await db.warehouse.findUnique({ where: { id: warehouseId } });
    if (!w) throw new ApiError(404, "المخزن مش موجود");
    if (!w.active) throw new ApiError(400, `المخزن ${w.code} موقوف`);
    return w;
  }
  const code = await getSetting("inventory.default_warehouse_code");
  const w = await db.warehouse.findUnique({ where: { code } });
  if (!w || !w.active) throw new ApiError(500, `المخزن الافتراضي (${code}) مش موجود أو موقوف — راجع إعدادات المخزون`);
  return w;
}

/** Where received goods land by default: the warehouse's receiving bay. */
export async function receivingLocation(db: Db, warehouseId: string) {
  const loc =
    (await db.storageLocation.findFirst({ where: { warehouseId, type: "receiving", active: true }, orderBy: { code: "asc" } })) ??
    (await db.storageLocation.findFirst({ where: { warehouseId, active: true }, orderBy: { code: "asc" } }));
  if (!loc) throw new ApiError(400, "المخزن ده مفيهوش أماكن تخزين نشطة");
  return loc;
}

export async function resolveLocation(db: Db, warehouseId: string, locationId: string | null | undefined) {
  if (!locationId) return receivingLocation(db, warehouseId);
  return checkedLocation(await db.storageLocation.findUnique({ where: { id: locationId } }), warehouseId);
}

/** resolveLocation's checks on a location already read: it belongs to the warehouse and is active. */
export function checkedLocation<L extends { warehouseId: string; active: boolean; code: string }>(loc: L | null | undefined, warehouseId: string): L {
  if (!loc || loc.warehouseId !== warehouseId) throw new ApiError(400, "مكان التخزين مش تابع للمخزن ده");
  if (!loc.active) throw new ApiError(400, `المكان ${loc.code} موقوف`);
  return loc;
}

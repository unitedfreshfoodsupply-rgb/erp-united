import type { MovementKind } from "@/lib/stock-service";

export type SupplierDTO = {
  id: string;
  name: string;
  nameAr?: string | null;
  /** vegetable | fruit; null = unclassified (added at the stock gate, purchasing classifies it). */
  category?: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  version: number;
};

export type ProductAliasDTO = {
  id: string;
  productId: string;
  alias: string;
  normalized: string;
  kind: "canonical" | "canonical_ar" | "manual";
  createdBy: string;
  createdAt: string;
};

export type StockProductDTO = {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  category: string | null;
  unit: string;
  active: boolean;
  stockTracked: boolean;
  version: number;
  aliases?: ProductAliasDTO[];
  _count?: { orderItems: number; intakes: number };
};

export type ResolvedProductDTO = {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  unit: string;
  active: boolean;
  stockTracked: boolean;
};

export type CoverageRowDTO = {
  productName: string;
  unit: string;
  normalized: string;
  lineCount: number;
  orderCount: number;
  status: "mapped" | "unmapped" | "ambiguous";
  product: ResolvedProductDTO | null;
  inactiveMapping: boolean;
  unitMismatch: boolean;
  candidates: ResolvedProductDTO[];
};

export type CoverageDTO = {
  rows: CoverageRowDTO[];
  summary: {
    distinctNames: number;
    mapped: number;
    unmapped: number;
    ambiguous: number;
    inactiveMappings: number;
    unitMismatches: number;
    totalLines: number;
    mappedLines: number;
  };
};

export type IntakeDTO = {
  id: string;
  receiptNumber: string;
  receivedDate: string;
  supplierId: string;
  productId: string;
  receivedKg: number;
  crateCount: number | null;
  rejectedKg: number;
  goodKg: number;
  notes: string | null;
  status: "posted" | "voided";
  recordedBy: string;
  version: number;
  createdAt: string;
  supplier: { id: string; name: string };
  product: { id: string; name: string; nameAr?: string | null; unit: string };
  /** Exact decimal strings (the *Kg numbers above are the legacy display copies). */
  receivedQty?: string;
  rejectedQty?: string;
  goodQty?: string;
  /** Grade B / فرزة and waste / هالك splits decoded at intake (additive F-08). */
  gradeBQty?: string;
  wasteQty?: string;
  gradeBProduct?: { id: string; name: string; unit: string } | null;
  enteredQty?: string | null;
  enteredUom?: string | null;
  lot?: { id: string; lotNumber: string; expiryDate: string | null } | null;
  location?: { id: string; code: string } | null;
  rejectionReason?: string | null;
  purchaseOrderLine?: { id: string; lineNo: number; po: { id: string; number: string } } | null;
};

export type MovementDTO = {
  id: string;
  productId: string;
  occurredAt: string;
  effectiveDate: string;
  kind: MovementKind;
  quantityKg: number;
  intakeId: string | null;
  reason: string | null;
  actorName: string;
  product: { id: string; name: string; nameAr?: string | null; unit: string };
  intake: { id: string; receiptNumber: string; supplier: { name: string; nameAr?: string | null } } | null;
};

export type StockBalanceDTO = {
  productId: string;
  productName: string;
  productNameAr?: string | null;
  unit: string;
  active: boolean;
  balanceKg: number;
};

export type PeriodTotalsDTO = {
  from: string;
  to: string;
  receivedKg: number;
  rejectedKg: number;
  goodKg: number;
  crates: number;
  yieldPct: number | null;
  intakeCount: number;
  /** The same sums per base unit, kg first — what a screen shows (kg and pieces never add up). */
  byUnit: { unit: string; received: number; good: number; rejected: number; intakeCount: number }[];
};

export type SupplierPerformanceDTO = {
  supplierId: string;
  supplierName: string;
  supplierNameAr?: string | null;
  intakeCount: number;
  receivedKg: number;
  rejectedKg: number;
  goodKg: number;
  yieldPct: number | null;
  lastDeliveryDate: string | null;
};

export type ProductTotalsDTO = {
  productId: string;
  productName: string;
  productNameAr?: string | null;
  unit: string;
  intakeCount: number;
  receivedKg: number;
  rejectedKg: number;
  goodKg: number;
  yieldPct: number | null;
};

export type StockDashboardDTO = {
  generatedAt: string;
  date: string;
  today: PeriodTotalsDTO;
  week: PeriodTotalsDTO;
  month: PeriodTotalsDTO;
  currentStock: StockBalanceDTO[];
  totalStockKg: number;
  /** The current balance per base unit, kg first. */
  stockTotalsByUnit: { unit: string; balance: number }[];
  /** Per product, what can be sold (default warehouse, the inventory module's rule): available
   * = sellable on hand − reserved; unsellable = waste awaiting write-off, quarantine, expired.
   * null when no default warehouse is set up. */
  sellable: Record<string, { available: number; reserved: number; unsellable: number }> | null;
  recentMovements: MovementDTO[];
  supplierPerformance: SupplierPerformanceDTO[];
  todayByProduct: ProductTotalsDTO[];
  todayIntakes: IntakeDTO[];
};

export type StockAuditDTO = {
  id: string;
  timestamp: string;
  userName: string;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
};

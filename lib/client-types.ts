import type { OrderStatus, ItemStatus } from "@/lib/types";

export type OrderItemDTO = {
  id: string;
  orderId: string;
  productId: string | null;
  productName: string;
  /** The catalogue product's names, when the line is linked to one. */
  stockProduct?: { name: string; nameAr: string | null } | null;
  unit: string;
  requiredQuantity: number;
  preparedQuantity: number | null;
  loadedQuantity: number | null;
  preparationStatus: ItemStatus;
  loadingStatus: ItemStatus;
  notes: string | null;
  version: number;
  /** Canonical Product Master id, or null when the line is UNMAPPED. */
  stockProductId: string | null;
};

export type OrderDTO = {
  id: string;
  orderNumber: string;
  externalId: string | null;
  customerId: string | null;
  customerAccountId?: string | null;
  customerName: string;
  /** The linked customer account's names (absent for unmapped orders). */
  customerAccount?: { name: string; nameAr: string | null; code: string } | null;
  deliveryDate: string;
  deliveryTime: string | null;
  notes: string | null;
  status: OrderStatus;
  shortage: boolean;
  needsReview: boolean;
  vehicle: string | null;
  driverName: string | null;
  crateCount: number | null;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItemDTO[];
};

export type PriorityReason =
  | "blocked_approval"
  | "stalled"
  | "delivery_risk"
  | "waiting_to_start"
  | "ready_for_loading"
  | "loading"
  | "on_track";

export type ClassifiedOrderDTO = {
  id: string;
  orderNumber: string;
  customerName: string;
  status: OrderStatus;
  reason: PriorityReason;
  reasonLabel: string;
  whyItMatters: string;
  recommendedAction: string;
  minutesInStage: number;
  enteredCurrentStatusAt: string;
};

export type BottleneckStageDTO = { status: OrderStatus; count: number; avgMinutes: number; maxMinutes: number };

export type OperationalHealthDTO = {
  level: "healthy" | "attention" | "critical";
  reasons: string[];
  /** `reasons` as dictionary keys with their counts (newer servers). */
  reasonKeys?: { key: string; count: number }[];
  counts: {
    activeOrders: number;
    stalledOrders: number;
    blockedApprovals: number;
    deliveryRisk: number;
    readyLoadingBacklog: number;
  };
};

export type OperationalIntelligenceDTO = {
  generatedAt: string;
  orders: ClassifiedOrderDTO[];
  needsAttention: ClassifiedOrderDTO[];
  bottleneck: {
    byStage: BottleneckStageDTO[];
    currentBottleneckStage: OrderStatus | null;
    mostStalledOrder: ClassifiedOrderDTO | null;
  };
  health: OperationalHealthDTO;
};

export type DailyReportDTO = {
  date: string;
  ordersReceivedToday: number;
  byStatusToday: Record<string, number>;
  pipelineNow: Record<string, number>;
  quantitiesToday: { required: number; prepared: number; loaded: number };
  exceptionsActive: number;
  exceptionsInformational: number;
  stalledCount: number;
  dispatchedToday: number;
  completionPct: number | null;
  bottleneck: OperationalIntelligenceDTO["bottleneck"];
  health: OperationalHealthDTO;
  needsAttention: ClassifiedOrderDTO[];
  needsAttentionTotal: number;
};

export type AuditLogDTO = {
  id: string;
  timestamp: string;
  userId: string | null;
  userName: string;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  source: string;
  deviceId: string | null;
  orderId: string | null;
  order?: { orderNumber: string; customerName: string } | null;
  itemName?: string | null;
  itemUnit?: string | null;
};

import type { OrderDTO, OrderItemDTO } from "@/lib/client-types";
import type { OrderStatus } from "@/lib/types";
import { qty } from "@/lib/format";

/**
 * One place that answers, for any order: what stage is it at, how much is actually
 * done, how much is left, and what needs to happen next.
 *
 * Every board was computing pieces of this inline and disagreeing about the details —
 * one counted finished items, another counted quantities, none of them said what was
 * remaining. Operators were left subtracting numbers in their heads.
 */

export type StageKey = "prepare" | "load" | "done" | "cancelled";

/** Which physical activity the order is in right now, regardless of status naming. */
export function stageOf(status: OrderStatus): StageKey {
  if (status === "cancelled") return "cancelled";
  if (status === "dispatched") return "done";
  if (status === "loading" || status === "loaded" || status === "ready_for_loading") return "load";
  return "prepare";
}

/** What the status MEANS operationally — not a renamed database value. */
export const STATUS_MEANING: Record<OrderStatus, string> = {
  new: "وصل ولسه محدش بدأ فيه",
  preparing: "بيتجهز دلوقتي في الصالة",
  ready_for_loading: "خلص تجهيز ومستني التحميل",
  loading: "بيتحمّل على العربية دلوقتي",
  loaded: "اتحمّل كله ومستني تأكيد الخروج",
  dispatched: "خرج مع العربية",
  cancelled: "اتلغى",
};

export const STATUS_MEANING_EN: Record<OrderStatus, string> = {
  new: "Received — nobody has started it yet",
  preparing: "Being prepared on the floor now",
  ready_for_loading: "Prepared and waiting to be loaded",
  loading: "Being loaded onto the vehicle now",
  loaded: "Fully loaded — waiting for dispatch confirmation",
  dispatched: "Left with the vehicle",
  cancelled: "Cancelled",
};

export type QuantityRoll = {
  required: number;
  prepared: number;
  loaded: number;
  /** Still to prepare / still to load, in the unit of the order's items. */
  remainingToPrepare: number;
  remainingToLoad: number;
  itemsTotal: number;
  itemsPrepared: number;
  itemsLoaded: number;
  /** True when every unit is a KG-style weight, so one total is meaningful. */
  singleUnit: string | null;
};

export function rollUpQuantities(items: OrderItemDTO[]): QuantityRoll {
  const units = new Set(items.map((i) => i.unit));
  let required = 0, prepared = 0, loaded = 0, remainingToPrepare = 0, remainingToLoad = 0;
  let itemsPrepared = 0, itemsLoaded = 0;

  for (const i of items) {
    required += i.requiredQuantity;
    prepared += i.preparedQuantity ?? 0;
    loaded += i.loadedQuantity ?? 0;
    if (i.preparationStatus === "done") itemsPrepared++;
    else remainingToPrepare += Math.max(0, i.requiredQuantity - (i.preparedQuantity ?? 0));
    if (i.loadingStatus === "done") itemsLoaded++;
    else remainingToLoad += Math.max(0, (i.preparedQuantity ?? i.requiredQuantity) - (i.loadedQuantity ?? 0));
  }

  return {
    required, prepared, loaded,
    remainingToPrepare, remainingToLoad,
    itemsTotal: items.length, itemsPrepared, itemsLoaded,
    singleUnit: units.size === 1 ? [...units][0] : null,
  };
}

/** Per-item shortfall against what was asked for — the number nobody should compute by hand. */
export function itemShortfall(item: OrderItemDTO, stage: StageKey) {
  const actual = stage === "load" ? item.loadedQuantity : item.preparedQuantity;
  if (actual === null || actual === undefined) return null;
  const diff = Math.round((item.requiredQuantity - actual) * 1000) / 1000;
  return diff > 0 ? diff : null;
}

export type NextAction = {
  /** Short imperative for the card: "ابدأ التجهيز". */
  label: string;
  /** Who it is waiting on, in plain words. */
  owner: string;
  tone: "action" | "waiting" | "blocked" | "done";
};

/**
 * "What needs to happen NOW" — the question every board exists to answer, and the one
 * the UI previously left the operator to infer from a status badge.
 */
export function nextAction(order: OrderDTO, locale: "ar" | "en" = "ar"): NextAction {
  const en = locale === "en";
  const PREP = en ? "Preparation" : "التجهيز";
  const LOAD = en ? "Loading" : "التحميل";
  if (order.status === "cancelled") return { label: en ? "Cancelled" : "اتلغى", owner: "—", tone: "done" };
  if (order.status === "dispatched") return { label: en ? "Done — dispatched" : "خلص وخرج", owner: "—", tone: "done" };
  if (order.needsReview) {
    return { label: en ? "Needs supervisor approval" : "محتاج اعتماد المشرف", owner: en ? "Supervisor" : "المشرف", tone: "blocked" };
  }
  const roll = rollUpQuantities(order.items);
  switch (order.status) {
    case "new":
      return { label: en ? "Start preparation" : "ابدأ التجهيز", owner: PREP, tone: "action" };
    case "preparing":
      return roll.itemsPrepared < roll.itemsTotal
        ? { label: en ? `Prepare the remaining ${roll.itemsTotal - roll.itemsPrepared} item(s)` : `جهّز باقي ${roll.itemsTotal - roll.itemsPrepared} صنف`, owner: PREP, tone: "action" }
        : { label: en ? "Confirm preparation is finished" : "أكّد إن التجهيز خلص", owner: PREP, tone: "action" };
    case "ready_for_loading":
      return { label: en ? "Start loading" : "ابدأ التحميل", owner: LOAD, tone: "action" };
    case "loading":
      return roll.itemsLoaded < roll.itemsTotal
        ? { label: en ? `Load the remaining ${roll.itemsTotal - roll.itemsLoaded} item(s)` : `حمّل باقي ${roll.itemsTotal - roll.itemsLoaded} صنف`, owner: LOAD, tone: "action" }
        : { label: en ? "Confirm loading is finished" : "أكّد إن التحميل خلص", owner: LOAD, tone: "action" };
    case "loaded":
      return { label: en ? "Confirm the vehicle left" : "أكّد خروج العربية", owner: LOAD, tone: "action" };
    default:
      return { label: "—", owner: "—", tone: "waiting" };
  }
}

/** One-line shortage summary for a card: "ناقص ٣ كجم في صنفين". */
export function shortageSummary(order: OrderDTO, locale: "ar" | "en" = "ar"): string | null {
  const stage = stageOf(order.status);
  if (stage === "cancelled") return null;
  const shorts = order.items
    .map((i) => ({ item: i, missing: itemShortfall(i, stage === "done" ? "load" : stage) }))
    .filter((x): x is { item: OrderItemDTO; missing: number } => x.missing !== null);
  if (shorts.length === 0) return null;
  const units = new Set(shorts.map((s) => s.item.unit));
  const total = shorts.reduce((s, x) => s + x.missing, 0);
  if (locale === "en") {
    const amountEn = units.size === 1 ? `${qty(total)} ${[...units][0]}` : `${shorts.length} items`;
    return shorts.length === 1
      ? `Short ${qty(shorts[0].missing)} ${shorts[0].item.unit} — ${shorts[0].item.productName}`
      : `Short ${amountEn} across ${shorts.length} items`;
  }
  const amount = units.size === 1 ? `${qty(total)} ${[...units][0]}` : `${shorts.length} صنف`;
  return shorts.length === 1
    ? `ناقص ${qty(shorts[0].missing)} ${shorts[0].item.unit} — ${shorts[0].item.productName}`
    : `ناقص ${amount} في ${shorts.length} أصناف`;
}

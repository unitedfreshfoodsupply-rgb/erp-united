import type { OrderStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_LABEL_EN } from "@/lib/orderPresentation";
import { useLocale } from "@/lib/locale";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";

/** Order lifecycle → the shared status tones (components/ui/StatusPill.tsx). */
const TONE: Record<OrderStatus, Tone> = {
  new: "info",
  preparing: "warn",
  ready_for_loading: "success",
  loading: "warn",
  loaded: "success",
  dispatched: "neutral",
  cancelled: "neutral",
};

/** The colour of an order stage's dot, wherever a stage is listed without a full pill. */
export const ORDER_DOT: Record<OrderStatus, string> = {
  new: "bg-united-info",
  preparing: "bg-[#E2A33B]",
  ready_for_loading: "bg-united-green",
  loading: "bg-[#E2A33B]",
  loaded: "bg-united-green",
  dispatched: "bg-united-muted",
  cancelled: "bg-united-border-strong",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { locale } = useLocale();
  return (
    <StatusPill tone={TONE[status]} size="md" strike={status === "cancelled"}>
      {locale === "en" ? STATUS_LABEL_EN[status] : STATUS_LABEL[status]}
    </StatusPill>
  );
}

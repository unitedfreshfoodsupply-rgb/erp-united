"use client";

import {
  AlertTriangle, Banknote, Building2, CheckCircle2, ClipboardList, FileText, FolderOpen, Hotel, Inbox, Landmark,
  Leaf, Mail, Package, Receipt, Scale, ShieldCheck, ShoppingCart, Tag, Truck, Users, type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/lib/locale";

/** Call sites still pass the emoji they always passed; each maps to one line icon so the
 * empty states look the same on every device (emoji render per-OS). Unknown → Inbox. */
const EMOJI_ICON: Record<string, LucideIcon> = {
  "📦": Package, "📭": Inbox, "✅": CheckCircle2, "👍": CheckCircle2, "🧾": Receipt, "🚚": Truck,
  "🛒": ShoppingCart, "👥": Users, "💵": Banknote, "🏦": Landmark, "🏢": Building2, "🏨": Hotel,
  "🏷️": Tag, "📄": FileText, "📋": ClipboardList, "📨": Mail, "🗂️": FolderOpen, "🛡️": ShieldCheck,
  "⚖️": Scale, "🍃": Leaf,
};

export function LoadingState({ label }: { label?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16" role="status" aria-live="polite">
      <div aria-hidden className="h-8 w-8 animate-spin rounded-full border-[3px] border-united-green/20 border-t-united-green motion-reduce:animate-none" />
      <p className="text-sm text-united-muted">{label ?? t("ui.loading")}</p>
    </div>
  );
}

export function EmptyState({ icon = "📦", title }: { icon?: string | LucideIcon; title?: string }) {
  const { t } = useLocale();
  const Icon = typeof icon === "string" ? EMOJI_ICON[icon] ?? Inbox : icon;
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-united-subtle text-united-muted">
        <Icon size={22} />
      </span>
      <p className="max-w-sm text-sm font-medium text-united-muted">{title || t("ui.empty")}</p>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center" role="alert">
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-[#FDECEA] text-united-danger">
        <AlertTriangle size={22} />
      </span>
      <p className="max-w-md text-sm font-semibold text-united-danger">{message || t("ui.error-try")}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary btn-sm">
          {t("ui.retry")}
        </button>
      )}
    </div>
  );
}

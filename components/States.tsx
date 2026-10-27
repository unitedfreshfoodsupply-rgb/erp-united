"use client";

import { useLocale } from "@/lib/locale";

export function LoadingState({ label }: { label?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="w-10 h-10 border-[3px] border-united-green/20 border-t-united-green rounded-full animate-spin" />
      <p className="text-united-muted font-bold">{label ?? t("ui.loading")}</p>
    </div>
  );
}

export function EmptyState({ icon = "📦", title }: { icon?: string; title?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
      <span className="text-3xl opacity-50">{icon}</span>
      <p className="text-united-muted font-bold">{title || t("ui.empty")}</p>
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
    <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
      <div className="w-12 h-12 rounded-full bg-united-danger/10 flex items-center justify-center text-xl">
        <span>⚠️</span>
      </div>
      <div>
        <p className="text-united-danger font-bold">{message || t("ui.error-try")}</p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary text-sm">
          {t("ui.retry")}
        </button>
      )}
    </div>
  );
}
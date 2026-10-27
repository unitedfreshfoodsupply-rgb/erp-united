"use client";

import { useLocale } from "@/lib/locale";

/** Simple page-navigation widget: prev / next with page count. */
export function Pagination({
  page, pageSize, total, onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const { t } = useLocale();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-2 text-sm font-bold">
      <span className="text-united-muted">
        {t("ui.pagination.summary", { page, totalPages, total })}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          className="btn-ghost btn-sm disabled:opacity-30"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          {t("ui.pagination.prev")}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm disabled:opacity-30"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          {t("ui.pagination.next")}
        </button>
      </div>
    </div>
  );
}
"use client";

import { useLocale } from "@/lib/locale";

/**
 * Skeletons, not spinners.
 *
 * A spinner replaces the screen and destroys the operator's context — on a tablet in
 * a packing hall, losing the list you were reading because one request is in flight is
 * worse than waiting. A skeleton keeps the shape of what is coming, so the eye stays
 * where it was and the wait reads as "loading this row" rather than "the app reset".
 */
export function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-united-subtle motion-reduce:animate-none ${className}`} />;
}

export function OrderCardSkeleton() {
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1">
          <SkeletonLine className="h-6 w-2/3 mb-2" />
          <SkeletonLine className="h-4 w-1/2" />
        </div>
        <SkeletonLine className="h-7 w-24 rounded-full" />
      </div>
      <SkeletonLine className="h-1.5 w-full mt-4" />
      <div className="flex gap-2 mt-3">
        <SkeletonLine className="h-4 w-24" />
        <SkeletonLine className="h-4 w-16" />
      </div>
    </div>
  );
}

export function BoardSkeleton({ rows = 3 }: { rows?: number }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label={t("ui.skeleton.orders")}>
      {Array.from({ length: rows }).map((_, i) => (
        <OrderCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card p-5" aria-busy="true">
      <SkeletonLine className="h-6 w-1/2 mb-3" />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} className="h-4 w-full mb-2" />
      ))}
    </div>
  );
}

export function TimelineSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3 items-start">
          <SkeletonLine className="h-6 w-6 rounded-full shrink-0" />
          <div className="flex-1">
            <SkeletonLine className="h-3 w-32 mb-1.5" />
            <SkeletonLine className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

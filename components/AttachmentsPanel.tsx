"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiClientError, errorMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/Toast";
import { ATTACHMENT_CATEGORIES, ATTACHMENT_CATEGORY_LABEL, type AttachmentCategory } from "@/lib/core/attachment-entities";
import { useLocale } from "@/lib/locale/useLocale";
import { useDialogs } from "@/components/ui/Dialog";

type AttachmentDTO = {
  id: string;
  category: AttachmentCategory;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  description: string | null;
  uploadedBy: string;
  createdAt: string;
};

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Files attached to one business record. Listing follows the record's view
 * permission and uploading/removing its manage permission — both enforced by the
 * server; `canManage` only decides whether the buttons are shown.
 */
export function AttachmentsPanel({ entityType, entityId, canManage }: { entityType: string; entityId: string; canManage: boolean }) {
  const dialogs = useDialogs();
  const { t } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<AttachmentCategory>("other");
  const [busy, setBusy] = useState(false);
  const key = ["attachments", entityType, entityId];

  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ attachments: AttachmentDTO[] }>(
        `/api/attachments?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`
      ),
  });

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("entity_type", entityType);
      form.set("entity_id", entityId);
      form.set("category", category);
      form.set("file", file);
      // Not apiFetch: that forces a JSON content type, and a multipart body needs the
      // browser to set its own boundary.
      const res = await fetch("/api/attachments", {
        method: "POST",
        body: form,
        credentials: "include",
        headers: typeof window !== "undefined" && window.sessionStorage.getItem("united_token")
          ? { Authorization: `Bearer ${window.sessionStorage.getItem("united_token")}` }
          : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiClientError(typeof data?.error === "string" && data.error ? data.error : t("ui.attachment-error-status", { status: res.status }));
      toast.show(data.duplicate ? t("ui.attachment-duplicate") : t("ui.attachment-uploaded"), "success");
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("ui.attachment-upload-error"), "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(a: AttachmentDTO) {
    const reason = await dialogs.prompt({ title: t("ui.attachment-delete-prompt", { name: a.fileName }), label: t("ui.reason-label"), required: true, tone: "danger", confirmLabel: t("ui.delete") });
    if (!reason) return;
    try {
      await apiFetch(`/api/attachments/${a.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.show(err instanceof ApiClientError ? err.message : t("ui.error"), "error");
    }
  }

  const items = q.data?.attachments ?? [];
  return (
    <div>
      {q.isError && <p className="text-sm font-bold text-united-danger">{errorMessage(q.error) ?? t("ui.attachment-fetch-error")}</p>}
      {items.length === 0 && !q.isLoading && <p className="text-sm font-bold text-united-muted">{t("ui.attachment-empty")}</p>}
      <ul className="flex flex-col divide-y divide-united-border">
        {items.map((a) => (
          <li key={a.id} className="py-2 flex items-center justify-between gap-2">
            <a
              href={`/api/attachments/${a.id}/download${/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(a.contentType) ? "?inline=1" : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1"
            >
              <span className="block font-bold text-united-dark truncate">{a.fileName}</span>
              <span className="block text-xs font-bold text-united-muted">
                {ATTACHMENT_CATEGORY_LABEL[a.category] ?? a.category} · {size(a.sizeBytes)} · {a.uploadedBy}
              </span>
            </a>
            {canManage && (
              <button type="button" onClick={() => remove(a)} className="btn-danger !min-h-0 py-1.5 px-3 text-xs">
                {t("ui.attachment-delete-btn")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="mt-3 flex gap-2 flex-wrap">
          <select className="field !w-auto" value={category} onChange={(e) => setCategory(e.target.value as AttachmentCategory)}>
            {ATTACHMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ATTACHMENT_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <input
            ref={input}
            type="file"
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.xlsx,.xls,.docx,.doc,.csv"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? t("ui.attachment-uploading") : t("ui.attachment-upload-btn")}
          </button>
        </div>
      )}
    </div>
  );
}

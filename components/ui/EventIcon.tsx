import {
  ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, Ban, CheckCircle2, CheckSquare, Circle, ClipboardList, Copy, CreditCard, Flag,
  Hand, Hourglass, Link2, Lock, Package, Paperclip, Pencil, RefreshCw, Scale, Shuffle, Tag, ThumbsUp, Trash2, TriangleAlert,
  Truck, Undo2, Unlink, Unlock, User, Wrench, type LucideIcon,
} from "lucide-react";

/**
 * The audit trail and stock ledger describe events with a symbol from lib/auditLabels.ts and
 * lib/stockPresentation.ts (shared with print and server code, so they stay plain strings).
 * On screen each symbol becomes one line icon — emoji render differently per device and are
 * read aloud as their emoji name. Unknown symbols fall back to a neutral dot.
 */
const MAP: Record<string, LucideIcon> = {
  "📥": ArrowDownToLine, "📤": ArrowUpFromLine, "✏️": Pencil, "↩️": Undo2, "🔙": Undo2, "⚖️": Scale, "➡️": ArrowRightLeft, "⬅️": ArrowRightLeft,
  "🚚": Truck, "🗑️": Trash2, "🔀": Shuffle, "🔓": Unlock, "🔒": Lock, "🧰": Wrench, "📦": Package, "✅": CheckCircle2, "✓": CheckCircle2,
  "🏁": Flag, "🚫": Ban, "🔄": RefreshCw, "⚠️": TriangleAlert, "👍": ThumbsUp, "📋": Copy, "👤": User, "☑️": CheckSquare, "✋": Hand,
  "💳": CreditCard, "📎": Paperclip, "🔗": Link2, "✂️": Unlink, "🏷️": Tag, "⏳": Hourglass, "🗒️": ClipboardList,
};

export function EventIcon({ symbol, size = 15, className = "" }: { symbol: string; size?: number; className?: string }) {
  const Icon = MAP[symbol] ?? Circle;
  return <Icon size={size} aria-hidden className={className} />;
}

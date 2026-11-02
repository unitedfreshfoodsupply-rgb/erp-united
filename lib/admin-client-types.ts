import type { Role } from "@/lib/types";
import type { Permission, PermissionGroup } from "@/lib/permissions";

export type AdminUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  active: boolean;
  version: number;
  createdAt: string;
  overrideCount: number;
  /** WS6: two-step sign-in set up (absent from older servers). */
  mfaEnabled?: boolean;
};

export type EffectivePermissionRow = {
  key: Permission;
  group: PermissionGroup;
  label: string;
  description: string;
  fromRole: boolean;
  override: "grant" | "revoke" | null;
  effective: boolean;
};

export type UserPermissionDetail = {
  user: { id: string; name: string; username: string; role: Role; active: boolean; version: number };
  absoluteRole: boolean;
  permissions: EffectivePermissionRow[];
};

export type MatrixRole = {
  role: Role;
  absolute: boolean;
  permissions: string[];
  inSync: boolean;
  activeUsers: number;
  disabledUsers: number;
};

export type AdminOverview = {
  matrix: {
    permissions: { key: Permission; group: PermissionGroup; label: string; description: string }[];
    roles: MatrixRole[];
    catalogueInSync: boolean;
  };
  overview: {
    totalUsers: number;
    activeUsers: number;
    disabledUsers: number;
    activeSuperAdmins: number;
    overrides: {
      userId: string;
      userName: string;
      username: string;
      role: Role;
      permissionKey: string;
      permissionLabel: string;
      effect: "grant" | "revoke";
      reason: string | null;
      grantedBy: string;
      updatedAt: string;
    }[];
  };
  audit: {
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
  }[];
};

export const SECURITY_ACTION_LABEL: Record<string, string> = {
  user_created: "إنشاء مستخدم",
  user_updated: "تعديل مستخدم",
  user_enabled: "تفعيل مستخدم",
  user_disabled: "إيقاف مستخدم",
  user_role_changed: "تغيير دور",
  user_permission_granted: "منح صلاحية",
  user_permission_revoked: "سحب صلاحية",
  user_permission_override_cleared: "إلغاء استثناء",
  setting_changed: "تغيير إعداد",
  setting_reset: "رجوع إعداد للافتراضي",
};

export const SECURITY_ACTION_LABEL_EN: Record<string, string> = {
  user_created: "User created",
  user_updated: "User updated",
  user_enabled: "User enabled",
  user_disabled: "User disabled",
  user_role_changed: "Role changed",
  user_permission_granted: "Permission granted",
  user_permission_revoked: "Permission revoked",
  user_permission_override_cleared: "Override cleared",
  setting_changed: "Setting changed",
  setting_reset: "Setting reset to default",
};

/** One row of GET /api/admin/settings. */
export type SettingDTO = {
  key: string;
  group: string;
  label: string;
  description: string;
  unit: string;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

export const GROUP_LABEL: Record<PermissionGroup, string> = {
  orders: "الأوردرات",
  stock: "المخزون",
  reports: "التقارير",
  audit: "سجل المراجعة",
  users: "المستخدمين",
  settings: "الإعدادات",
  core: "البيانات الأساسية",
  sales: "المبيعات والعملاء",
  purchasing: "المشتريات والموردين",
  operations: "التشغيل والتوزيع",
  accounting: "الحسابات",
  hr: "الموظفين والمصروفات",
  integrations: "التكاملات",
};

export const GROUP_LABEL_EN: Record<PermissionGroup, string> = {
  orders: "Orders",
  stock: "Stock",
  reports: "Reports",
  audit: "Audit Log",
  users: "Users",
  settings: "Settings",
  core: "Core Data",
  sales: "Sales & Customers",
  purchasing: "Purchasing & Suppliers",
  operations: "Operations & Dispatch",
  accounting: "Accounting",
  hr: "Employees & Expenses",
  integrations: "Integrations",
};

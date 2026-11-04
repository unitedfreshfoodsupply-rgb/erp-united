/** Shapes of GET /api/admin/master. Prisma Decimals arrive as strings. */

export type CurrencyDTO = {
  code: string;
  name: string;
  nameAr: string | null;
  symbol: string | null;
  decimalPlaces: number;
  active: boolean;
  version: number;
};

export type StorageLocationDTO = {
  id: string;
  warehouseId: string;
  parentId: string | null;
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  capacityKg: string | null;
  tempMinC: string | null;
  tempMaxC: string | null;
  active: boolean;
  version: number;
};

export type WarehouseDTO = {
  id: string;
  branchId: string;
  code: string;
  name: string;
  nameAr: string | null;
  address: string | null;
  areaM2: string | null;
  dailyCapacityKg: string | null;
  active: boolean;
  version: number;
  locations: StorageLocationDTO[];
};

export type BranchDTO = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  nameAr: string | null;
  address: string | null;
  phone: string | null;
  active: boolean;
  version: number;
  warehouses: WarehouseDTO[];
};

export type CompanyDTO = {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  nameAr: string | null;
  taxRegistrationNumber: string | null;
  commercialRegistration: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  legalForm: string | null;
  issuedCapital: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  iban: string | null;
  invoiceTerms: string | null;
  baseCurrencyCode: string;
  active: boolean;
  version: number;
  branches: BranchDTO[];
};

export type UomDTO = {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  category: string;
  ratioToReference: string | null;
  isReference: boolean;
  precision: number;
  active: boolean;
  version: number;
};

export type MasterDataDTO = {
  currencies: CurrencyDTO[];
  companies: CompanyDTO[];
  uoms: UomDTO[];
};

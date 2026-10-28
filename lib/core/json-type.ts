import type { Prisma } from "@prisma/client";

/**
 * The shape a server value has after `NextResponse.json`: Decimals and Dates arrive as
 * strings. Lets a client component type an API response from the server function that
 * builds it (`import type` only — nothing from the server module reaches the bundle).
 */
export type Jsonified<T> = T extends Prisma.Decimal | Date
  ? string
  : T extends bigint
    ? string
    : T extends (infer U)[]
      ? Jsonified<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonified<T[K]> }
        : T;

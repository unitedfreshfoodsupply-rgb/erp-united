-- The Grade-B location was seeded (20261010000002) with Arabic inside its English name
-- ("Second grade / فرزة"), so English screens showed Arabic. Only the row that still carries
-- exactly the seeded text changes; a name someone edited is left alone. nameAr is unchanged.
BEGIN;
UPDATE "StorageLocation" SET "name" = 'Second grade' WHERE "id" = 'loc_grade_b' AND "name" = 'Second grade / فرزة';
COMMIT;

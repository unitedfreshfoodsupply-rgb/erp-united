-- Maturity 2026-11 (search): one normalisation for Arabic and English search text.
-- "إسكندرية" / "اسكندرية", "مكتبة" / "مكتبه", "مستشفى" / "مستشفي", tashkeel and tatweel all
-- match each other; Latin is case-insensitive; Arabic-Indic digits match Latin digits.
-- Additive: one immutable function (no table, no data change).
CREATE OR REPLACE FUNCTION united_norm(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp AS $$
  SELECT lower(
    translate(
      regexp_replace(coalesce(t, ''), '[ًٌٍَُِّْـ]', '', 'g'),
      'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'اااايهوي01234567890123456789'
    )
  )
$$;
REVOKE EXECUTE ON FUNCTION united_norm(TEXT) FROM PUBLIC;

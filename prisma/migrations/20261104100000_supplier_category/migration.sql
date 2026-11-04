-- Master data (Nov 2026): the business's two supplier categories, vegetables and fruit, as a
-- structured attribute of the supplier (it was not recorded anywhere in the ERP). Additive:
-- one nullable column (NULL = not classified yet), a CHECK, an index.
ALTER TABLE "Supplier" ADD COLUMN "category" TEXT;
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_category_known" CHECK ("category" IS NULL OR "category" IN ('vegetable', 'fruit'));
CREATE INDEX "Supplier_category_idx" ON "Supplier"("category");

-- Backfill of the 83 suppliers imported into production on 1 Nov 2026, from the business's own
-- import files: suppliers-fruit-master-draft.xlsx (39 rows, SUP-FR-001..039) and
-- suppliers-vegetables-master-draft.xlsx (44 rows, SUP-VEG-001..044). Each production supplier
-- was traced to exactly one file row by its Arabic AND English name, and the creation order in
-- the audit log equals the file order (verified 4 Nov 2026; production list fingerprint
-- md5 9add9330e8d35799403874970e56481a). Nothing is inferred from names here: each row is matched
-- by its internal id AND its code, so on any other database (tests, rehearsals) no row matches
-- and nothing changes. Only unclassified rows are set.
UPDATE "Supplier" SET "category" = 'fruit'
WHERE "category" IS NULL AND ("id", "code") IN (VALUES
  ('cmvxwou37014z11j2ed4daja4', 'SUP-00001'),
  ('cmvxwoubm015411j26b73xlga', 'SUP-00002'),
  ('cmvxwoujs015911j2rv8irp8g', 'SUP-00003'),
  ('cmvxwourw015e11j2bl1vml2x', 'SUP-00004'),
  ('cmvxwouzz015j11j2fgxsn9ck', 'SUP-00005'),
  ('cmvxwov81015o11j2438jhpsb', 'SUP-00006'),
  ('cmvxwovga015t11j25c266buo', 'SUP-00007'),
  ('cmvxwovof015y11j25ftgeqrg', 'SUP-00008'),
  ('cmvxwovwi016311j2xjpbu1bf', 'SUP-00009'),
  ('cmvxwow4m016811j2pg5fbi3v', 'SUP-00010'),
  ('cmvxwowcq016d11j2a3989ow9', 'SUP-00011'),
  ('cmvxwowkt016i11j2jouhkqfp', 'SUP-00012'),
  ('cmvxwowtn016n11j26t2fvukr', 'SUP-00013'),
  ('cmvxwox1v016s11j2z2bbht1t', 'SUP-00014'),
  ('cmvxwox9y016x11j2f3ll3wqm', 'SUP-00015'),
  ('cmvxwoxi5017211j2fiosvhcr', 'SUP-00016'),
  ('cmvxwoxqa017711j25aeizj9a', 'SUP-00017'),
  ('cmvxwoxyf017c11j2hwc3n1qa', 'SUP-00018'),
  ('cmvxwoy6k017h11j29fhx3wxj', 'SUP-00019'),
  ('cmvxwoyer017m11j2npt96s1n', 'SUP-00020'),
  ('cmvxwoymx017r11j257ynpqri', 'SUP-00021'),
  ('cmvxwoyv2017w11j2baiymqqz', 'SUP-00022'),
  ('cmvxwoz37018111j20rdrfkvr', 'SUP-00023'),
  ('cmvxwozbd018611j2o6g6qjug', 'SUP-00024'),
  ('cmvxwozjh018b11j2lind52gw', 'SUP-00025'),
  ('cmvxwozrp018g11j2smawx2ki', 'SUP-00026'),
  ('cmvxwozzu018l11j2jcfky8ll', 'SUP-00027'),
  ('cmvxwp082018q11j22obm5wrv', 'SUP-00028'),
  ('cmvxwp0g8018v11j2mfm3f649', 'SUP-00029'),
  ('cmvxwp0oe019011j2h13tvaes', 'SUP-00030'),
  ('cmvxwp0wp019511j2avpxd97t', 'SUP-00031'),
  ('cmvxwp14x019a11j21pzxl5t9', 'SUP-00032'),
  ('cmvxwp1d2019f11j2nvnsrxfh', 'SUP-00033'),
  ('cmvxwp1la019k11j2mqik82dr', 'SUP-00034'),
  ('cmvxwp1tf019p11j2vvrb50gy', 'SUP-00035'),
  ('cmvxwp21k019u11j2ty9h7vty', 'SUP-00036'),
  ('cmvxwp29q019z11j2amnuk8g0', 'SUP-00037'),
  ('cmvxwp2hv01a411j2oxwde45o', 'SUP-00038'),
  ('cmvxwp2q101a911j250kaby2e', 'SUP-00039')
);
UPDATE "Supplier" SET "category" = 'vegetable'
WHERE "category" IS NULL AND ("id", "code") IN (VALUES
  ('cmvxwqyfk01ae11j2owyq5lt2', 'SUP-00040'),
  ('cmvxwqyn701aj11j2sl7wj823', 'SUP-00041'),
  ('cmvxwqyuq01ao11j2xtswdjvf', 'SUP-00042'),
  ('cmvxwqz2701at11j2yxx7ropz', 'SUP-00043'),
  ('cmvxwqz9r01ay11j2scq6paj6', 'SUP-00044'),
  ('cmvxwqzh901b311j2qvkujf68', 'SUP-00045'),
  ('cmvxwqzou01b811j2972y7mul', 'SUP-00046'),
  ('cmvxwqzwc01bd11j27jjf59xd', 'SUP-00047'),
  ('cmvxwr03u01bi11j2l6q3bwv6', 'SUP-00048'),
  ('cmvxwr0be01bn11j2trluxgsn', 'SUP-00049'),
  ('cmvxwr0iy01bs11j296m8vhm9', 'SUP-00050'),
  ('cmvxwr0qi01bx11j2lcr54l11', 'SUP-00051'),
  ('cmvxwr0xz01c211j27g460iym', 'SUP-00052'),
  ('cmvxwr15m01c711j2n1fj3ksm', 'SUP-00053'),
  ('cmvxwr1d601cc11j2d5s7tjjt', 'SUP-00054'),
  ('cmvxwr1ko01ch11j29hocvfd1', 'SUP-00055'),
  ('cmvxwr1wj01cm11j29n1dz2bl', 'SUP-00056'),
  ('cmvxwr24601cr11j2cm2kqsvn', 'SUP-00057'),
  ('cmvxwr2bt01cw11j2p4w9wpi4', 'SUP-00058'),
  ('cmvxwr2jf01d111j2l8djcfak', 'SUP-00059'),
  ('cmvxwr2r001d611j2n55ndvyd', 'SUP-00060'),
  ('cmvxwr2yk01db11j2iof62cz2', 'SUP-00061'),
  ('cmvxwr36701dg11j2h8mtuvx2', 'SUP-00062'),
  ('cmvxwr3du01dl11j215sj2rl3', 'SUP-00063'),
  ('cmvxwr3lg01dq11j2sy1o8plk', 'SUP-00064'),
  ('cmvxwr3t001dv11j2htr6fyrb', 'SUP-00065'),
  ('cmvxwr40t01e011j212x1cjtu', 'SUP-00066'),
  ('cmvxwr48i01e511j2ia7dbkmk', 'SUP-00067'),
  ('cmvxwr4g301ea11j23m4mui2g', 'SUP-00068'),
  ('cmvxwr4np01ef11j2ivxt4x3z', 'SUP-00069'),
  ('cmvxwr4vb01ek11j22ez5x9hn', 'SUP-00070'),
  ('cmvxwr53501ep11j299zpuvzc', 'SUP-00071'),
  ('cmvxwr5ax01eu11j25nlfuiti', 'SUP-00072'),
  ('cmvxwr5io01ez11j2myo14vvu', 'SUP-00073'),
  ('cmvxwr5qk01f411j276o7dmbm', 'SUP-00074'),
  ('cmvxwr5yk01f911j2ajha1xiw', 'SUP-00075'),
  ('cmvxwr66j01fe11j2rs60tmdk', 'SUP-00076'),
  ('cmvxwr6ew01fj11j290oceuzv', 'SUP-00077'),
  ('cmvxwr6nj01fo11j293r0gskn', 'SUP-00078'),
  ('cmvxwr6vr01ft11j2gadtzhlw', 'SUP-00079'),
  ('cmvxwr73o01fy11j2jyspac06', 'SUP-00080'),
  ('cmvxwr7bk01g311j29esyq30u', 'SUP-00081'),
  ('cmvxwr7jd01g811j2ohj55c6t', 'SUP-00082'),
  ('cmvxwr7r001gd11j2eh7kgwp3', 'SUP-00083')
);

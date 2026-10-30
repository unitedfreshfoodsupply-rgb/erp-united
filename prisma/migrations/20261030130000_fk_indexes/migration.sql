-- Indexes on foreign-key columns that had none leading (Supabase advisor "unindexed foreign keys"; Sprint 0 F-12).
-- Additive only: each speeds up loading a document's lines/allocations and the parent-side checks on delete.

-- CreateIndex
CREATE INDEX "CreditNoteLine_creditNoteId_idx" ON "CreditNoteLine"("creditNoteId");

-- CreateIndex
CREATE INDEX "DebitNoteLine_debitNoteId_idx" ON "DebitNoteLine"("debitNoteId");

-- CreateIndex
CREATE INDEX "DeliveryLine_orderItemId_idx" ON "DeliveryLine"("orderItemId");

-- CreateIndex
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "PayrollRunEmployee_employeeId_idx" ON "PayrollRunEmployee"("employeeId");

-- CreateIndex
CREATE INDEX "ReceiptAllocation_receiptId_idx" ON "ReceiptAllocation"("receiptId");

-- CreateIndex
CREATE INDEX "StockMovement_locationId_idx" ON "StockMovement"("locationId");

-- CreateIndex
CREATE INDEX "StockMovement_warehouseId_idx" ON "StockMovement"("warehouseId");


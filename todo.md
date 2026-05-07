# TNT Bridge — Xentral to Osapiens TODO

## Phase 1 — Schema, Design System & Dependencies
- [x] Install qrcode and qrcode types packages
- [x] Define database schema: delivery_notes, delivery_note_items tables
- [x] Apply database migration SQL
- [x] Set global design tokens in index.css (dark warehouse theme, high-contrast)
- [x] Configure Google Fonts in index.html

## Phase 2 — Backend
- [x] Product cache service (in-memory, Category 95000, with refresh)
- [x] Xentral data mapper (delivery note → Osapiens SalesOrder JSON)
- [x] QR code generator utility
- [x] Public webhook endpoint POST /api/webhook/xentral
- [x] tRPC: orders.list procedure (paginated, with status)
- [x] tRPC: orders.getById procedure
- [x] tRPC: orders.retry procedure (re-fetch and remap)
- [x] tRPC: products.sync procedure (admin: refresh cache)
- [x] tRPC: products.count procedure (return cached count)
- [x] Role-based access: warehouse sees QR only; admin sees full log

## Phase 3 — Frontend
- [x] Dark warehouse theme with high-contrast status indicators
- [x] OrderList page: cards with Ready/Error/Pending status badges, search/filter tabs
- [x] OrderDetail page: QR code display + data verification panel
- [x] Error state in detail view with missing-field message and Retry / Re-fetch button
- [x] Sync Products button in header with confirmation toast
- [x] Responsive, touch-friendly layout (tablet/mobile optimised)
- [x] App.tsx routes wired (/ and /orders/:id)

## Phase 4 — Tests & Delivery
- [x] Vitest: data mapper unit tests (8 tests)
- [x] Vitest: QR generator tests (2 tests)
- [x] Vitest: auth.logout test (1 test)
- [x] Run pnpm test — all 12 tests pass
- [x] Save checkpoint

## Phase 5 — Fetch Orders (Active Polling)
- [x] Add server-side fetchDeliveryNotesFromXentral() in xentralPoller.ts
- [x] Add tRPC procedure: orders.fetchFromXentral (admin only)
- [x] Replace "Sync Products" header button with "Fetch Orders" primary button
- [x] Keep product cache refresh as a small secondary icon button
- [x] Show count of newly imported orders in toast after fetch
- [x] Update Vitest tests for the new poller logic

## Phase 6 — EOID Fix & Order Filtering

- [ ] Check dataMapper.ts for the exact free field name being looked up for EOID
- [ ] Add debug logging to capture actual free field names from Xentral API response
- [ ] Fix EOID free field name lookup to match actual Xentral field name
- [ ] Hide orders with "Missing EOID" error from the default All/Ready/Pending views (only visible in Error tab)
- [ ] Ensure the Error tab still shows them with a clear explanation

## Phase 7 — Order Management (Delete)

- [x] Add deleteDeliveryNote(id) DB helper in db.ts
- [x] Add bulkDeleteByStatus(status) DB helper in db.ts
- [x] Add tRPC procedure: orders.delete (admin only, single order)
- [x] Add tRPC procedure: orders.bulkDelete (admin only, by status filter)
- [x] Add individual delete button on each order card in Orders.tsx
- [x] Add "Clear Error Orders" bulk action button in the Error tab header
- [x] Confirm dialog before bulk delete
- [x] Update Vitest tests for new procedures

## Phase 8 — Order Number Fix & Smarter Fetch

- [ ] Fix xentralNumber: store documentNumber (e.g. "LN-2026-00123") not the internal Xentral ID
- [ ] Add salesOrderNumber field to schema to store the linked sales order document number
- [ ] Add "Fetch by document number" input to Orders page header so user can fetch a specific delivery note by its Xentral document number
- [ ] Also add option to skip already-fetched notes (only fetch new ones) to speed up bulk fetch
- [ ] Update UI labels: show both delivery note number and sales order number where available

## Phase 9 — Tobacco Pre-Filter & Performance

- [ ] At list level, check if positions are included in V3 list response — if yes, filter before fetching detail
- [ ] If positions not in list response, fetch V3 detail for each note but check positions first before running full mapping pipeline — skip notes with zero tobacco positions
- [ ] Add skip-already-fetched optimisation: if xentralId already in DB as "ready", skip detail fetch entirely
- [ ] Fix order number: documentNumber fix already applied in webhookProcessor.ts and dataMapper.ts
- [ ] Add fetch-by-document-number input to Orders header for targeted single-order fetch

## Phase 10 — SKU Prefix Filter & Document Number Search

- [ ] Update isTobaccoProduct() in productCache.ts to also match product numbers starting with "95"
- [ ] Update filterTobaccoPositions() in webhookProcessor.ts to use both cache ID check AND SKU prefix "95" check
- [ ] Update xentralPoller.ts hasTobacco check to use both cache ID AND SKU prefix "95"
- [ ] Add document number search input to Orders page header for targeted single-order fetch
- [ ] Update fetch toast messages to show tobaccoFound count

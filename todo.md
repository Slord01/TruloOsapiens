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

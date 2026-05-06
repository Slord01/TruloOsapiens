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
- [ ] Save checkpoint

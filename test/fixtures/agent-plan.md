# Plan: export reports as CSV

Agents mark the step they are on with `[/]` and tick it with `[x]` when done.

## 1. Data layer

- [x] Add `ReportRow` type
- [x] Query rows for a date range
- [~] Stream rows instead of loading them all
  - [~] Cursor-based query
  - [ ] Back-pressure when the client is slow
- [ ] Index on `created_at`

## 2. CSV writer

1. [x] Escape quotes, commas and line breaks
2. [~] Write the header row from column metadata
3. [ ] UTF-8 BOM option for Excel

## 3. API and UI

- [ ] `GET /reports/:id.csv` endpoint
- [ ] Download button on the report page
- [ ] Progress toast for large exports

## 4. Tests

- [ ] Unit tests for escaping

- [~] Integration test for the endpoint

  Loose list item with a second paragraph.

> - [ ] A step inside a blockquote

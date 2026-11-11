-- A share link's conditions are told apart by how long they are kept as
-- well, so that asking for a shorter time is not answered with a link
-- already sent for longer: .agents/design/chart-dashboard.md 3.10. Rows from
-- before keep a digest of the state alone, which nothing shared afterwards
-- matches; they expire as they would have.

COMMENT ON COLUMN dashboard_views.state_hash IS 'SHA-256 of the state as stored and of how long it was asked to be kept, so that sharing the same conditions the same way again finds the same row.';

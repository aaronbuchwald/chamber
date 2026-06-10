-- Generic Gold view for the testkit datagram: per-order × per-metric totals.
-- Joins each order's Bronze lines (order_lines) to the seeded reference matrix
-- (sku_metrics) and sums each line's contribution:
--   amount = SUM(qty * amount_per_unit)
-- The SELECT columns are exactly the fields of the proto OrderTotal message
-- (order_id, metric, unit, amount), so the view's schema matches its contract.
SELECT
  ol.order_id                          AS order_id,
  sm.metric                            AS metric,
  sm.unit                              AS unit,
  SUM(ol.qty * sm.amount_per_unit)     AS amount
FROM order_lines ol
JOIN sku_metrics sm ON sm.sku = ol.sku
GROUP BY ol.order_id, sm.metric, sm.unit

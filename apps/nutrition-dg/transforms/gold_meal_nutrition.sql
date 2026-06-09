-- Gold view: per-meal × per-nutrient aggregated totals.
--
-- Joins each meal's Bronze components (meal_components) to the seeded reference
-- matrix (component_nutrients) and sums the contribution of every component:
--   amount = SUM(qty_g / 100.0 * amount_per_100g)
-- grouped by meal and nutrient. The SELECT column names are exactly the fields
-- of the proto MealNutrition message (meal_id, nutrient, kind, unit, amount), so
-- the derived view's schema matches its contract.
--
-- This file is host-validated SQL committed in the repo (not user input); the
-- SDK wraps it as a named CREATE VIEW so handlers only ever name the view.
SELECT
  mc.meal_id                                   AS meal_id,
  cn.nutrient                                  AS nutrient,
  cn.kind                                      AS kind,
  cn.unit                                      AS unit,
  SUM(mc.qty_g / 100.0 * cn.amount_per_100g)   AS amount
FROM meal_components mc
JOIN component_nutrients cn ON cn.component = mc.component
GROUP BY mc.meal_id, cn.nutrient, cn.kind, cn.unit

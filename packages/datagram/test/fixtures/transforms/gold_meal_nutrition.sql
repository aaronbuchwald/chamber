-- Test fixture: the Gold view body the SDK materializes from the proto
-- MealNutrition message's transform option. Mirrors the app's transform so the
-- SDK's schema-derivation + view-creation path is exercised in isolation.
SELECT
  mc.meal_id                                   AS meal_id,
  cn.nutrient                                  AS nutrient,
  cn.kind                                      AS kind,
  cn.unit                                      AS unit,
  SUM(mc.qty_g / 100.0 * cn.amount_per_100g)   AS amount
FROM meal_components mc
JOIN component_nutrients cn ON cn.component = mc.component
GROUP BY mc.meal_id, cn.nutrient, cn.kind, cn.unit

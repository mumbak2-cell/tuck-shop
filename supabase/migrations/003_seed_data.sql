-- ============================================================
-- Seed data: Products, Ingredients, and Recipes
-- Prices for pre-packaged items: set to 0 where unknown — update via UI
-- Prepared items and ingredients: fully costed from spreadsheet
-- ============================================================

-- Pre-packaged products (from inventory CSV + spreadsheet)
INSERT INTO products (inventory_id, name, category, package_price, qty_in_pack, selling_price, is_prepared, opening_stock) VALUES
('IN0001', 'Yogueta Lollies', 'Sweets', NULL, 48, 2.00, FALSE, 0),
('IN0002', 'Kitkat', 'Sweets', NULL, 36, 10.00, FALSE, 0),
('IN0003', 'Minibits', 'Sweets', NULL, 20, 5.00, FALSE, 0),
('IN0004', 'Fizzers', 'Sweets', NULL, 100, 1.00, FALSE, 0),
('IN0005', 'Smoothies', 'Sweets', NULL, 50, 1.00, FALSE, 0),
('IN0006', 'Dynamo Toppers', 'Snacks', NULL, 24, 5.00, FALSE, 0),
('IN0007', 'Gummy Snakes', 'Sweets', NULL, 50, 1.00, FALSE, 0),
('IN0008', 'Gummy Eyes', 'Sweets', NULL, 50, 1.00, FALSE, 0),
('IN0009', 'Tongues', 'Sweets', NULL, 60, 1.00, FALSE, 0),
('IN0010', 'Shongololos', 'Sweets', NULL, 82, 1.00, FALSE, 0),
('IN0011', 'Frutos 120 Grams', 'Snacks', NULL, 24, 10.00, FALSE, 0),
('IN0012', 'Sour Belts', 'Sweets', NULL, 48, 2.00, FALSE, 0),
('IN0013', 'Mentos', 'Sweets', NULL, 50, 5.00, FALSE, 0),
('IN0014', 'Tex Bar', 'Sweets', NULL, 24, 10.00, FALSE, 0),
('IN0015', 'Smarties', 'Sweets', NULL, 24, 10.00, FALSE, 0),
('IN0016', 'Chilli Goslos', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0017', 'Bbq Goslos', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0018', 'Oozies', 'Snacks', NULL, 50, 2.00, FALSE, 0),
('IN0019', 'Stylos 125 Grams', 'Snacks', NULL, 10, 15.00, FALSE, 0),
('IN0020', 'Stylos 20 Grams', 'Snacks', NULL, 50, 3.00, FALSE, 0),
('IN0021', 'Niknaks', 'Snacks', NULL, 50, 3.00, FALSE, 0),
('IN0022', 'Popshots', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0023', 'Coke 440 Ml', 'Soft Drinks', NULL, 24, 15.00, FALSE, 0),
('IN0024', 'Aquellé', 'Soft Drinks', NULL, 6, 10.00, FALSE, 0),
('IN0025', 'Kingsley 330 Ml', 'Soft Drinks', NULL, 6, 8.00, FALSE, 0),
('IN0026', 'Kingsley 500 Ml', 'Soft Drinks', NULL, 6, 10.00, FALSE, 0),
('IN0027', 'Mountain Dew 330 Ml', 'Soft Drinks', NULL, 12, 10.00, FALSE, 0),
('IN0028', 'Mirinda 330 Ml', 'Soft Drinks', NULL, 12, 10.00, FALSE, 0),
('IN0029', 'Toppers 125 G', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0030', 'Gummy Sharks', 'Sweets', NULL, 175, 1.00, FALSE, 0),
('IN0031', 'Gummy Caterpillars', 'Sweets', NULL, 120, 1.00, FALSE, 0),
('IN0032', 'Munchies Twirls', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0033', 'Kitkat Mini', 'Sweets', NULL, 24, 5.00, FALSE, 0),
('IN0034', 'Jelly Bones', 'Sweets', NULL, 48, 2.00, FALSE, 0),
('IN0035', 'Popcorn', 'Snacks', NULL, 10, 5.00, FALSE, 0),
('IN0036', 'Mr Orange', 'Soft Drinks', NULL, 24, 10.00, FALSE, 0),
('IN0037', 'Black Mamba Snakes', 'Sweets', NULL, 50, 1.00, FALSE, 0),
('IN0038', 'Sour Snakes', 'Sweets', NULL, 50, 1.00, FALSE, 0),
('IN0039', 'Ice Pop / Slushy', 'Frozen Treats', NULL, 30, 5.00, FALSE, 0),
('IN0040', 'Sweet Chilli Naks', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0041', 'Simba Crisps 36g', 'Snacks', NULL, 12, 10.00, FALSE, 0),
('IN0042', 'Jelly Palace Filled Rope', 'Sweets', NULL, 100, 1.00, FALSE, 0),
('IN0046', 'Sour Pencils', 'Sweets', NULL, 100, 1.00, FALSE, 0),
('IN0050', 'FizPop', 'Sweets', NULL, 10, 3.00, FALSE, 0),
('IN0054', 'Ice Pop', 'Frozen Treats', NULL, 48, 3.00, FALSE, 0),
('IN0058', 'Apple Much', 'Frozen Treats', NULL, 96, 3.00, FALSE, 0),
('IN0059', 'Milky Pie', 'Frozen Treats', NULL, 30, 5.00, FALSE, 0),
('IN0060', 'Ice Lolly', 'Frozen Treats', NULL, 30, 5.00, FALSE, 0),
('IN0062', 'Hot Dogs', 'Sandwiches', NULL, 10, 15.00, FALSE, 0),
('IN0063', 'Hot Dog Rolls', 'Sandwiches', NULL, 6, 5.00, FALSE, 0),
('IN0064', 'Burger Rolls', 'Sandwiches', NULL, 6, 5.00, FALSE, 0),
('IN0065', 'Burger Patties Beef', 'Sandwiches', NULL, 20, 20.00, FALSE, 0),
('IN0066', 'Sprite', 'Soft Drinks', NULL, 24, 15.00, FALSE, 0),
('IN0067', 'Burger Patties Chicken (18)', 'Sandwiches', NULL, 18, 20.00, FALSE, 0),
('IN0068', 'Stoney', 'Soft Drinks', NULL, 24, 15.00, FALSE, 0),
('IN0069', 'Fanta', 'Soft Drinks', NULL, 24, 15.00, FALSE, 0),
('IN0070', 'Popcorn Loose', 'Snacks', NULL, 10, 3.00, FALSE, 0),
('IN0071', 'Burger Patties Chicken (12)', 'Sandwiches', NULL, 12, 20.00, FALSE, 0),
('IN0072', 'Russian Sausages', 'Hot Food', NULL, 10, 10.00, FALSE, 0),
('IN0073', 'Potatoes', 'Hot Food', NULL, 10, 5.00, FALSE, 0),
('IN0074', 'Frozen Fries', 'Hot Food', NULL, 10, 10.00, FALSE, 0),
('IN0076', 'Fizzy Rainbow Twist', 'Sweets', NULL, 100, 1.00, FALSE, 0),
('IN0077', 'Gummy Monster Ball', 'Sweets', NULL, 50, 2.00, FALSE, 0),
('IN0078', 'Choco Munch', 'Sweets', NULL, 24, 5.00, FALSE, 0),
('IN0079', 'Lays Crisps 36g', 'Snacks', NULL, 10, 10.00, FALSE, 0);

-- Prepared food products (exact data from spreadsheet)
INSERT INTO products (inventory_id, name, category, package_price, qty_in_pack, selling_price, is_prepared, opening_stock) VALUES
('IN0081', 'Muffins', 'Prepared Food', 81.92, 30, 6.00, TRUE, 0),
('IN0082', 'Scones', 'Prepared Food', 100.10, 35, 3.00, TRUE, 0),
('IN0083', 'Toasted Cheese Sandwich', 'Prepared Food', 120.70, 20, 20.00, TRUE, 0);

-- Ingredients (exact from spreadsheet)
INSERT INTO ingredients (name, unit, purchase_size, purchase_price) VALUES
('Muffin Mix 1kg', 'kg', '1kg bag', 44.00),
('Cooking Oil', 'ml', '2L bottle', 70.00),
('Eggs', 'each', 'Tray of 18', 57.00),
('Milk', 'ml', '2L carton', 38.00),
('Coffee', 'g', '200g jar', 150.00),
('Cake Flour', 'kg', '2.5kg bag', 40.00),
('Margarine', 'g', '500g tub', 50.00),
('Sugar', 'g', '2kg bag', 57.00),
('Baking Powder', 'g', '200g tin', 38.00),
('White Cheddar', 'g', '220g block', 40.00),
('Cheddar Cheese', 'g', '240g block', 42.70),
('Sliced Bread', 'each', 'Loaf', 19.00);

-- Recipes: Muffins (IN0081)
INSERT INTO recipes (product_id, ingredient_id, quantity_per_batch, unit)
SELECT p.id, i.id, v.qty, v.unit
FROM (VALUES
  ('IN0081', 'Muffin Mix 1kg', 1.0000, 'kg'),
  ('IN0081', 'Eggs', 4.0000, 'each'),
  ('IN0081', 'Milk', 250.0000, 'ml'),
  ('IN0081', 'Cooking Oil', 250.0000, 'ml'),
  ('IN0081', 'Coffee', 4.0000, 'g')
) AS v(pid, ing, qty, unit)
JOIN products p ON p.inventory_id = v.pid
JOIN ingredients i ON i.name = v.ing;

-- Recipes: Scones (IN0082)
INSERT INTO recipes (product_id, ingredient_id, quantity_per_batch, unit)
SELECT p.id, i.id, v.qty, v.unit
FROM (VALUES
  ('IN0082', 'Cake Flour', 1.2500, 'kg'),
  ('IN0082', 'Eggs', 6.0000, 'each'),
  ('IN0082', 'Milk', 500.0000, 'ml'),
  ('IN0082', 'Margarine', 250.0000, 'g'),
  ('IN0082', 'Sugar', 800.0000, 'g'),
  ('IN0082', 'Baking Powder', 20.0000, 'g')
) AS v(pid, ing, qty, unit)
JOIN products p ON p.inventory_id = v.pid
JOIN ingredients i ON i.name = v.ing;

-- Recipes: Toasted Cheese Sandwich (IN0083)
INSERT INTO recipes (product_id, ingredient_id, quantity_per_batch, unit)
SELECT p.id, i.id, v.qty, v.unit
FROM (VALUES
  ('IN0083', 'Sliced Bread', 2.0000, 'each'),
  ('IN0083', 'White Cheddar', 1.0000, 'each'),
  ('IN0083', 'Cheddar Cheese', 1.0000, 'each')
) AS v(pid, ing, qty, unit)
JOIN products p ON p.inventory_id = v.pid
JOIN ingredients i ON i.name = v.ing;

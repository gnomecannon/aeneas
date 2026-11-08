# hub/assets

`us-states.json`: the outlines of the 50 states and the District of Columbia, used by `src/mealstax.ts` to tell which
state a position is in (the bill splitter's meals tax). Converted on 2026-11-06 from the US Census Bureau's
Cartographic Boundary File "States, 1:20,000,000" (2024, KML), a public domain work of the US government:
https://www2.census.gov/geo/tiger/GENZ2024/kml/cb_2024_us_state_20m.zip (SHA-256
37337db59415f010c594fba96a48aa6e950e633dc0e555cc7b1ce8edd794c673).

Format: `{ "<postal code>": [polygon, ...] }`, each polygon a list of rings (the outside first, then holes), each ring
a list of `[longitude, latitude]` rounded to 4 decimals. Puerto Rico and the other territories are left out because the
meals tax table covers the states and DC only.

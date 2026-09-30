"use strict";

/*
 * LewisGale patient map - MapLibre GL JS test page.
 *
 * READING GUIDE (for a Python/GIS person new to JavaScript)
 * ---------------------------------------------------------
 * - This whole file runs in the browser. It downloads the GeoJSON files in
 *   ./data/, hands them to MapLibre as "sources", and draws them with
 *   "layers" (a layer = how to draw a source: fill/line/circle + a paint
 *   style). Sources and layers are the same idea as a QGIS data source and
 *   its symbology.
 * - COORDINATE ORDER: GeoJSON and MapLibre use [longitude, latitude]
 *   (x, y). Python code in this project often uses (lat, lon). Watch out.
 * - Styling and filtering use MapLibre "expressions": nested arrays such as
 *       ["interpolate", ["linear"], ["get", "patient_count"], 1, "#000", 19, "#fff"]
 *   which read like a tiny prefix-notation language: operator first, then
 *   arguments. ["get", "field"] reads an attribute of the feature.
 *   MapLibre evaluates these on the GPU/worker side, so they are fast.
 * - `const` = a variable that is never reassigned; `let` = one that is.
 *   `(x) => x * 2` is a lambda. `async`/`await` waits for a network request
 *   without freezing the page (like asyncio). `{a, b}` builds a dict, and
 *   `const {a, b} = obj` unpacks one.
 * - Two parallel "filter" implementations exist on purpose. MapLibre filters
 *   (buildMapFilters) decide what is DRAWN. Plain JS predicates
 *   (passesPoint / passesAgg) decide what the summary widgets and the list
 *   COUNT. Both apply the same rules to the same in-memory data, so the map
 *   and the widgets agree.
 *
 * Sections: 1 Config, 2 Helpers, 3 State, 4 Map + layers, 5 Filters,
 * 6 Sidebar UI, 7 Summary/list/legend, 8 Click interaction, 9 Boot.
 */

// ---------------------------------------------------------------------------
// 1. CONFIG
// ---------------------------------------------------------------------------

const urlParams = new URLSearchParams(window.location.search);

// Add ?stress=1 to the page URL to swap in the large synthetic point file made
// by make_stress_data.py (used for the performance test in the README).
const DATA_URLS = {
  patients: urlParams.get("stress") ? "data/stress_points.geojson" : "data/patients.geojson",
  centroids: "data/centroids.geojson",
  lines: "data/lines.geojson",
  hex3: "data/hex_res3.geojson",
  hex4: "data/hex_res4.geojson",
  blacksburg: "data/blacksburg.geojson",
};

// Free, keyless vector basemap (dark). For production you would replace this
// with a self-hosted Protomaps PMTiles style; see the README.
const BASEMAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
// Used if the basemap cannot be fetched (offline): a flat dark background.
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#10151a" } }],
};

const BLACKSBURG_LNGLAT = [-80.4139, 37.2296]; // [lon, lat]
const DATE_ZERO_MS = Date.UTC(2023, 0, 1); // date_num = days since this date

// Colour ramps as [value, colour] stops. The hex ramp is the "matrix" ramp
// from the QGIS project: dark green (few patients) to lime (many).
const COUNT_RAMP = [[1, "#134d22"], [3, "#1f8f3a"], [6, "#3fd13b"], [10, "#9df02c"], [19, "#d8ff3d"]];
const DISTANCE_RAMP = [[0, "#3ddcff"], [500, "#a6f22e"], [2000, "#ffd166"], [6000, "#ff6b9d"], [10000, "#b5179e"]];
const COUNTRY_PALETTE = [
  "#4cc9f0", "#f72585", "#ffd166", "#06d6a0", "#b5179e", "#ff9f1c", "#90be6d",
  "#a0c4ff", "#f4a261", "#e76f51", "#c77dff", "#80ed99", "#ffafcc",
];
const OTHER_COLOR = "#8a8f98";

// Sidebar toggles. Each entry controls one or more map layers.
const LAYER_GROUPS = [
  { key: "hex3", label: "H3 res 3 hexagons (global)", layerIds: ["hex3-fill", "hex3-outline"], visible: true },
  { key: "hex4", label: "H3 res 4 hexagons (USA)", layerIds: ["hex4-fill", "hex4-outline"], visible: false },
  // Lines and centroids each come from ONE data source that holds both H3
  // resolutions. Two map layers per source, each filtered on the
  // `h3_resolution` field, give separate toggles/styles with no duplicated data.
  { key: "lines3", label: "Lines res 3 (hex centroid to Blacksburg)", layerIds: ["lines-res3"], visible: true },
  { key: "lines4", label: "Lines res 4 (USA hex centroid to Blacksburg)", layerIds: ["lines-res4"], visible: false },
  { key: "centroids3", label: "H3 res 3 centroids (points)", layerIds: ["centroids-res3"], visible: false },
  { key: "centroids4", label: "H3 res 4 centroids (points)", layerIds: ["centroids-res4"], visible: false },
  { key: "patients", label: "Patient points (dummy)", layerIds: ["patients"], visible: true },
  { key: "blacksburg", label: "Lewis Gale (procedure site)", layerIds: ["blacksburg-halo", "blacksburg"], visible: true },
];

// Layers that respond to clicks, and the title shown in their popup.
const LAYER_TITLES = {
  "blacksburg": "Procedure site",
  "patients": "Patient",
  "centroids-res4": "H3 res 4 centroid",
  "centroids-res3": "H3 res 3 centroid",
  "lines-res4": "Line to Blacksburg (res 4)",
  "lines-res3": "Line to Blacksburg (res 3)",
  "hex4-fill": "H3 res 4 hexagon",
  "hex3-fill": "H3 res 3 hexagon",
};
const INTERACTIVE_LAYER_IDS = Object.keys(LAYER_TITLES); // ordered top-most first

// Layers driven by the country + patient-count filters. The value is the H3
// resolution a layer is restricted to (null = no resolution restriction; the
// hexagon layers are already separate sources, one per resolution).
const AGG_LAYER_RESOLUTION = {
  "hex3-fill": null, "hex3-outline": null, "hex4-fill": null, "hex4-outline": null,
  "lines-res3": 3, "lines-res4": 4,
  "centroids-res3": 3, "centroids-res4": 4,
};
const AGG_LAYER_IDS = Object.keys(AGG_LAYER_RESOLUTION);
const LIST_LIMIT = 100; // max rows rendered in the "Visible features" list

// ---------------------------------------------------------------------------
// 2. HELPERS
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id); // shorthand for getElementById

function escapeHtml(value) {
  // Attribute values come from data files; escape them before building HTML.
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function formatValue(value) {
  if (typeof value === "number" && !Number.isInteger(value)) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return String(value);
}

const formatInt = (n) => Math.round(n).toLocaleString("en-US");

function dateFromNum(dayNumber) {
  return new Date(DATE_ZERO_MS + dayNumber * 86400000).toISOString().slice(0, 10);
}

function attributeTable(props) {
  const rows = Object.entries(props)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(formatValue(v))}</td></tr>`)
    .join("");
  return `<table class="attrs"><tbody>${rows}</tbody></table>`;
}

// Build a MapLibre "interpolate" expression from a [value, colour] ramp.
function rampExpression(field, ramp) {
  const expr = ["interpolate", ["linear"], ["get", field]];
  for (const [value, colour] of ramp) expr.push(value, colour);
  return expr;
}

// CSS gradient string for the legend, stops placed proportionally to value.
function rampCss(ramp) {
  const lo = ramp[0][0];
  const hi = ramp[ramp.length - 1][0];
  const stops = ramp.map(([v, c]) => `${c} ${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

// Is [lng, lat] inside the current map bounds? Also tests +/-360 degrees,
// because when zoomed out the map shows repeated copies of the world and
// getWest()/getEast() can run past +/-180.
function inBounds([lng, lat], bounds) {
  if (lat < bounds.getSouth() || lat > bounds.getNorth()) return false;
  return [-360, 0, 360].some((shift) => lng + shift >= bounds.getWest() && lng + shift <= bounds.getEast());
}

function ringCentre(geometry) {
  // Average of the outer ring's vertices: a fine "centre" for a hexagon.
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0][0];
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  return [sx / ring.length, sy / ring.length];
}

function geometryBounds(geometry) {
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0][0];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}

// Ray-casting point-in-polygon (the same algorithm as Shapely's `contains`
// for simple rings, minus edge cases on the boundary).
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(x, y, rings) {
  // rings[0] is the outer ring; any further rings are holes.
  if (!pointInRing(x, y, rings[0])) return false;
  return !rings.slice(1).some((hole) => pointInRing(x, y, hole));
}

function pointInGeometry(x, y, geometry) {
  if (geometry.type === "Polygon") return pointInPolygonCoords(x, y, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((poly) => pointInPolygonCoords(x, y, poly));
  return false;
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  return response.json();
}

// ---------------------------------------------------------------------------
// 3. STATE
// ---------------------------------------------------------------------------

let map; // the MapLibre map, created in main()

const state = {
  data: {},              // name -> GeoJSON FeatureCollection (kept in memory)
  countries: [],         // all countries, most patients first
  countryColour: {},     // country -> colour
  countryCounts: {},     // country -> patient count (unfiltered)
  bounds: { count: [1, 1], date: [0, 1] }, // full data ranges for the sliders
  filters: { countries: new Set(), count: [1, 1], date: [0, 1] },
  extentOnly: false,     // limit summary + list to the current map view?
  pointColourMode: "country",
  pointSizeMode: "fixed",
  timings: {},           // ms marks for the status line
};

function layerVisible(key) {
  const group = LAYER_GROUPS.find((g) => g.key === key);
  return map.getLayoutProperty(group.layerIds[0], "visibility") !== "none";
}

// ---------------------------------------------------------------------------
// 4. MAP + LAYERS
// ---------------------------------------------------------------------------

function addDataLayers() {
  for (const name of ["hex3", "hex4", "lines", "centroids", "patients", "blacksburg"]) {
    map.addSource(name, { type: "geojson", data: state.data[name] });
  }
  map.addSource("highlight", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  const vis = (key) => (LAYER_GROUPS.find((g) => g.key === key).visible ? "visible" : "none");

  // Polygons: choropleth by patient_count (numeric), drawn bottom to top.
  for (const key of ["hex3", "hex4"]) {
    map.addLayer({
      id: `${key}-fill`, type: "fill", source: key,
      layout: { visibility: vis(key) },
      paint: { "fill-color": rampExpression("patient_count", COUNT_RAMP), "fill-opacity": 0.72 },
    });
    map.addLayer({
      id: `${key}-outline`, type: "line", source: key,
      layout: { visibility: vis(key) },
      paint: { "line-color": "rgba(255,255,255,0.35)", "line-width": 0.6 },
    });
  }

  // Lines: colour by distance (numeric ramp), width by patient_count (numeric).
  // One layer per H3 resolution, both reading the same "lines" source; the
  // resolution filter itself is applied in applyMapFilters().
  for (const res of [3, 4]) {
    map.addLayer({
      id: `lines-res${res}`, type: "line", source: "lines",
      layout: { visibility: vis(`lines${res}`), "line-cap": "round" },
      paint: {
        "line-color": rampExpression("distance_miles", DISTANCE_RAMP),
        "line-width": ["interpolate", ["linear"], ["get", "patient_count"], 1, 0.6, 19, 4],
        "line-opacity": 0.55,
      },
    });
  }

  // Centroids: size by patient_count (numeric); colour by resolution
  // (categorical, via a "match" expression = a dict lookup). One layer per
  // resolution from the same "centroids" source.
  for (const res of [3, 4]) {
    map.addLayer({
      id: `centroids-res${res}`, type: "circle", source: "centroids",
      layout: { visibility: vis(`centroids${res}`) },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "patient_count"], 1, 3, 19, 16],
        "circle-color": ["match", ["get", "h3_resolution"], 3, "#ffb703", 4, "#8ecae6", OTHER_COLOR],
        "circle-opacity": 0.85,
        "circle-stroke-width": 0.6,
        "circle-stroke-color": "#000",
      },
    });
  }

  // Patient points: colour/size are switched by the sidebar dropdowns.
  map.addLayer({
    id: "patients", type: "circle", source: "patients",
    layout: { visibility: vis("patients") },
    paint: {
      "circle-radius": 4,
      "circle-color": OTHER_COLOR,
      "circle-opacity": 0.75,
      "circle-stroke-width": 0.5,
      "circle-stroke-color": "rgba(0,0,0,0.6)",
    },
  });

  // Procedure site: a soft halo plus a bright core.
  map.addLayer({
    id: "blacksburg-halo", type: "circle", source: "blacksburg",
    layout: { visibility: vis("blacksburg") },
    paint: { "circle-radius": 16, "circle-color": "rgba(255,255,255,0.22)", "circle-blur": 0.6 },
  });
  map.addLayer({
    id: "blacksburg", type: "circle", source: "blacksburg",
    layout: { visibility: vis("blacksburg") },
    paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-width": 2, "circle-stroke-color": "#9df02c" },
  });

  // Highlight overlay for the click-to-query result (outline + click point).
  map.addLayer({
    id: "highlight-line", type: "line", source: "highlight",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "line-color": "#ffee58", "line-width": 2.5 },
  });
  map.addLayer({
    id: "highlight-point", type: "circle", source: "highlight",
    filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": 5, "circle-color": "#ffee58", "circle-stroke-width": 1.5, "circle-stroke-color": "#000" },
  });

  applyPointStyle();
}

function countryColourExpression() {
  // ["match", input, label1, output1, label2, output2, ..., fallback]
  const expr = ["match", ["get", "country"]];
  for (const c of state.countries) expr.push(c, state.countryColour[c]);
  expr.push(OTHER_COLOR);
  return expr;
}

function applyPointStyle() {
  const colour = state.pointColourMode === "country"
    ? countryColourExpression()
    : rampExpression("distance_miles", DISTANCE_RAMP);

  // Size grows with zoom; optionally also with distance to Blacksburg.
  const fixed = ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 5, 10, 8];
  const scaled = (lo, hi) => ["interpolate", ["linear"], ["get", "distance_miles"], 0, lo, 10000, hi];
  const byDistance = ["interpolate", ["linear"], ["zoom"], 1, scaled(2, 7), 10, scaled(5, 14)];

  map.setPaintProperty("patients", "circle-color", colour);
  map.setPaintProperty("patients", "circle-radius", state.pointSizeMode === "fixed" ? fixed : byDistance);
}

// ---------------------------------------------------------------------------
// 5. FILTERS
// ---------------------------------------------------------------------------

// (a) MapLibre filter expressions: decide what is drawn.
function buildMapFilters() {
  const { countries, count, date } = state.filters;
  const list = [...countries];
  // An empty list would make an invalid "in" expression, so use a constant
  // false instead. It must be written with an array argument, e.g.
  // ["==", ["literal", 0], 1]: a bare ["==", 0, 1] is parsed as an old-style
  // (legacy) filter and MapLibre then rejects the whole combined filter.
  const countryTest = (field) => (list.length ? ["in", ["get", field], ["literal", list]] : ["==", ["literal", 0], 1]);

  const aggFilter = ["all", countryTest("countries"),
    [">=", ["get", "patient_count"], count[0]], ["<=", ["get", "patient_count"], count[1]]];
  const pointFilter = ["all", countryTest("country"),
    [">=", ["get", "date_num"], date[0]], ["<=", ["get", "date_num"], date[1]]];
  return { aggFilter, pointFilter };
}

function applyMapFilters() {
  const { aggFilter, pointFilter } = buildMapFilters();
  for (const [id, resolution] of Object.entries(AGG_LAYER_RESOLUTION)) {
    // Lines/centroid layers add "h3_resolution == 3 (or 4)" on top of the
    // shared country + patient-count filter.
    const filter = resolution === null
      ? aggFilter
      : ["all", aggFilter, ["==", ["get", "h3_resolution"], resolution]];
    map.setFilter(id, filter);
  }
  map.setFilter("patients", pointFilter);
}

// (b) The same rules as plain JS predicates: decide what widgets/list count.
// `skipCountry` lets the bar chart ignore the country filter so every bar
// stays visible (like a category selector in a dashboard).
function passesPoint(p, skipCountry = false) {
  const { countries, date } = state.filters;
  return (skipCountry || countries.has(p.country)) && p.date_num >= date[0] && p.date_num <= date[1];
}

function passesAgg(p) {
  const { countries, count } = state.filters;
  return countries.has(p.countries) && p.patient_count >= count[0] && p.patient_count <= count[1];
}

function onFiltersChanged() {
  applyMapFilters();
  refreshFilterLabels();
  refreshSummary();
  refreshList();
  clearOverlapResult();
}

// ---------------------------------------------------------------------------
// 6. SIDEBAR UI
// ---------------------------------------------------------------------------

function buildLayerToggles() {
  const box = $("layer-toggles");
  for (const group of LAYER_GROUPS) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" ${group.visible ? "checked" : ""}> ${escapeHtml(group.label)}`;
    label.querySelector("input").addEventListener("change", (event) => {
      const visibility = event.target.checked ? "visible" : "none";
      for (const id of group.layerIds) map.setLayoutProperty(id, "visibility", visibility);
      refreshLegend();
      refreshList();
      clearOverlapResult();
    });
    box.appendChild(label);
  }
}

function buildCountryFilter() {
  const box = $("country-list");
  box.innerHTML = "";
  for (const country of state.countries) {
    const label = document.createElement("label");
    label.innerHTML =
      `<input type="checkbox" value="${escapeHtml(country)}" ${state.filters.countries.has(country) ? "checked" : ""}>` +
      `<span class="swatch" style="background:${state.countryColour[country]}"></span>` +
      `${escapeHtml(country)}<span class="count">${state.countryCounts[country]}</span>`;
    label.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.filters.countries.add(country);
      else state.filters.countries.delete(country);
      onFiltersChanged();
    });
    box.appendChild(label);
  }
}

function syncCountryCheckboxes() {
  for (const input of $("country-list").querySelectorAll("input")) {
    input.checked = state.filters.countries.has(input.value);
  }
}

// Two <input type=range> sliders act as one min/max range slider.
function wireRange(minId, maxId, key, bounds) {
  const minInput = $(minId);
  const maxInput = $(maxId);
  for (const input of [minInput, maxInput]) {
    input.min = bounds[0];
    input.max = bounds[1];
    input.step = 1;
  }
  minInput.value = bounds[0];
  maxInput.value = bounds[1];

  const onInput = (event) => {
    let lo = Number(minInput.value);
    let hi = Number(maxInput.value);
    if (lo > hi) { // keep min <= max by dragging the other handle along
      if (event.target === minInput) hi = maxInput.value = lo;
      else lo = minInput.value = hi;
    }
    state.filters[key] = [lo, hi];
    onFiltersChanged();
  };
  minInput.addEventListener("input", onInput);
  maxInput.addEventListener("input", onInput);
}

function refreshFilterLabels() {
  const { count, date } = state.filters;
  $("count-label").textContent = `${count[0]} - ${count[1]}`;
  $("date-label").textContent = `${dateFromNum(date[0])} to ${dateFromNum(date[1])}`;
}

function resetFilters() {
  state.filters.countries = new Set(state.countries);
  state.filters.count = [...state.bounds.count];
  state.filters.date = [...state.bounds.date];
  $("count-min").value = state.bounds.count[0];
  $("count-max").value = state.bounds.count[1];
  $("date-min").value = state.bounds.date[0];
  $("date-max").value = state.bounds.date[1];
  syncCountryCheckboxes();
  onFiltersChanged();
}

function buildSearch() {
  // City name -> average coordinate of the patient points in that city.
  const sums = new Map();
  for (const f of state.data.patients.features) {
    const c = f.properties.city;
    const [x, y] = f.geometry.coordinates;
    const s = sums.get(c) || { x: 0, y: 0, n: 0 };
    s.x += x; s.y += y; s.n += 1;
    sums.set(c, s);
  }
  const cities = new Map([...sums].map(([c, s]) => [c, [s.x / s.n, s.y / s.n]]));
  cities.set("Blacksburg", BLACKSBURG_LNGLAT);

  $("city-list").innerHTML = [...cities.keys()].sort().map((c) => `<option value="${escapeHtml(c)}">`).join("");

  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("search-input").value.trim().toLowerCase();
    if (!q) return;
    const names = [...cities.keys()];
    const hit = names.find((n) => n.toLowerCase() === q)
      || names.find((n) => n.toLowerCase().startsWith(q))
      || names.find((n) => n.toLowerCase().includes(q));
    if (hit) {
      map.flyTo({ center: cities.get(hit), zoom: 8.5 });
      $("search-message").textContent = `Zoomed to ${hit}.`;
    } else {
      $("search-message").textContent = `No city matching "${$("search-input").value}".`;
    }
  });

  const dataBounds = new maplibregl.LngLatBounds();
  for (const f of state.data.patients.features) dataBounds.extend(f.geometry.coordinates);
  const targets = {
    blacksburg: () => map.flyTo({ center: BLACKSBURG_LNGLAT, zoom: 8 }),
    conus: () => map.fitBounds([[-125, 24], [-66, 50]], { padding: 30 }),
    world: () => map.fitBounds([[-170, -55], [175, 70]], { padding: 20 }),
    data: () => map.fitBounds(dataBounds, { padding: 50 }),
  };
  for (const button of document.querySelectorAll("[data-zoom]")) {
    button.addEventListener("click", () => targets[button.dataset.zoom]());
  }
  state.zoomToData = targets.data;
}

// ---------------------------------------------------------------------------
// 7. SUMMARY WIDGETS, VISIBLE-FEATURE LIST, LEGEND
// ---------------------------------------------------------------------------

let refreshTimer = null;
// Recompute widgets after the map stops moving (debounced so dragging is cheap).
function scheduleViewRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.extentOnly) { refreshSummary(); refreshList(); }
  }, 120);
}

function refreshSummary() {
  const t0 = performance.now();
  const bounds = state.extentOnly ? map.getBounds() : null;
  const inView = (coords) => !bounds || inBounds(coords, bounds);

  // Patient points: the "real" records.
  const points = state.data.patients.features;
  let n = 0, distSum = 0;
  const countries = new Set();
  const byCountry = {}; // counts ignoring the country filter (for the bars)
  for (const f of points) {
    const p = f.properties;
    if (!passesPoint(p, true) || !inView(f.geometry.coordinates)) continue;
    byCountry[p.country] = (byCountry[p.country] || 0) + 1;
    if (!state.filters.countries.has(p.country)) continue;
    n += 1;
    distSum += p.distance_miles;
    countries.add(p.country);
  }

  // Hexagons: pre-aggregated, so they only respond to country + count filters.
  let hexN = 0, hexPatients = 0;
  for (const f of state.data.hex3.features) {
    if (passesAgg(f.properties) && inView(ringCentre(f.geometry))) {
      hexN += 1;
      hexPatients += f.properties.patient_count;
    }
  }

  const cards = [
    [formatInt(n), "patients (points)"],
    [countries.size, "countries"],
    [n ? formatInt(distSum / n) : "-", "mean distance to Blacksburg (mi)"],
    [`${hexN} / ${formatInt(hexPatients)}`, "res-3 hexes / patients in them"],
  ];
  $("stat-cards").innerHTML = cards
    .map(([value, label]) => `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`)
    .join("");

  renderBarChart(byCountry);
  state.timings.lastSummaryMs = performance.now() - t0;
}

function renderBarChart(byCountry) {
  const rows = state.countries
    .map((c) => [c, byCountry[c] || 0])
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const selected = state.filters.countries;
  const box = $("bar-chart");
  box.innerHTML = rows.map(([country, value]) => {
    const on = selected.has(country);
    return `<div class="bar-row ${on && selected.size === 1 ? "selected" : ""}" data-country="${escapeHtml(country)}" style="opacity:${on ? 1 : 0.35}">` +
      `<span class="name" title="${escapeHtml(country)}">${escapeHtml(country)}</span>` +
      `<span class="track"><span class="fill" style="display:block;width:${(value / max) * 100}%;background:${state.countryColour[country]}"></span></span>` +
      `<span class="num">${value}</span></div>`;
  }).join("");
}

function onBarClick(country) {
  const only = state.filters.countries.size === 1 && state.filters.countries.has(country);
  state.filters.countries = only ? new Set(state.countries) : new Set([country]);
  syncCountryCheckboxes();
  onFiltersChanged();
}

function refreshList() {
  const key = $("list-layer").value;
  const bounds = state.extentOnly ? map.getBounds() : null;
  const inView = (coords) => !bounds || inBounds(coords, bounds);

  let items;
  if (key === "patients") {
    items = state.data.patients.features
      .filter((f) => passesPoint(f.properties) && inView(f.geometry.coordinates))
      .sort((a, b) => b.properties.date_num - a.properties.date_num);
  } else {
    items = state.data[key].features
      .filter((f) => passesAgg(f.properties) && inView(ringCentre(f.geometry)))
      .sort((a, b) => b.properties.patient_count - a.properties.patient_count);
  }

  const shown = items.slice(0, LIST_LIMIT);
  $("list-count").textContent =
    `${formatInt(items.length)} feature(s)` + (items.length > LIST_LIMIT ? `, showing the first ${LIST_LIMIT}` : "") +
    (state.extentOnly ? " in the current view" : "") + ".";

  const ul = $("feature-list");
  ul.innerHTML = "";
  for (const f of shown) {
    const p = f.properties;
    const li = document.createElement("li");
    li.innerHTML = key === "patients"
      ? `${escapeHtml(p.city)}, ${escapeHtml(p.region)}<div class="sub">${escapeHtml(p.country)} - ${escapeHtml(p.procedure_date)} - ${formatValue(p.distance_miles)} mi</div>`
      : `${escapeHtml(p.cities)}<div class="sub">${p.patient_count} patients - ${escapeHtml(p.h3_index)}</div>`;
    li.addEventListener("click", () => zoomToFeature(f, key));
    ul.appendChild(li);
  }
}

function zoomToFeature(feature, key) {
  if (feature.geometry.type === "Point") {
    const lngLat = feature.geometry.coordinates;
    map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 8) });
    showFeaturePopup(lngLat, LAYER_TITLES.patients, feature.properties);
  } else {
    map.fitBounds(geometryBounds(feature.geometry), { padding: 80, maxZoom: 8 });
    showFeaturePopup(ringCentre(feature.geometry), LAYER_TITLES[`${key}-fill`], feature.properties);
  }
}

function refreshLegend() {
  const blocks = [];
  const visible = (key) => layerVisible(key);

  if (visible("hex3") || visible("hex4")) {
    blocks.push(`<div class="legend-block"><h4>Hexagon fill: patient count</h4>` +
      `<div class="ramp" style="background:${rampCss(COUNT_RAMP)}"></div>` +
      `<div class="ramp-labels"><span>1</span><span>${COUNT_RAMP[COUNT_RAMP.length - 1][0]}</span></div></div>`);
  }
  if (visible("patients")) {
    if (state.pointColourMode === "country") {
      blocks.push(`<div class="legend-block"><h4>Patient points: country</h4>` +
        state.countries.map((c) => `<div class="row"><span class="swatch" style="background:${state.countryColour[c]}"></span>${escapeHtml(c)}</div>`).join("") +
        `</div>`);
    } else {
      blocks.push(`<div class="legend-block"><h4>Patient points: miles to Blacksburg</h4>` +
        `<div class="ramp" style="background:${rampCss(DISTANCE_RAMP)}"></div>` +
        `<div class="ramp-labels"><span>0</span><span>10,000</span></div></div>`);
    }
  }
  if (visible("lines3") || visible("lines4")) {
    const which = [visible("lines3") && "res 3", visible("lines4") && "res 4"].filter(Boolean).join(" + ");
    blocks.push(`<div class="legend-block"><h4>Lines (${which}): colour = miles, width = patients</h4>` +
      `<div class="ramp" style="background:${rampCss(DISTANCE_RAMP)}"></div>` +
      `<div class="ramp-labels"><span>0 mi</span><span>10,000 mi</span></div></div>`);
  }
  if (visible("centroids3") || visible("centroids4")) {
    blocks.push(`<div class="legend-block"><h4>Centroids: size = patients</h4>` +
      (visible("centroids3") ? `<div class="row"><span class="swatch" style="background:#ffb703"></span>H3 res 3</div>` : "") +
      (visible("centroids4") ? `<div class="row"><span class="swatch" style="background:#8ecae6"></span>H3 res 4</div>` : "") +
      `</div>`);
  }
  if (visible("blacksburg")) {
    blocks.push(`<div class="legend-block"><div class="row"><span class="swatch" style="background:#fff;box-shadow:0 0 0 2px #9df02c"></span>Lewis Gale (procedure site)</div></div>`);
  }
  $("legend").innerHTML = blocks.join("");
}

// ---------------------------------------------------------------------------
// 8. CLICK INTERACTION: popup + overlap query
// ---------------------------------------------------------------------------

let popup = null;
function showFeaturePopup(lngLat, title, props) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ maxWidth: "340px" })
    .setLngLat(lngLat)
    .setHTML(`<h3>${escapeHtml(title)}</h3>${attributeTable(props)}`)
    .addTo(map);
}

// CLICK-TO-QUERY DESIGN CHOICE
// Every visible hexagon covering the clicked point is found with our own
// point-in-polygon test over the full GeoJSON held in memory, NOT with
// map.queryRenderedFeatures. Reasons: (1) queryRenderedFeatures only sees
// what is currently drawn in the loaded tiles, so results depend on zoom,
// tiling and layer state, and features cut by tile edges can come back as
// several pieces; (2) the in-memory test is exact, returns each polygon once,
// and works for polygons that are hidden behind others. Its cost is that all
// the polygons must be in the browser, fine here, not for a huge dataset
// (there you would need queryRenderedFeatures or a server-side query).
// window.debugCompareOverlap() runs both methods side by side for checking.
function polygonsAt(lng, lat) {
  const found = [];
  for (const key of ["hex3", "hex4"]) {
    if (!layerVisible(key)) continue;
    for (const feature of state.data[key].features) {
      if (passesAgg(feature.properties) && pointInGeometry(lng, lat, feature.geometry)) {
        found.push({ key, feature });
      }
    }
  }
  return found;
}

function runOverlapQuery(lngLat) {
  const { lng, lat } = lngLat.wrap(); // fold repeated-world clicks back to +/-180
  const found = polygonsAt(lng, lat);
  const box = $("overlap-result");
  const section = $("overlap-section");
  section.open = true;

  map.getSource("highlight").setData({
    type: "FeatureCollection",
    features: [
      ...found.map((r) => ({ type: "Feature", properties: {}, geometry: r.feature.geometry })),
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } },
    ],
  });

  const where = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  if (!found.length) {
    box.innerHTML = `<p class="hint">No visible hexagon covers ${where}. (Check the layer toggles and filters.)</p>`;
    return;
  }

  const layerName = { hex3: "res 3", hex4: "res 4" };
  const rows = found.map((r) => {
    const p = r.feature.properties;
    return `<tr><td>${layerName[r.key]}</td><td>${p.patient_count}</td><td>${escapeHtml(p.cities)}</td></tr>`;
  }).join("");

  // Aggregate attributes across the overlapping polygons.
  const sums = {};
  const cities = new Set();
  const regions = new Set();
  let total = 0;
  for (const r of found) {
    const p = r.feature.properties;
    sums[r.key] = (sums[r.key] || 0) + p.patient_count;
    total += p.patient_count;
    p.cities.split(", ").forEach((c) => cities.add(c));
    p.regions.split(", ").forEach((c) => regions.add(c));
  }
  const perLayer = Object.entries(sums).map(([k, v]) => `${layerName[k]}: ${v}`).join(" | ");
  const doubleCount = Object.keys(sums).length > 1
    ? `<p class="hint">Res 3 and res 4 hexagons contain the same US patients, so summing across layers double-counts them. Use the per-layer sums.</p>` : "";

  box.innerHTML =
    `<p class="hint">${found.length} hexagon(s) cover ${where}.</p>` +
    `<table class="attrs"><thead><tr><th>Layer</th><th>Patients</th><th>Cities</th></tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr><td>Sum</td><td>${total}</td><td>mean ${(total / found.length).toFixed(1)} per hexagon</td></tr></tfoot></table>` +
    `<p class="hint">Per layer - ${perLayer}<br>Regions: ${escapeHtml([...regions].sort().join(", "))}<br>Cities: ${escapeHtml([...cities].sort().join(", "))}</p>` +
    doubleCount;
}

function clearOverlapResult() {
  if (!map.getSource("highlight")) return;
  map.getSource("highlight").setData({ type: "FeatureCollection", features: [] });
  $("overlap-result").innerHTML = `<p class="hint">Click the map to list every visible hexagon that covers that spot.</p>`;
}

function visibleInteractiveLayers() {
  return INTERACTIVE_LAYER_IDS.filter((id) => map.getLayoutProperty(id, "visibility") !== "none");
}

function wireMapInteraction() {
  const pad = 5; // pixels of click tolerance so thin lines and small points are hittable
  const boxAround = (pt) => [[pt.x - pad, pt.y - pad], [pt.x + pad, pt.y + pad]];

  map.on("click", (event) => {
    const hits = map.queryRenderedFeatures(boxAround(event.point), { layers: visibleInteractiveLayers() });
    if (hits.length) showFeaturePopup(event.lngLat, LAYER_TITLES[hits[0].layer.id], hits[0].properties);
    else if (popup) popup.remove();
    runOverlapQuery(event.lngLat);
  });

  map.on("mousemove", (event) => {
    const hits = map.queryRenderedFeatures(boxAround(event.point), { layers: visibleInteractiveLayers() });
    map.getCanvas().style.cursor = hits.length ? "pointer" : "";
  });

  map.on("moveend", scheduleViewRefresh);
}

// Debug helper (call from the browser console): compare our point-in-polygon
// answer with what MapLibre reports as rendered at the same spot.
window.debugCompareOverlap = (lng, lat) => {
  const pip = polygonsAt(lng, lat).map((r) => r.feature.properties.h3_index).sort();
  const px = map.project([lng, lat]);
  const rendered = [...new Set(map.queryRenderedFeatures([px.x, px.y], { layers: ["hex3-fill", "hex4-fill"] })
    .map((f) => f.properties.h3_index))].sort();
  return { pointInPolygon: pip, queryRenderedFeatures: rendered };
};

// ---------------------------------------------------------------------------
// 9. BOOT
// ---------------------------------------------------------------------------

function deriveDataSummaries() {
  const pts = state.data.patients.features;
  const counts = {};
  let maxDate = 0;
  for (const f of pts) {
    counts[f.properties.country] = (counts[f.properties.country] || 0) + 1;
    maxDate = Math.max(maxDate, f.properties.date_num);
  }
  state.countryCounts = counts;
  state.countries = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  state.countries.forEach((c, i) => { state.countryColour[c] = COUNTRY_PALETTE[i % COUNTRY_PALETTE.length]; });

  let maxCount = 1;
  for (const key of ["hex3", "hex4", "centroids", "lines"]) {
    for (const f of state.data[key].features) maxCount = Math.max(maxCount, f.properties.patient_count);
  }
  state.bounds = { count: [1, maxCount], date: [0, maxDate] };
  state.filters = { countries: new Set(state.countries), count: [1, maxCount], date: [0, maxDate] };
}

async function fetchBasemapStyle() {
  try {
    const response = await fetch(BASEMAP_STYLE_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn("Basemap style unavailable, using flat background:", err);
    return FALLBACK_STYLE;
  }
}

async function main() {
  const t0 = performance.now();
  const names = Object.keys(DATA_URLS);

  // Fetch the basemap style and all data files in parallel.
  const [style, ...datasets] = await Promise.all([
    fetchBasemapStyle(),
    ...names.map((n) => loadJson(DATA_URLS[n])),
  ]);
  names.forEach((n, i) => { state.data[n] = datasets[i]; });
  state.timings.dataMs = performance.now() - t0;
  deriveDataSummaries();

  map = new maplibregl.Map({
    container: "map",
    style,
    center: [-60, 30],
    zoom: 1.5,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.on("error", (e) => console.warn("Map error:", e.error && e.error.message));

  map.on("load", () => {
    state.timings.mapLoadMs = performance.now() - t0;
    addDataLayers();
    // Apply the filters once at startup: the per-resolution lines/centroid
    // layers depend on this to show only their own resolution.
    applyMapFilters();
    buildLayerToggles();
    buildCountryFilter();
    wireRange("count-min", "count-max", "count", state.bounds.count);
    wireRange("date-min", "date-max", "date", state.bounds.date);
    buildSearch();

    $("reset-filters").addEventListener("click", resetFilters);
    $("countries-all").addEventListener("click", () => {
      state.filters.countries = new Set(state.countries); syncCountryCheckboxes(); onFiltersChanged();
    });
    $("countries-none").addEventListener("click", () => {
      state.filters.countries = new Set(); syncCountryCheckboxes(); onFiltersChanged();
    });
    $("bar-chart").addEventListener("click", (event) => {
      const row = event.target.closest(".bar-row");
      if (row) onBarClick(row.dataset.country);
    });
    $("extent-only").addEventListener("change", (event) => {
      state.extentOnly = event.target.checked; refreshSummary(); refreshList();
    });
    $("list-layer").addEventListener("change", refreshList);
    $("point-color-mode").addEventListener("change", (e) => { state.pointColourMode = e.target.value; applyPointStyle(); refreshLegend(); });
    $("point-size-mode").addEventListener("change", (e) => { state.pointSizeMode = e.target.value; applyPointStyle(); });
    $("panel-toggle").addEventListener("click", () => {
      const collapsed = $("panel").classList.toggle("collapsed");
      $("panel-toggle").setAttribute("aria-expanded", String(!collapsed));
      setTimeout(() => map.resize(), 50);
    });

    wireMapInteraction();
    refreshFilterLabels();
    refreshLegend();
    refreshSummary();
    refreshList();
    state.zoomToData();

    map.once("idle", () => {
      state.timings.idleMs = performance.now() - t0;
      const n = state.data.patients.features.length;
      $("status").textContent =
        `${formatInt(n)} patient points | data ${state.timings.dataMs.toFixed(0)} ms | ` +
        `map load ${state.timings.mapLoadMs.toFixed(0)} ms | first idle ${state.timings.idleMs.toFixed(0)} ms`;
      console.info("timings (ms)", state.timings);
    });
  });

  window.app = { map, state }; // handy for poking around in the browser console
}

main().catch((err) => {
  console.error(err);
  $("status").textContent = `Error: ${err.message}. Serve this folder with python -m http.server (opening the file directly will not work).`;
});

# Lewis Gale demo map

An interactive web map prototype built with [MapLibre GL JS](https://maplibre.org/).
It shows **dummy (fabricated) patient-travel data** for a hospital procedure
site in Blacksburg, VA: individual points, H3 hexagon aggregates at two
resolutions, flow lines and centroids, with filters, a summary panel, a
click-to-query overlap lookup, and a phone-friendly layout.

**Live map:** https://cooperjaxc.github.io/lewis-gale-demo-map/

This is a test of a static, client-side web map stack (plain HTML/CSS/JS, no
backend, no build step). All data is invented for demonstration; none of it is
real patient information.

## Run it locally

Browsers will not load the data files from a `file://` address, so serve the
folder with Python's built-in web server:

```
python -m http.server 8000
```

then open http://127.0.0.1:8000/.

## What is in here

| Path | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The page, its styling and its behaviour |
| `data/` | Dummy data as GeoJSON (points, H3 polygons, centroids, lines) |
| `vendor/` | MapLibre GL JS 4.7.1, included so the site has no build step |

## Credits and notes

- Map library: MapLibre GL JS (BSD-3-Clause), included in `vendor/`.
- Basemap: CARTO "Dark Matter" style with OpenStreetMap data, fetched live
  from CARTO's servers; see the attribution shown on the map. A production
  deployment should use its own basemap source.
- H3 hexagons were produced with Uber's H3 library.
- No license has been applied to the code in this repository yet.

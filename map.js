// Map panel: shows the City's park map beside the chat and highlights the
// chatbot's latest results. It loads the City's public "Parks, Trails, and
// Facilities Web Map" (the same layers the chatbot searches), so it looks
// like the City's own app while this code controls what is shown.
//
// script.js calls FriscoMap.showResults(...) and FriscoMap.focusResult(...).
// If the map fails to load, the chat keeps working; only this panel says so.
(function () {
  const SDK_URL = "https://js.arcgis.com/4.31/";
  const SDK_CSS_URL = "https://js.arcgis.com/4.31/esri/themes/light/main.css";
  const WEB_MAP_ID = "4d14763d20a84ed69a81eb55a954fb3a";
  const PARK_LAYER_URL =
    "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkApp_Testing/FeatureServer/0";
  const RED = [198, 30, 48];
  const BLUE = [45, 105, 181];
  // Map scale used when zooming to a single point (about a few city blocks).
  const POINT_SCALE = 4000;
  // How far (in points) a result's number badge sits up and to the right of
  // the amenity, so the City's own icon underneath stays visible.
  const BADGE_OFFSET = 13;

  const status = document.querySelector("#map-status");
  let mapReady;
  let configReady;
  // Every showResults call gets a higher number; a slower, older update
  // that finishes later is discarded instead of mixing with the newer one.
  let latestUpdate = 0;
  // The answer currently drawn, so cards from older answers can redraw theirs.
  let shownResults = null;
  let parkOutlines = new Map();

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  // Load the ArcGIS SDK (about 1.5 MB) after the page, so it never delays
  // the chat. Skipped when the SDK is already present.
  function loadSdk() {
    if (typeof window.require === "function") return Promise.resolve();

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = SDK_CSS_URL;
    document.head.appendChild(css);

    return new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = SDK_URL;
      script.onload = resolve;
      script.onerror = function () { reject(new Error("The ArcGIS map library did not load.")); };
      document.head.appendChild(script);
    });
  }

  // Load the ArcGIS SDK modules and the City web map once.
  function loadMap() {
    if (!mapReady) {
      mapReady = loadSdk().then(function () {
        return new Promise(function (resolve, reject) {
          window.require([
            "esri/WebMap",
            "esri/views/MapView",
            "esri/layers/GraphicsLayer",
            "esri/layers/FeatureLayer",
            "esri/Graphic",
            "esri/geometry/Point",
            "esri/geometry/projection",
          ], function (WebMap, MapView, GraphicsLayer, FeatureLayer, Graphic, Point, projection) {
            const resultsLayer = new GraphicsLayer({ title: "Ask Walnut results" });
            const webMap = new WebMap({ portalItem: { id: WEB_MAP_ID } });
            // Add the results layer after the City's layers have loaded, so the
            // pins and outlines are drawn on top of the City's icons.
            webMap.when(function () { webMap.add(resultsLayer); });

            const view = new MapView({
              container: "map",
              map: webMap,
              padding: { top: 30, right: 30, bottom: 30, left: 30 },
            });
            // Used only to look up park outlines; it is not drawn on the map.
            const parkLayer = new FeatureLayer({ url: PARK_LAYER_URL });

            Promise.all([view.when(), projection.load()])
              .then(function () {
                const map = { view, resultsLayer, parkLayer, Graphic, Point, projection };
                loadConfig().then(function (config) { enableTooltips(map, config); });
                resolve(map);
              })
              .catch(reject);
          }, reject);
        });
      });

      mapReady
        .then(function () { setStatus("Ask a question to see results on the map."); })
        .catch(function (error) {
          console.error("Map failed to load:", error);
          // Hides the card numbers and map buttons, which would match nothing.
          document.body.classList.add("map-unavailable");
          setStatus("The map is unavailable right now. The chat still works.");
        });
    }

    return mapReady;
  }

  // Names shared by the server through /api/amenities:
  //   spellings:   displayed park name -> park-layer spelling (park-names.js)
  //   pointNames:  amenity-layer park spelling -> displayed park name
  //   labels:      City amenity value -> friendly name ("Restrooms" -> "restroom")
  //   typeLabels:  chatbot facility type -> friendly name
  function loadConfig() {
    if (!configReady) {
      configReady = fetch("/api/amenities")
        .then(function (response) { return response.ok ? response.json() : {}; })
        .catch(function () { return {}; })
        .then(function (data) {
          const spellings = data.parkNameSpellings || [];
          return {
            spellings: new Map(spellings.map(function (entry) {
              return [entry.display.toUpperCase(), entry.park];
            })),
            pointNames: new Map(spellings.filter(function (entry) { return entry.point; }).map(function (entry) {
              return [entry.point.toUpperCase(), entry.display];
            })),
            labels: new Map(Object.entries(data.amenityLabels || {})),
            typeLabels: new Map(Object.entries(data.amenities || {}).map(function ([type, amenity]) {
              return [type, amenity.singular];
            })),
          };
        });
    }
    return configReady;
  }

  // "basketball court" -> "Basketball Court"; "baseball/softball field" ->
  // "Baseball/Softball Field".
  function titleCase(text) {
    return String(text).replace(/(^|[\s/&-])([a-z])/g, function (match, before, letter) {
      return before + letter.toUpperCase();
    });
  }

  // Tooltip text for a hovered graphic: a numbered result, or any of the
  // City's amenity icons.
  function tooltipFor(graphic, config) {
    if (graphic.attributes?.tooltip) return graphic.attributes.tooltip;

    const amenity = graphic.attributes?.Amenity;
    if (!amenity) return null;

    const label = titleCase(config.labels.get(amenity) || amenity);
    const park = graphic.attributes.Park;
    const parkName = park ? config.pointNames.get(String(park).toUpperCase()) || park : null;
    return parkName ? `${label} · ${parkName}` : label;
  }

  // Show a small tooltip naming whatever amenity or result is under the
  // pointer. Touch screens have no hover; tapping an icon opens the City's
  // own popup instead.
  function enableTooltips(map, config) {
    const container = map.view.container;
    if (!container) return;

    const tooltip = document.createElement("div");
    tooltip.className = "map-tooltip";
    tooltip.hidden = true;
    container.appendChild(tooltip);

    const amenityLayer = map.view.map.allLayers.find(function (layer) {
      return layer.type === "feature" && /ParkAmenities_Test/i.test(layer.url || "");
    });
    if (amenityLayer) {
      // The City's icons only request the amenity type; add the park name.
      amenityLayer.outFields = ["Amenity", "Park"];
    }

    let latestMove = 0;
    map.view.on("pointer-move", function (event) {
      const move = ++latestMove;
      map.view.hitTest(event, { include: [map.resultsLayer, amenityLayer].filter(Boolean) })
        .then(function (response) {
          // Ignore answers for older pointer positions.
          if (move !== latestMove) return;

          const text = response.results
            .map(function (hit) { return hit.graphic && tooltipFor(hit.graphic, config); })
            .find(Boolean);
          if (!text) {
            tooltip.hidden = true;
            container.style.cursor = "";
            return;
          }

          tooltip.textContent = text;
          tooltip.style.left = `${event.x + 14}px`;
          tooltip.style.top = `${event.y + 14}px`;
          tooltip.hidden = false;
          container.style.cursor = "pointer";
        })
        .catch(function () { /* hit tests can be interrupted by map movement */ });
    });
    map.view.on("pointer-leave", function () {
      latestMove += 1;
      tooltip.hidden = true;
    });
  }

  function nameOf(result) {
    return String(result.park || result.name || "");
  }

  function hasCoordinates(result) {
    return Number.isFinite(result.latitude) && Number.isFinite(result.longitude);
  }

  // Convert latitude/longitude into the map's own coordinate system.
  function toMapPoint(map, latitude, longitude) {
    const point = new map.Point({ latitude, longitude });
    return map.projection.project(point, map.view.spatialReference);
  }

  // Look up park outlines, returned as displayed name (upper case) -> polygon.
  async function findParkOutlines(map, names) {
    const outlines = new Map();
    if (!names.length) return outlines;

    const { spellings } = await loadConfig();
    const displayByParkName = new Map();
    for (const name of names) {
      displayByParkName.set((spellings.get(name.toUpperCase()) || name).toUpperCase(), name.toUpperCase());
    }

    const list = [...displayByParkName.keys()]
      .map(function (name) { return `'${name.replaceAll("'", "''")}'`; })
      .join(", ");
    const { features } = await map.parkLayer.queryFeatures({
      where: `UPPER(ParkName) IN (${list})`,
      outFields: ["ParkName"],
      returnGeometry: true,
      outSpatialReference: map.view.spatialReference,
    });

    for (const feature of features) {
      const display = displayByParkName.get(String(feature.attributes.ParkName).toUpperCase());
      if (display) outlines.set(display, feature.geometry);
    }
    return outlines;
  }

  // A result marker numbered like its card. On an amenity, a red ring circles
  // the City's own icon and the number sits as a badge at its top-right, so
  // the icon stays visible. A park-level result gets a plain numbered pin.
  function resultMarker(map, geometry, number, tooltip, onAmenity) {
    const attributes = { tooltip };
    const offset = onAmenity ? BADGE_OFFSET : 0;
    const graphics = [];

    if (onAmenity) {
      graphics.push(new map.Graphic({
        geometry,
        attributes,
        symbol: {
          type: "simple-marker",
          style: "circle",
          size: 32,
          color: [0, 0, 0, 0],
          outline: { color: RED, width: 3 },
        },
      }));
    }

    graphics.push(
      new map.Graphic({
        geometry,
        attributes,
        symbol: {
          type: "simple-marker",
          style: "circle",
          size: onAmenity ? 18 : 22,
          color: RED,
          outline: { color: [255, 255, 255], width: 2 },
          xoffset: offset,
          yoffset: offset,
        },
      }),
      new map.Graphic({
        geometry,
        attributes,
        symbol: {
          type: "text",
          text: String(number),
          color: [255, 255, 255],
          verticalAlignment: "middle",
          horizontalAlignment: "center",
          font: { size: onAmenity ? 9 : 10, weight: "bold" },
          xoffset: offset,
          yoffset: offset,
        },
      })
    );
    return graphics;
  }

  // Zoom to the given geometries; single points get a street-level scale.
  // A zoom interrupted by a newer one (e.g. a card click) is not an error.
  async function zoomTo(map, geometries) {
    if (!geometries.length) return;

    try {
      if (geometries.length === 1 && geometries[0].type === "point") {
        await map.view.goTo({ target: geometries[0], scale: POINT_SCALE });
        return;
      }

      await map.view.goTo(geometries);
      if (map.view.scale < POINT_SCALE) {
        await map.view.goTo({ scale: POINT_SCALE });
      }
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
  }

  /**
   * Show one answer's results: outline each park, add a numbered pin for each
   * result, mark the resident's location for nearby searches, and zoom to fit
   * (unless options.fit is false). An empty list clears the previous results.
   */
  async function showResults(results, userLocation, options = {}) {
    const update = ++latestUpdate;

    try {
      const map = await loadMap();
      const config = await loadConfig();
      const names = [...new Set(results.map(nameOf).filter(Boolean))];
      const outlines = await findParkOutlines(map, names);

      // A newer answer started while this one was loading; let it win.
      if (update !== latestUpdate) return;

      const graphics = [];
      for (const geometry of outlines.values()) {
        graphics.push(new map.Graphic({
          geometry,
          symbol: {
            type: "simple-fill",
            color: [...BLUE, 0.12],
            outline: { color: BLUE, width: 2.5 },
          },
        }));
      }

      // Each result gets a pin numbered like its card: at the amenity's own
      // location when known, otherwise in the middle of its park's outline.
      let pinCount = 0;
      results.forEach(function (result, index) {
        const onAmenity = hasCoordinates(result);
        const point = onAmenity
          ? toMapPoint(map, result.latitude, result.longitude)
          : outlines.get(nameOf(result).toUpperCase())?.centroid;
        if (point) {
          // e.g. "#1 · Basketball Court · Gallegos Park"
          const type = config.typeLabels.get(result.facilityType);
          const tooltip = [`#${index + 1}`, type && titleCase(type), nameOf(result)]
            .filter(Boolean)
            .join(" · ");
          graphics.push(...resultMarker(map, point, index + 1, tooltip, onAmenity));
          pinCount += 1;
        }
      });

      // The resident's location is shown only when distances were measured.
      const measured = results.some(function (result) {
        return Number.isFinite(result.distanceMiles);
      });
      if (userLocation && measured) {
        graphics.push(new map.Graphic({
          geometry: toMapPoint(map, userLocation.latitude, userLocation.longitude),
          symbol: {
            type: "simple-marker",
            size: 14,
            color: BLUE,
            outline: { color: [255, 255, 255], width: 3 },
          },
        }));
      }

      map.resultsLayer.removeAll();
      map.resultsLayer.addMany(graphics);
      parkOutlines = outlines;
      shownResults = results;

      if (!results.length) {
        setStatus("No results to show on the map.");
      } else if (pinCount) {
        setStatus(`Showing ${pinCount} numbered ${pinCount === 1 ? "result" : "results"} from Walnut's answer.`);
      } else {
        setStatus("These results could not be placed on the map.");
      }

      if (options.fit !== false) {
        await zoomTo(map, graphics.map(function (graphic) { return graphic.geometry; }));
      }
    } catch (error) {
      if (update !== latestUpdate) return;
      console.error("Could not show results on the map:", error);
      if (!document.body.classList.contains("map-unavailable")) {
        setStatus("Those results could not be shown on the map.");
      }
    }
  }

  /**
   * Zoom to one result when its card is clicked. Cards from an older answer
   * first redraw that answer's pins, so the numbers on the map match.
   */
  async function focusResult(result, answerResults, userLocation) {
    try {
      const map = await loadMap();

      if (answerResults && answerResults !== shownResults) {
        await showResults(answerResults, userLocation, { fit: false });
        // Another answer was drawn meanwhile; don't zoom to a stale result.
        if (shownResults !== answerResults) return;
      }

      const target = hasCoordinates(result)
        ? toMapPoint(map, result.latitude, result.longitude)
        : parkOutlines.get(nameOf(result).toUpperCase());
      if (target) await zoomTo(map, [target]);
    } catch (error) {
      console.error("Could not zoom to that result:", error);
    }
  }

  window.FriscoMap = { showResults, focusResult };
  loadMap().catch(function () { /* reported in loadMap */ });
})();

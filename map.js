// Map panel: shows the City's park map beside the chat and highlights the
// chatbot's latest results. It loads the City's public "Parks, Trails, and
// Facilities Web Map" (the same layers the chatbot searches), so it looks
// like the City's own app while this code controls what is shown.
//
// script.js calls FriscoMap.showResults(...) and FriscoMap.focusResult(...).
// If the map fails to load, the chat keeps working; only this panel says so.
(function () {
  const WEB_MAP_ID = "4d14763d20a84ed69a81eb55a954fb3a";
  const PARK_LAYER_URL =
    "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkApp_Testing/FeatureServer/0";
  const RED = [198, 30, 48];
  const BLUE = [45, 105, 181];
  // Map scale used when zooming to a single point (about a few city blocks).
  const POINT_SCALE = 4000;

  const status = document.querySelector("#map-status");
  let mapReady;
  let parkOutlines = new Map();

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  // Load the ArcGIS SDK modules and the City web map once.
  function loadMap() {
    if (!mapReady) {
      mapReady = new Promise(function (resolve, reject) {
        if (typeof window.require !== "function") {
          reject(new Error("The ArcGIS map library did not load."));
          return;
        }

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
              resolve({ view, resultsLayer, parkLayer, Graphic, Point, projection });
            })
            .catch(reject);
        });
      });

      mapReady
        .then(function () { setStatus("Ask a question to see results on the map."); })
        .catch(function (error) {
          console.error("Map failed to load:", error);
          setStatus("The map is unavailable right now. The chat still works.");
        });
    }

    return mapReady;
  }

  // Convert latitude/longitude into the map's own coordinate system.
  function toMapPoint(map, latitude, longitude) {
    const point = new map.Point({ latitude, longitude });
    return map.projection.project(point, map.view.spatialReference);
  }

  function hasCoordinates(result) {
    return Number.isFinite(result.latitude) && Number.isFinite(result.longitude);
  }

  // Look up park outlines by name. Names come from City GIS results.
  async function findParkOutlines(map, names) {
    if (!names.length) return [];

    const list = names
      .map(function (name) { return `'${name.toUpperCase().replaceAll("'", "''")}'`; })
      .join(", ");
    const { features } = await map.parkLayer.queryFeatures({
      where: `UPPER(ParkName) IN (${list})`,
      outFields: ["ParkName"],
      returnGeometry: true,
      outSpatialReference: map.view.spatialReference,
    });
    return features;
  }

  // A numbered pin matching the number on the result card.
  function numberedPin(map, geometry, number) {
    return [
      new map.Graphic({
        geometry,
        symbol: {
          type: "simple-marker",
          style: "circle",
          size: 22,
          color: RED,
          outline: { color: [255, 255, 255], width: 2 },
        },
      }),
      new map.Graphic({
        geometry,
        symbol: {
          type: "text",
          text: String(number),
          color: [255, 255, 255],
          verticalAlignment: "middle",
          horizontalAlignment: "center",
          font: { size: 10, weight: "bold" },
        },
      }),
    ];
  }

  // Zoom to the given geometries; single points get a street-level scale.
  async function zoomTo(map, geometries) {
    if (!geometries.length) return;

    if (geometries.length === 1 && geometries[0].type === "point") {
      await map.view.goTo({ target: geometries[0], scale: POINT_SCALE });
      return;
    }

    await map.view.goTo(geometries);
    if (map.view.scale < POINT_SCALE) {
      await map.view.goTo({ scale: POINT_SCALE });
    }
  }

  /**
   * Show one answer's results: outline each park, add a numbered pin for each
   * mapped amenity, mark the resident's location for nearby searches, and
   * zoom to fit. An empty list clears the previous results.
   */
  async function showResults(results, userLocation) {
    try {
      const map = await loadMap();
      map.resultsLayer.removeAll();
      parkOutlines = new Map();

      if (!results.length) {
        setStatus("No results to show on the map.");
        return;
      }

      const graphics = [];
      const names = [...new Set(results.map(function (result) {
        return result.park || result.name;
      }).filter(Boolean))];

      for (const feature of await findParkOutlines(map, names)) {
        parkOutlines.set(feature.attributes.ParkName.toUpperCase(), feature.geometry);
        graphics.push(new map.Graphic({
          geometry: feature.geometry,
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
        const outline = parkOutlines.get(String(result.park || result.name || "").toUpperCase());
        const point = hasCoordinates(result)
          ? toMapPoint(map, result.latitude, result.longitude)
          : outline?.centroid;
        if (point) {
          graphics.push(...numberedPin(map, point, index + 1));
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

      map.resultsLayer.addMany(graphics);
      await zoomTo(map, graphics.map(function (graphic) { return graphic.geometry; }));

      setStatus(pinCount
        ? `Showing ${pinCount} numbered ${pinCount === 1 ? "result" : "results"} from Walnut's answer.`
        : "These results could not be placed on the map.");
    } catch (error) {
      console.error("Could not show results on the map:", error);
      setStatus("Those results could not be shown on the map.");
    }
  }

  // Zoom to one result when its card is clicked.
  async function focusResult(result) {
    try {
      const map = await loadMap();
      const outline = parkOutlines.get(String(result.park || result.name || "").toUpperCase());
      const target = hasCoordinates(result)
        ? toMapPoint(map, result.latitude, result.longitude)
        : outline;
      if (target) await zoomTo(map, [target]);
    } catch (error) {
      console.error("Could not zoom to that result:", error);
    }
  }

  window.FriscoMap = { showResults, focusResult };
  loadMap();
})();

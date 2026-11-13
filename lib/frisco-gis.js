const AMENITY_LAYER_URL =
  "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkAmenities_Test/FeatureServer/0";
const PARK_LAYER_URL =
  "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkApp_Testing/FeatureServer/0";

const { AMENITY_NAMES, PARK_AMENITY_FIELDS } = require("./amenities");
const PARK_FIELDS = [
  "ParkName", "Address", ...new Set(Object.values(PARK_AMENITY_FIELDS)),
  "AllAmenities", "Website", "ParkDesc", "ImageURL",
].join(",");

const { resolveParkName } = require("./park-names");

// Send a query to ArcGIS and turn its error responses into useful errors.
async function queryArcGis(layerUrl, parameters, queryName) {
  const query = new URLSearchParams(parameters);
  let response;

  try {
    response = await fetch(`${layerUrl}/query?${query.toString()}`);
  } catch (error) {
    throw new Error(
      `City of Frisco ${queryName} could not be reached: ${error.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `City of Frisco ${queryName} failed with HTTP status ${response.status}.`
    );
  }

  let data;

  try {
    data = await response.json();
  } catch (error) {
    throw new Error(
      `City of Frisco ${queryName} returned an unreadable response.`
    );
  }

  // ArcGIS can return HTTP 200 while putting the real error in the JSON body.
  if (data.error) {
    const details = Array.isArray(data.error.details)
      ? data.error.details.filter(Boolean).join(" ")
      : "";
    const message = [data.error.message, details].filter(Boolean).join(" ");
    const code = data.error.code ? ` (code ${data.error.code})` : "";

    throw new Error(
      `City of Frisco ${queryName} failed${code}: ${message || "Unknown ArcGIS error."}`
    );
  }

  return data;
}

// Escape apostrophes before putting a park name into an ArcGIS SQL condition.
function escapeSqlText(value) {
  return String(value).replaceAll("'", "''");
}

// Convert empty GIS values to null instead of inventing missing information.
function valueOrNull(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

// The City layer includes a UI placeholder; it is not an actual park.
function isRealParkName(name) {
  return typeof name === "string" && name.trim() !== "" &&
    !/^select a park\b/i.test(name.trim());
}

// Calculate the straight-line distance between two points on Earth.
function haversineMiles(latitude1, longitude1, latitude2, longitude2) {
  const earthRadiusMiles = 3958.8;
  const degreesToRadians = Math.PI / 180;
  const latitudeChange = (latitude2 - latitude1) * degreesToRadians;
  const longitudeChange = (longitude2 - longitude1) * degreesToRadians;
  const startLatitude = latitude1 * degreesToRadians;
  const endLatitude = latitude2 * degreesToRadians;

  const haversineValue =
    Math.sin(latitudeChange / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeChange / 2) ** 2;

  const centralAngle =
    2 * Math.atan2(Math.sqrt(haversineValue), Math.sqrt(1 - haversineValue));

  return earthRadiusMiles * centralAngle;
}

function validateSearch({ latitude, longitude, facilityType, radiusMiles }) {
  const normalizedFacilityType = String(facilityType || "")
    .trim()
    .toLowerCase();
  const numericLatitude = Number(latitude);
  const numericLongitude = Number(longitude);
  const numericRadius = Number(radiusMiles);

  if (!Number.isFinite(numericLatitude) || numericLatitude < -90 || numericLatitude > 90) {
    throw new TypeError("latitude must be a number between -90 and 90.");
  }

  if (
    !Number.isFinite(numericLongitude) ||
    numericLongitude < -180 ||
    numericLongitude > 180
  ) {
    throw new TypeError("longitude must be a number between -180 and 180.");
  }

  if (!AMENITY_NAMES[normalizedFacilityType]) {
    throw new TypeError("Unsupported facilityType.");
  }

  if (!Number.isFinite(numericRadius) || numericRadius <= 0) {
    throw new TypeError("radiusMiles must be a number greater than 0.");
  }

  return {
    latitude: numericLatitude,
    longitude: numericLongitude,
    facilityType: normalizedFacilityType,
    radiusMiles: numericRadius,
  };
}

async function findParkDetails(parkName) {
  if (!parkName) {
    return null;
  }

  // Use a known alias when the two City layers spell the same park differently.
  const parkLayerName = resolveParkName(parkName).park;

  // The second GIS call joins details to an amenity using the shared park name.
  const safeParkName = escapeSqlText(parkLayerName);
  const data = await queryArcGis(
    PARK_LAYER_URL,
    {
      where: `ParkName = '${safeParkName}'`,
      outFields: PARK_FIELDS,
      returnGeometry: "false",
      f: "json",
    },
    "park-details query"
  );

  return data.features?.[0]?.attributes || null;
}

/**
 * Find up to five results for a supported amenity.
 *
 * Two GIS calls are needed because the amenity layer contains the precise point
 * used for distance, while the park layer contains addresses and descriptions.
 */
async function findNearbyFacilities({
  latitude,
  longitude,
  facilityType,
  radiusMiles,
  searchMode = "nearby",
  parkName,
}) {
  const search = validateSearch({
    latitude,
    longitude,
    facilityType,
    radiusMiles,
  });
  const amenityName = AMENITY_NAMES[search.facilityType];

  if (!["nearby", "parks", "at_park"].includes(searchMode)) {
    throw new TypeError("Unsupported searchMode.");
  }
  // Park-wide questions use the polygon layer's recorded amenity flags.
  // No polygon perimeter or centroid is presented as an amenity distance.
  if (searchMode === "parks") {
    const field = PARK_AMENITY_FIELDS[search.facilityType];
    const data = await queryArcGis(PARK_LAYER_URL, {
      where: `${field} IS NOT NULL AND ${field} <> '' AND ${field} <> 'No'`,
      outFields: PARK_FIELDS, returnGeometry: "false", orderByFields: "ParkName", f: "json",
    }, "parks-with-amenity query");
    return (data.features || [])
      .filter(function (feature) { return isRealParkName(feature.attributes?.ParkName); })
      .slice(0, 5)
      .map(function ({ attributes: park }) {
      return {
        name: resolveParkName(park.ParkName).display, park: resolveParkName(park.ParkName).display, facilityType: search.facilityType,
        address: valueOrNull(park.Address), latitude: null, longitude: null,
        distanceMiles: null, website: valueOrNull(park.Website),
        description: valueOrNull(park.ParkDesc), imageUrl: valueOrNull(park.ImageURL),
        amenities: valueOrNull(park.AllAmenities), source: "City of Frisco GIS",
      };
    });
  }
  if (searchMode === "at_park" && !String(parkName || "").trim()) {
    throw new TypeError("A park name is required for an at-park search.");
  }

  // A recorded park flag can establish presence even without mapped points.
  const namedPark = searchMode === "at_park" ? await findParkDetails(parkName) : null;
  // Query the point layer first so results use actual amenity coordinates.
  const amenityData = await queryArcGis(
    AMENITY_LAYER_URL,
    {
      where: `Amenity = '${amenityName}'` + (parkName
        ? ` AND Park = '${escapeSqlText(resolveParkName(parkName).point)}'` : ""),
      ...(searchMode === "nearby" ? {
      geometry: `${search.longitude},${search.latitude}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(search.radiusMiles),
      units: "esriSRUnit_StatuteMile",
      } : {}),
      outFields: "FID,Park,Amenity",
      returnGeometry: "true",
      outSR: "4326",
      f: "json",
    },
    "amenity query"
  );

  const seenParks = new Set();
  const nearbyAmenities = (amenityData.features || [])
    .filter(function (feature) {
      return (
        isRealParkName(feature.attributes?.Park) && feature.geometry &&
        Number.isFinite(feature.geometry.y) &&
        Number.isFinite(feature.geometry.x)
      );
    })
    .map(function (feature) {
      const amenityLatitude = feature.geometry.y;
      const amenityLongitude = feature.geometry.x;

      return {
        park: resolveParkName(feature.attributes?.Park).display,
        amenity: feature.attributes?.Amenity || amenityName,
        latitude: amenityLatitude,
        longitude: amenityLongitude,
        // Haversine measures distance over the Earth's curved surface.
        distanceMiles: haversineMiles(
          search.latitude,
          search.longitude,
          amenityLatitude,
          amenityLongitude
        ),
      };
    })
    .sort(function (first, second) {
      return first.distanceMiles - second.distanceMiles;
    })
    .filter(function (amenity) {
      // Nearby recommendations show each park once, retaining its closest point.
      // Named-place point searches retain individual mapped facilities.
      if (searchMode !== "nearby") return true;
      const key = amenity.park.trim().toLowerCase();
      if (seenParks.has(key)) return false;
      seenParks.add(key);
      return true;
    })
    .slice(0, 5);

  const flag = namedPark?.[PARK_AMENITY_FIELDS[search.facilityType]];
  if (nearbyAmenities.length === 0 && flag !== undefined && flag !== null && String(flag).trim() &&
      !["no", "false", "0"].includes(String(flag).trim().toLowerCase())) {
    const name = resolveParkName(namedPark.ParkName || parkName).display;
    return [{
      name, park: name, facilityType: search.facilityType,
      address: valueOrNull(namedPark.Address), latitude: null, longitude: null,
      distanceMiles: null, website: valueOrNull(namedPark.Website),
      description: valueOrNull(namedPark.ParkDesc), imageUrl: valueOrNull(namedPark.ImageURL),
      amenities: valueOrNull(namedPark.AllAmenities), source: "City of Frisco GIS",
    }];
  }

  // Enrich each of the five closest points with its matching park record.
  return Promise.all(
    nearbyAmenities.map(async function (amenity) {
      const parkDetails = await findParkDetails(amenity.park);

      return {
        // Display a consistent name across both source layers.
        name: amenity.park,
        park: amenity.park,
        facilityType: search.facilityType,
        address: valueOrNull(parkDetails?.Address),
        latitude: amenity.latitude,
        longitude: amenity.longitude,
        distanceMiles: searchMode === "at_park" ? null : Number(amenity.distanceMiles.toFixed(2)),
        website: valueOrNull(parkDetails?.Website),
        description: valueOrNull(parkDetails?.ParkDesc),
        imageUrl: valueOrNull(parkDetails?.ImageURL),
        source: "City of Frisco GIS",
      };
    })
  );
}

module.exports = { findNearbyFacilities };

const AMENITY_LAYER_URL =
  "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkAmenities_Test/FeatureServer/0";
const PARK_LAYER_URL =
  "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkApp_Testing/FeatureServer/0";

const AMENITY_NAMES = {
  basketball: "Basketball",
  playground: "Playground",
};

// Temporary corrections for known name differences between the two layers.
// Keep these explicit so a similar-looking park is never matched by accident.
const PARK_NAME_ALIASES = {
  "Wrangler's Range Park": "Wranger's Range Park",
};

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
    throw new TypeError('facilityType must be either "basketball" or "playground".');
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
  const parkLayerName = PARK_NAME_ALIASES[parkName] || parkName;

  // The second GIS call joins details to an amenity using the shared park name.
  const safeParkName = escapeSqlText(parkLayerName);
  const data = await queryArcGis(
    PARK_LAYER_URL,
    {
      where: `ParkName = '${safeParkName}'`,
      outFields:
        "ParkName,Address,Basketball,Playground,Website,ParkDesc,ImageURL",
      returnGeometry: "false",
      f: "json",
    },
    "park-details query"
  );

  return data.features?.[0]?.attributes || null;
}

/**
 * Find up to five nearby basketball courts or playgrounds.
 *
 * Two GIS calls are needed because the amenity layer contains the precise point
 * used for distance, while the park layer contains addresses and descriptions.
 */
async function findNearbyFacilities({
  latitude,
  longitude,
  facilityType,
  radiusMiles,
}) {
  const search = validateSearch({
    latitude,
    longitude,
    facilityType,
    radiusMiles,
  });
  const amenityName = AMENITY_NAMES[search.facilityType];

  // Query the point layer first so results use actual amenity coordinates.
  const amenityData = await queryArcGis(
    AMENITY_LAYER_URL,
    {
      where: `Amenity = '${amenityName}'`,
      geometry: `${search.longitude},${search.latitude}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(search.radiusMiles),
      units: "esriSRUnit_StatuteMile",
      outFields: "FID,Park,Amenity",
      returnGeometry: "true",
      outSR: "4326",
      f: "json",
    },
    "amenity query"
  );

  const nearbyAmenities = (amenityData.features || [])
    .filter(function (feature) {
      return (
        feature.geometry &&
        Number.isFinite(feature.geometry.y) &&
        Number.isFinite(feature.geometry.x)
      );
    })
    .map(function (feature) {
      const amenityLatitude = feature.geometry.y;
      const amenityLongitude = feature.geometry.x;

      return {
        park: feature.attributes?.Park || null,
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
    .slice(0, 5);

  // Enrich each of the five closest points with its matching park record.
  return Promise.all(
    nearbyAmenities.map(async function (amenity) {
      const parkDetails = await findParkDetails(amenity.park);

      return {
        // Keep the amenity layer's original name even when an alias was used.
        name: amenity.park,
        park: amenity.park,
        facilityType: search.facilityType,
        address: valueOrNull(parkDetails?.Address),
        latitude: amenity.latitude,
        longitude: amenity.longitude,
        distanceMiles: Number(amenity.distanceMiles.toFixed(2)),
        website: valueOrNull(parkDetails?.Website),
        description: valueOrNull(parkDetails?.ParkDesc),
        imageUrl: valueOrNull(parkDetails?.ImageURL),
        source: "City of Frisco GIS",
      };
    })
  );
}

module.exports = { findNearbyFacilities };

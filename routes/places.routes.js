/**
 * Places proxy — Google Places API (New)
 *
 * Why a proxy instead of calling Google from the app:
 *   1. The API key never ships inside the APK (an in-app key is extractable and
 *      Places is billed per request, so a leaked key is a billing liability).
 *   2. The server key can be locked down by IP in Google Cloud Console.
 *   3. Requests are auth-gated, so only logged-in users can spend quota.
 *   4. Autocomplete sessions + caching can be managed centrally.
 *
 * Endpoints:
 *   GET /api/places/autocomplete?input=&kind=city|area&lat=&lng=&sessionToken=
 *   GET /api/places/details?placeId=&sessionToken=
 *
 * Requires GOOGLE_PLACES_API_KEY in the environment. When it's missing the
 * endpoints return 503 with a clear message rather than throwing, so the app can
 * fall back to plain text entry.
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Logger = require('../utils/logger');

const logger = new Logger('Places');

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';

// Results are restricted to India — this is an India-only product.
const REGION_CODES = ['IN'];
const REGION_CODE = 'IN';
const LANGUAGE = 'en';

// Bias radius (metres) when a city centre is supplied for an area lookup.
const CITY_BIAS_RADIUS_M = 40000; // ~40km covers a metro + suburbs

function apiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || '';
}

function keyMissing(res) {
  return res.status(503).json({
    error: 'Places lookup is not configured',
    detail: 'GOOGLE_PLACES_API_KEY is not set on the server',
  });
}

/**
 * GET /api/places/autocomplete
 *
 * Query:
 *   input        (required) what the user typed
 *   kind         'city' → only cities · 'area' → localities/regions · else any
 *   lat,lng      optional city centre, biases "area" results to that city
 *   sessionToken optional; groups keystrokes into one billable session
 *
 * Returns: { predictions: [{ placeId, text, mainText, secondaryText, types }] }
 */
router.get('/autocomplete', protect, async (req, res) => {
  const key = apiKey();
  if (!key) return keyMissing(res);

  const { input, kind, lat, lng, sessionToken } = req.query;
  if (!input || String(input).trim().length < 2) {
    return res.json({ predictions: [] }); // too short to be useful
  }

  const body = {
    input: String(input).trim(),
    includedRegionCodes: REGION_CODES,
    languageCode: LANGUAGE,
    regionCode: REGION_CODE,
  };

  // '(cities)' and '(regions)' are Google's special type collections.
  if (kind === 'city') body.includedPrimaryTypes = ['(cities)'];
  else if (kind === 'area') body.includedPrimaryTypes = ['(regions)'];

  // Bias locality results towards the already-chosen city.
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!isNaN(latN) && !isNaN(lngN) && latN !== 0 && lngN !== 0) {
    body.locationBias = {
      circle: { center: { latitude: latN, longitude: lngN }, radius: CITY_BIAS_RADIUS_M },
    };
  }

  if (sessionToken) body.sessionToken = String(sessionToken);

  try {
    const r = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.warn('Places autocomplete failed', { status: r.status, msg: data?.error?.message });
      // Degrade gracefully — the app keeps working with free-text entry.
      return res.json({ predictions: [], error: data?.error?.message || `HTTP ${r.status}` });
    }

    const predictions = (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId: p.placeId,
        text: p.text?.text || '',
        mainText: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secondaryText: p.structuredFormat?.secondaryText?.text || '',
        types: p.types || [],
      }));

    return res.json({ predictions });
  } catch (err) {
    logger.error('Places autocomplete error', { error: err.message });
    return res.json({ predictions: [], error: err.message });
  }
});

/**
 * GET /api/places/details?placeId=...
 *
 * Resolves a prediction into something storable: formatted address, coordinates
 * and the address components we care about (locality / city / state / pincode).
 * Coordinates are what let a posted property show up on the Project map.
 */
router.get('/details', protect, async (req, res) => {
  const key = apiKey();
  if (!key) return keyMissing(res);

  const { placeId, sessionToken } = req.query;
  if (!placeId) return res.status(400).json({ error: 'placeId is required' });

  // places.get REQUIRES an explicit field mask.
  const fields = [
    'id',
    'displayName',
    'formattedAddress',
    'shortFormattedAddress',
    'location',
    'addressComponents',
    'viewport',
    'types',
  ].join(',');

  try {
    const url = `${DETAILS_URL}/${encodeURIComponent(String(placeId))}?languageCode=${LANGUAGE}&regionCode=${REGION_CODE}` +
      (sessionToken ? `&sessionToken=${encodeURIComponent(String(sessionToken))}` : '');

    const r = await fetch(url, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.warn('Places details failed', { status: r.status, msg: data?.error?.message });
      return res.status(502).json({ error: data?.error?.message || `HTTP ${r.status}` });
    }

    // Pull the pieces we store, out of Google's addressComponents array.
    const comp = (type) => {
      const c = (data.addressComponents || []).find((x) => (x.types || []).includes(type));
      return c ? (c.longText || c.shortText || '') : '';
    };

    const locality = comp('locality');
    const sublocality = comp('sublocality') || comp('sublocality_level_1');
    const city = locality || comp('administrative_area_level_3') || comp('administrative_area_level_2');

    return res.json({
      place: {
        placeId: data.id || String(placeId),
        name: data.displayName?.text || '',
        formattedAddress: data.formattedAddress || data.shortFormattedAddress || '',
        latitude: data.location?.latitude ?? null,
        longitude: data.location?.longitude ?? null,
        // Structured pieces — these feed straight into the lead/project record.
        locality: sublocality || locality || '',
        city,
        state: comp('administrative_area_level_1'),
        postalCode: comp('postal_code'),
        country: comp('country'),
        types: data.types || [],
      },
    });
  } catch (err) {
    logger.error('Places details error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

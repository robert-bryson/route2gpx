import { requestJson } from './network.js';

export const MAX_WAYPOINTS = 25;

export function validateRouteRequest({ travelMode, stops = [] }) {
    if (!['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT'].includes(travelMode)) throw new Error('Choose a supported travel mode.');
    if (stops.length > MAX_WAYPOINTS) throw new Error(`Routes support at most ${MAX_WAYPOINTS} waypoints.`);
    if (travelMode === 'TRANSIT' && stops.length) throw new Error('Transit routes do not support intermediate waypoints. Remove the waypoints or choose another mode.');
}

export async function computeRoute(request, { apiKey, signal, parseLocation, fetcher } = {}) {
    validateRouteRequest(request);
    const payload = { origin: parseLocation(request.origin), destination: parseLocation(request.destination), travelMode: request.travelMode, polylineQuality: 'HIGH_QUALITY' };
    if (request.stops.length) payload.intermediates = request.stops.map(parseLocation);
    if (request.travelMode === 'TRANSIT' && request.departureTime) payload.departureTime = request.departureTime;
    const data = await requestJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST', signal, fetcher,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration' },
        body: JSON.stringify(payload),
    });
    const route = data?.routes?.[0];
    if (!route) throw new Error('No route found between these locations. Try different addresses or travel mode.');
    return route;
}

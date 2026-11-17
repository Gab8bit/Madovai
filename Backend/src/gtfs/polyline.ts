/** Google Encoded Polyline Algorithm (precision 5) — port of src/Gtfs/Polyline.php. */

function encodeValue(v: number): string {
  // (v << 1), inverted when negative — done arithmetically so values beyond 2^30 never overflow.
  let x = v < 0 ? -2 * v - 1 : 2 * v;
  let s = '';
  while (x >= 0x20) {
    s += String.fromCharCode((0x20 | (x % 32)) + 63);
    x = Math.floor(x / 32);
  }
  return s + String.fromCharCode(x + 63);
}

/** @param pointsE5 [latE5, lonE5] pairs (degrees * 1e5, rounded integers) */
export function encodePolyline(pointsE5: ReadonlyArray<readonly [number, number]>): string {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  for (const [lat, lon] of pointsE5) {
    out += encodeValue(lat - pLat) + encodeValue(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}

/** Inverse, for tests and clients: [lat, lon] in degrees. */
export function decodePolyline(s: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const n = s.length;
  while (i < n) {
    const d: number[] = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = s.charCodeAt(i++) - 63;
        result += (b & 0x1f) * 2 ** shift;
        shift += 5;
      } while (b >= 0x20 && i < n);
      d.push(result % 2 === 1 ? -(result + 1) / 2 : result / 2);
    }
    lat += d[0];
    lon += d[1];
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}
